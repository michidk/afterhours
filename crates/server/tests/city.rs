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
