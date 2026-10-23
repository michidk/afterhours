//! The real prepared city loads, streams like the Node server, and holds up a character.
use afterhours_server::city::{City, CityStore, Meshes, routes, world};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use std::sync::Arc;
use tower::ServiceExt;

fn root(rel: &str) -> String {
    format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"))
}

async fn get(app: &axum::Router, path: &str) -> axum::response::Response {
    app.clone()
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn streams_the_prepared_city() {
    let city = City::load(&root("data/city.json")).unwrap();
    let meshes = Meshes::load(&root("data/city-meshes.msgpack")).unwrap();
    let map_id = meshes.map_id.clone();
    let app = routes(Arc::new(CityStore::new(&city, meshes)));

    let res = get(&app, "/city").await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
    let manifest: serde_json::Value =
        serde_json::from_slice(&to_bytes(res.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(manifest["mapId"], map_id);
    assert_eq!(manifest["geometryVersion"], 1);
    assert_eq!(manifest["hasTerrain"], true);
    assert_eq!(manifest["version"], 1);

    let res = get(&app, &format!("/city/chunks/{map_id}/0/0")).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_ENCODING], "gzip");
    let res = get(&app, &format!("/city/geometry/{map_id}/base")).await;
    assert_eq!(res.status(), StatusCode::OK);
    let res = get(&app, &format!("/city/terrain/{map_id}")).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        get(&app, "/city/chunks/nope/0/0").await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        get(&app, "/city/terrain/nope").await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        get(&app, &format!("/city/chunks/{map_id}/9999/9999"))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[test]
fn character_settles_on_the_terrain() {
    let city = City::load(&root("data/city.json")).unwrap();
    let mut w = world(&city);
    let at = city.spawn();
    let ground = city.height(at[0], at[1]);
    w.spawn_character([at[0], ground + 1.0, at[1]]);
    for _ in 0..60 {
        w.step();
    }
    // No vehicles, so the only character row starts the state vector: [id, x, y, z, ..].
    let y = w.states()[2];
    assert!(
        (y - ground).abs() < 2.0,
        "character y={y}, terrain={ground}"
    );
}

/// A rotated building blocks where it is drawn. The footprint frame has local x along
/// `(cos a, sin a)` (`insideBuilding` in the original game and `buildBuilding` in the client);
/// the collider must be turned the opposite way round the y axis, or it is mirrored.
#[test]
fn rotated_buildings_block_where_they_are_drawn() {
    let angle: f32 = 0.7;
    let (w, d) = (40.0_f32, 6.0_f32);
    let city: City = serde_json::from_value(serde_json::json!({
        "seed": 1, "airport": null, "airports": null, "centre": {"x": 0, "z": 0},
        "ramps": null, "racetrack": null, "landmarks": null, "townHall": null,
        "buildings": [{"x": 100.0, "z": 200.0, "asset": "shop-house", "facing": 0, "w": w, "d": d,
            "h": 30.0, "y": 0.0, "angle": angle, "color": "#ccc", "style": 0}],
        "parks": [], "roads": [], "walkways": {"points": [], "links": []},
    }))
    .unwrap();
    let mut w_ = world(&city);
    w_.step(); // builds the collision query index
    // Point at footprint-frame offset (u, v) from the building centre, as the original maps it.
    let at = |u: f32, v: f32| {
        [
            100.0 + u * angle.cos() - v * angle.sin(),
            15.0,
            200.0 + u * angle.sin() + v * angle.cos(),
        ]
    };
    let probe = [0.3, 0.3, 0.3];
    for (u, v) in [(-18.0, 0.0), (18.0, 0.0), (0.0, 1.5), (0.0, -1.5)] {
        assert!(
            !w_.is_clear(at(u, v), probe, 0.0),
            "no wall at footprint offset ({u}, {v}): the collider is not where the building is drawn"
        );
    }
    // The mirrored footprint is open air.
    for (u, v) in [(-18.0, 0.0), (18.0, 0.0)] {
        let [x, y, z] = at(u, v);
        let mirrored = [100.0 + (x - 100.0), y, 200.0 - (z - 200.0)];
        assert!(
            w_.is_clear(mirrored, probe, 0.0),
            "wall at the mirrored spot of ({u}, {v})"
        );
    }
}
