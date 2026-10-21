//! The prepared city: `data/city.json` parsed down to what the server needs, the baked
//! mesh artifact, the `/city/*` routes that stream both, and the static physics world.
//! Nothing here generates a city; `scripts/prepare-city.ts` does that in its own process.
use afterhours_physics::World;
use axum::{
    Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};

pub const LIMIT: f32 = 1536.0;
pub const WORLD_LIMIT: f32 = LIMIT + 256.0;
pub const WATER_LEVEL: f32 = -1.1;
pub const TERRAIN_STEP: usize = 8;
pub const TERRAIN_SIDE: usize = (LIMIT as usize * 2) / TERRAIN_STEP + 1;
const CHUNK_SIZE: u32 = 128;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Point {
    pub x: f64,
    pub z: f64,
}

#[derive(Deserialize, Serialize)]
pub struct Road {
    pub ax: f64,
    pub az: f64,
    pub bx: f64,
    pub bz: f64,
    pub width: f64,
}

#[derive(Deserialize, Serialize)]
pub struct Park {
    pub x: f64,
    pub z: f64,
    pub w: Option<f64>,
    pub d: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Deserialize)]
pub struct Building {
    pub x: f32,
    pub z: f32,
    pub w: f32,
    pub d: f32,
    pub h: f32,
    pub y: Option<f32>,
    pub angle: Option<f32>,
}

#[derive(Deserialize)]
struct PackedTerrain {
    /// Little-endian int16 centimetres, base64.
    cm: String,
}

#[derive(Deserialize)]
pub struct City {
    pub seed: i64,
    pub airport: Value,
    pub airports: Value,
    pub centre: Point,
    pub spawn: Option<Point>,
    #[serde(default, deserialize_with = "heights")]
    pub terrain: Option<Vec<f32>>,
    pub water: Option<Value>,
    pub surface: Option<serde::de::IgnoredAny>,
    pub roads: Vec<Road>,
    pub parks: Vec<Park>,
    pub landmarks: Value,
    pub ramps: Value,
    pub racetrack: Value,
    pub buildings: Vec<Building>,
}

fn heights<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Vec<f32>>, D::Error> {
    let Some(packed) = Option::<PackedTerrain>::deserialize(d)? else {
        return Ok(None);
    };
    let bytes = BASE64_STANDARD
        .decode(packed.cm)
        .map_err(serde::de::Error::custom)?;
    let heights: Vec<f32> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| i16::from_le_bytes(*b) as f32 / 100.0)
        .collect();
    if heights.len() != TERRAIN_SIDE * TERRAIN_SIDE {
        return Err(serde::de::Error::custom(format!(
            "terrain has {} samples, expected {}",
            heights.len(),
            TERRAIN_SIDE * TERRAIN_SIDE
        )));
    }
    Ok(Some(heights))
}

impl City {
    /// Reads the `{format, version, city}` artifact.
    pub fn load(path: &str) -> Result<Self, String> {
        #[derive(Deserialize)]
        struct Artifact {
            city: City,
        }
        let text = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        serde_json::from_slice::<Artifact>(&text)
            .map(|a| a.city)
            .map_err(|e| format!("{path}: {e}"))
    }

    /// Spawn point as physics coordinates.
    pub fn spawn(&self) -> [f32; 2] {
        let p = self.spawn.unwrap_or(self.centre);
        [p.x as f32, p.z as f32]
    }

    /// Height of the terrain surface, matching the rendered mesh's triangle diagonal.
    pub fn height(&self, x: f32, z: f32) -> f32 {
        if x.abs() > LIMIT || z.abs() > LIMIT {
            return -12.0;
        }
        let Some(h) = &self.terrain else { return 0.0 };
        let (gx, gz) = (
            (x + LIMIT) / TERRAIN_STEP as f32,
            (z + LIMIT) / TERRAIN_STEP as f32,
        );
        let ix = (gx.floor() as usize).min(TERRAIN_SIDE - 2);
        let iz = (gz.floor() as usize).min(TERRAIN_SIDE - 2);
        let (u, v) = (gx - ix as f32, gz - iz as f32);
        let (i, s) = (iz * TERRAIN_SIDE + ix, TERRAIN_SIDE);
        if u + v <= 1.0 {
            h[i] + u * (h[i + 1] - h[i]) + v * (h[i + s] - h[i])
        } else {
            h[i + s + 1]
                + (1.0 - u) * (h[i + s] - h[i + s + 1])
                + (1.0 - v) * (h[i + 1] - h[i + s + 1])
        }
    }
}

/// The baked mesh artifact: gzip bodies ready to serve as-is.
#[derive(Deserialize)]
pub struct Meshes {
    pub format: String,
    pub version: u32,
    #[serde(rename = "mapId")]
    pub map_id: String,
    pub base: serde_bytes::ByteBuf,
    pub chunks: HashMap<String, serde_bytes::ByteBuf>,
}

impl Meshes {
    pub fn load(path: &str) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|e| {
            format!("Static mesh file missing: {path} ({e}). Run bun run city:prepare first.")
        })?;
        let m: Meshes = rmp_serde::from_slice(&bytes).map_err(|e| format!("{path}: {e}"))?;
        if m.format != "afterhours-meshes" || m.version != 1 {
            return Err(format!(
                "{path}: unknown mesh format {}/{}",
                m.format, m.version
            ));
        }
        Ok(m)
    }
}

/// Everything `/city/*` serves, indexed once at boot.
pub struct CityStore {
    pub manifest: Value,
    pub map_id: String,
    terrain: Option<Vec<u8>>,
    water: Option<Vec<u8>>,
    atlas: Vec<u8>,
    meshes: Meshes,
}

impl CityStore {
    pub fn new(city: &City, meshes: Meshes) -> Self {
        // shortcut: mapId is the mesh artifact's, not sha256 of the JSON like the Node
        // server computes (JSON.stringify key order is not reproducible here); the prepare
        // script bakes both files together each boot so they match. Upgrade if the two
        // files ever ship separately.
        let map_id = meshes.map_id.clone();
        let mut manifest = json!({
            "version": 1,
            "mapId": map_id,
            "seed": city.seed,
            "limit": LIMIT,
            "chunkSize": CHUNK_SIZE,
            "airport": city.airport,
            "airports": city.airports,
            "geometryVersion": 1,
            "centre": city.centre,
        });
        if let Some(spawn) = city.spawn {
            manifest["spawn"] = json!(spawn);
        }
        if city.terrain.is_some() {
            manifest["hasTerrain"] = json!(true);
        }
        if city.surface.is_some() {
            manifest["surface"] = json!(true);
        }
        if city.water.is_some() {
            manifest["hasWater"] = json!(true);
        }
        let atlas = json!({
            "mapId": map_id,
            "roads": city.roads,
            "parks": city.parks,
            "landmarks": city.landmarks,
            "ramps": city.ramps,
            "racetrack": city.racetrack,
        });
        Self {
            manifest,
            map_id,
            terrain: city.terrain.as_ref().map(|h| {
                h.iter()
                    .flat_map(|m| ((m * 100.0).round() as i16).to_le_bytes())
                    .collect()
            }),
            water: city.water.as_ref().map(|w| w.to_string().into_bytes()),
            atlas: atlas.to_string().into_bytes(),
            meshes,
        }
    }
}

type Store = State<Arc<CityStore>>;

fn body(bytes: &[u8], mime: &'static str, gzip: bool) -> Response {
    let mut r = (
        [
            (header::CONTENT_TYPE, mime),
            // No browser-persisted map: geometry lives only in the active client's memory.
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes.to_vec(),
    )
        .into_response();
    if gzip {
        r.headers_mut()
            .insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
    }
    r
}

fn check(store: &CityStore, map_id: &str) -> Result<(), StatusCode> {
    (store.map_id == map_id)
        .then_some(())
        .ok_or(StatusCode::CONFLICT)
}

async fn manifest(State(s): Store) -> Response {
    body(s.manifest.to_string().as_bytes(), "application/json", false)
}

async fn terrain(State(s): Store, Path(id): Path<String>) -> Result<Response, StatusCode> {
    check(&s, &id)?;
    let t = s.terrain.as_ref().ok_or(StatusCode::NOT_FOUND)?;
    Ok(body(t, "application/octet-stream", false))
}

async fn water(State(s): Store, Path(id): Path<String>) -> Result<Response, StatusCode> {
    check(&s, &id)?;
    let w = s.water.as_ref().ok_or(StatusCode::NOT_FOUND)?;
    Ok(body(w, "application/json", false))
}

async fn atlas(State(s): Store, Path(id): Path<String>) -> Result<Response, StatusCode> {
    check(&s, &id)?;
    Ok(body(&s.atlas, "application/json", false))
}

async fn base(State(s): Store, Path(id): Path<String>) -> Result<Response, StatusCode> {
    check(&s, &id)?;
    Ok(body(&s.meshes.base, "application/octet-stream", true))
}

async fn chunk(
    State(s): Store,
    Path((id, x, z)): Path<(String, i32, i32)>,
) -> Result<Response, StatusCode> {
    check(&s, &id)?;
    let c = s
        .meshes
        .chunks
        .get(&format!("{x},{z}"))
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(body(c, "application/octet-stream", true))
}

pub fn routes(store: Arc<CityStore>) -> Router {
    Router::new()
        .route("/city", get(manifest))
        .route("/city/terrain/{id}", get(terrain))
        .route("/city/water/{id}", get(water))
        .route("/city/atlas/{id}", get(atlas))
        .route("/city/geometry/{id}/base", get(base))
        .route("/city/chunks/{id}/{x}/{z}", get(chunk))
        .with_state(store)
}

/// The static colliders `server/destruction.ts` builds: terrain (or a flat ground), the
/// water slab, park slabs, and building boxes. Props are skipped.
pub fn world(city: &City) -> World {
    let mut world = World::new();
    match &city.terrain {
        Some(h) => {
            let s = TERRAIN_SIDE;
            let mut vertices = Vec::with_capacity(s * s * 3);
            let mut indices = Vec::with_capacity((s - 1) * (s - 1) * 6);
            for z in 0..s {
                for x in 0..s {
                    let i = z * s + x;
                    vertices.extend([
                        (x * TERRAIN_STEP) as f32 - LIMIT,
                        h[i],
                        (z * TERRAIN_STEP) as f32 - LIMIT,
                    ]);
                    if x < s - 1 && z < s - 1 {
                        let i = i as u32;
                        let s = s as u32;
                        indices.extend([i, i + s, i + 1, i + 1, i + s, i + s + 1]);
                    }
                }
            }
            world
                .add_trimesh(&vertices, &indices)
                .expect("terrain grid is a valid mesh");
        }
        None => world.add_box([0.0, -0.1, 0.0], [LIMIT, 0.1, LIMIT], 0.0),
    }
    world.add_box(
        [0.0, WATER_LEVEL - 0.4, 0.0],
        [WORLD_LIMIT, 0.1, WORLD_LIMIT],
        0.0,
    );
    for p in &city.parks {
        world.add_box(
            [p.x as f32, 0.2, p.z as f32],
            [
                p.w.unwrap_or(38.0) as f32 / 2.0,
                0.2,
                p.d.unwrap_or(38.0) as f32 / 2.0,
            ],
            0.0,
        );
    }
    for b in &city.buildings {
        let y = b.y.unwrap_or(0.0);
        world.add_box(
            [b.x, (y + b.h) / 2.0, b.z],
            [b.w / 2.0, (b.h - y) / 2.0, b.d / 2.0],
            b.angle.unwrap_or(0.0),
        );
    }
    world
}
