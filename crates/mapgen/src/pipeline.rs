//! `mapgen/pipeline.ts`: the native stage order. `stages` adapts each verified stage to the
//! pipeline's calling convention, with the defaults the TypeScript signatures declare.
use crate::types::*;
pub const NATIVE_STAGES_AVAILABLE: bool = true;
pub mod stages {
    use super::*;
    use crate::streetfit::{StreetLayer, StreetPad, TerrainGrid};
    /// Borrowed equivalents of the TypeScript road generation inputs.
    pub struct RoadInputs<'a> {
        pub field: &'a HeightField,
        pub hydro: &'a Hydrology,
        pub desirability: &'a [f32],
        pub centre: Point,
        pub seed: i32,
        pub debug: bool,
    }
    pub type DebugLog<'a> = Option<&'a mut dyn FnMut(&str, f64)>;
    pub type Progress<'a> = Option<&'a mut dyn FnMut(&str)>;
    pub type StreetPolygons = (Vec<Vec<f64>>, Vec<Vec<f64>>);
    pub type StreetLayers<'a> = &'a [(&'a [Vec<f64>], f64)];

    pub fn generate_heightmap(seed: i32, size: f64, cell: f64) -> HeightField {
        crate::terrain::generate_heightmap(seed, size, cell).0
    }
    /// `thermalErosion(f, iterations, talusAngle = 0.6)`.
    pub fn thermal_erosion(f: &mut HeightField, iterations: usize) {
        crate::terrain::thermal_erosion(f, iterations, 0.6)
    }
    pub fn droplet_erosion(f: &mut HeightField, rng: &mut crate::random::Rng, count: usize) {
        crate::terrain::droplet_erosion(f, rng, count)
    }
    /// `settle(f, radius = 1)`.
    pub fn settle(f: &mut HeightField) {
        crate::terrain::settle(f, 1)
    }
    pub fn keep_main_island(f: &mut HeightField) {
        crate::terrain::keep_main_island(f, 0.0)
    }
    pub fn shape_coast(f: &mut HeightField) {
        crate::terrain::shape_coast(f, 0.0)
    }
    /// `shortcut`: the debug timing log is not ported; upgrade if stage timings are needed.
    pub fn generate_hydrology(
        f: &mut HeightField,
        seed: i32,
        sea_level: f64,
        _log: DebugLog<'_>,
    ) -> Hydrology {
        crate::hydrology::generate_hydrology_in_place(f, seed, sea_level)
    }
    pub fn desirability_field(f: &HeightField, hydro: &Hydrology, seed: i32) -> Vec<f32> {
        crate::site::desirability_field(f, hydro, seed)
    }
    pub fn choose_centre(f: &HeightField, desirability: &[f32]) -> Point {
        crate::site::choose_centre(f, desirability)
    }
    pub fn generate_roads(input: &RoadInputs<'_>, progress: Progress<'_>) -> RoadGraph {
        crate::roads::generate_roads(
            &crate::roads::RoadInputs {
                field: input.field.clone(),
                hydro: input.hydro.clone(),
                desirability: input.desirability.to_vec(),
                centre: input.centre,
                seed: input.seed,
                debug: input.debug,
            },
            progress,
        )
    }
    pub fn smooth_centrelines(graph: &mut RoadGraph) {
        crate::roadgeometry::smooth_centrelines(graph)
    }
    pub fn densify_centrelines(graph: &mut RoadGraph) {
        crate::roadgeometry::densify_centrelines(graph)
    }
    pub fn build_road_geometry(graph: &RoadGraph) -> RoadGeometry {
        crate::roadgeometry::build_road_geometry(graph)
    }
    pub fn solve_profiles(graph: &mut RoadGraph, f: &HeightField, trims: &[(f64, f64)]) {
        crate::roadgeometry::solve_profiles(graph, f, trims)
    }
    pub fn stamp_roads(
        f: &mut HeightField,
        graph: &RoadGraph,
        geometry: &RoadGeometry,
    ) -> Vec<f32> {
        crate::roadgeometry::stamp_roads(f, graph, geometry)
    }
    pub fn bridge_decks(graph: &RoadGraph) -> Vec<Bridge> {
        crate::roadgeometry::bridge_decks(graph)
    }
    pub fn street_polygons(graph: &RoadGraph, geometry: &RoadGeometry) -> StreetPolygons {
        crate::streetfit::street_polygons(graph, geometry)
    }
    pub fn sink_under_streets(
        f: &mut HeightField,
        layers: StreetLayers<'_>,
        pads: &[BuildingPlacement],
    ) {
        let mut grid = TerrainGrid {
            heights: std::mem::take(&mut f.data),
            side: f.w,
            step: f.cell,
            half: f.size / 2.0,
        };
        let layers: Vec<StreetLayer> = layers
            .iter()
            .map(|(polygons, top)| StreetLayer {
                polygons: polygons.to_vec(),
                top: *top,
            })
            .collect();
        let pads: Vec<StreetPad> = pads
            .iter()
            .map(|b| StreetPad {
                x: b.x,
                z: b.z,
                w: b.w,
                d: b.d,
                y: Some(b.y),
                angle: Some(b.angle),
            })
            .collect();
        crate::streetfit::sink_under_streets(&mut grid, &layers, &pads);
        f.data = grid.heights;
    }
    pub fn street_test(geometry: &RoadGeometry, margin: f64) -> impl Fn(Point) -> bool + '_ {
        crate::streetfit::street_test(geometry, margin)
    }
}
/// Execute the same stages and mutations as `mapgen/pipeline.ts`.
pub fn generate_map(
    options: MapOptions,
    mut progress: Option<&mut dyn FnMut(&str)>,
) -> GeneratedMap {
    fn stage<T>(
        name: &str,
        progress: &mut Option<&mut dyn FnMut(&str)>,
        timings: &mut Vec<StageTiming>,
        run: impl FnOnce(&mut Option<&mut dyn FnMut(&str)>) -> T,
    ) -> T {
        if let Some(p) = progress.as_mut() {
            p(name);
        }
        let now = std::time::Instant::now();
        let value = run(progress);
        timings.push(StageTiming {
            stage: name.into(),
            ms: now.elapsed().as_secs_f64() * 1000.0,
        });
        value
    }
    let mut timings = Vec::new();
    let seed = options.seed;
    let mut terrain = stage("terrain", &mut progress, &mut timings, |_| {
        stages::generate_heightmap(seed, options.size, options.cell)
    });
    stage("erosion", &mut progress, &mut timings, |_| {
        stages::thermal_erosion(&mut terrain, 10);
        let droplets = crate::random::js_round((terrain.w * terrain.h) as f64 * 0.7) as usize;
        stages::droplet_erosion(
            &mut terrain,
            &mut crate::random::derive(seed, "droplets"),
            droplets,
        );
        stages::thermal_erosion(&mut terrain, 4);
        stages::settle(&mut terrain);
        stages::keep_main_island(&mut terrain);
        stages::shape_coast(&mut terrain);
    });
    let hydro = stage("hydrology", &mut progress, &mut timings, |_| {
        let mut log = |label: &str, ms: f64| eprintln!("    {label} {ms} ms");
        let debug = if options.debug {
            Some(&mut log as &mut dyn FnMut(&str, f64))
        } else {
            None
        };
        stages::generate_hydrology(&mut terrain, seed, 0.0, debug)
    });
    let desirability = stage("site", &mut progress, &mut timings, |_| {
        stages::desirability_field(&terrain, &hydro, seed)
    });
    let centre = stages::choose_centre(&terrain, &desirability);
    let mut roads = stage("roads", &mut progress, &mut timings, |progress| {
        let input = stages::RoadInputs {
            field: &terrain,
            hydro: &hydro,
            desirability: &desirability,
            centre,
            seed,
            debug: options.debug,
        };
        let mut report = |message: &str| {
            if let Some(p) = progress.as_mut() {
                p(&format!("roads: {message}"));
            }
        };
        stages::generate_roads(&input, Some(&mut report))
    });
    let mut shaped = terrain.clone();
    let mut road_cells = Vec::new();
    let geometry = stage("road geometry", &mut progress, &mut timings, |_| {
        stages::smooth_centrelines(&mut roads);
        stages::densify_centrelines(&mut roads);
        let geometry = stages::build_road_geometry(&roads);
        stages::solve_profiles(&mut roads, &terrain, &geometry.trims);
        road_cells = stages::stamp_roads(&mut shaped, &roads, &geometry);
        geometry
    });
    let bridges = stages::bridge_decks(&roads);
    let blocks = stage("blocks", &mut progress, &mut timings, |_| {
        crate::blocks::generate_blocks(&roads, &shaped, &hydro, centre, seed)
    });
    let buildings = stage("buildings", &mut progress, &mut timings, |_| {
        let placed = crate::buildings::place_buildings(&blocks, &shaped, centre, seed);
        crate::buildings::stamp_pads(&mut shaped, &placed, Some(&road_cells));
        placed
    });
    stage("street fit", &mut progress, &mut timings, |_| {
        let (asphalt, sidewalks) = stages::street_polygons(&roads, &geometry);
        stages::sink_under_streets(
            &mut shaped,
            &[(&asphalt, 0.1), (&sidewalks, 0.1 + 0.15)],
            &buildings,
        );
    });
    let parks = crate::vegetation::make_parks(&blocks, &hydro, &shaped);
    let (trees, lamps) = stage("vegetation", &mut progress, &mut timings, |_| {
        let on_street = stages::street_test(&geometry, 0.25);
        crate::vegetation::place_vegetation(
            &shaped,
            &hydro,
            &roads,
            &blocks,
            &buildings,
            &desirability,
            seed,
            on_street,
        )
    });
    GeneratedMap {
        options,
        sea_level: 0.0,
        terrain,
        shaped,
        flow: hydro.flow,
        rivers: hydro.rivers,
        lakes: hydro.lakes,
        desirability,
        centre,
        roads,
        geometry,
        bridges,
        blocks,
        buildings,
        parks,
        trees,
        lamps,
        timings,
    }
}
