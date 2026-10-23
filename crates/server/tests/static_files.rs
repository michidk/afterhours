//! The built client is served so that a deploy is picked up on the next page load.
use afterhours_server::{Game, World, router};
use axum::{
    body::Body,
    http::{Request, header},
};
use tower::ServiceExt;

#[tokio::test]
async fn the_page_is_revalidated_and_hashed_assets_are_cached_for_good() {
    let dist = std::env::temp_dir().join(format!("afterhours-dist-{}", std::process::id()));
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("index.html"), "<script src=/assets/main-abc.js>").unwrap();
    std::fs::write(dist.join("assets/main-abc.js"), "1").unwrap();
    let app = router(Game::new(World::new(), [0.0, 1.0, 0.0]), None, dist.clone());
    let cache = |path: &'static str| {
        let app = app.clone();
        async move {
            let res = app
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert!(res.status().is_success(), "{path}: {}", res.status());
            res.headers()[header::CACHE_CONTROL]
                .to_str()
                .unwrap()
                .to_owned()
        }
    };
    assert_eq!(cache("/").await, "no-cache");
    assert_eq!(cache("/index.html").await, "no-cache");
    assert_eq!(
        cache("/assets/main-abc.js").await,
        "public, max-age=31536000, immutable"
    );
    std::fs::remove_dir_all(dist).ok();
}
