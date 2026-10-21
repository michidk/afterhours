use afterhours_server::{City, CityStore, Game, city, destruction};
use std::{path::PathBuf, process::Command, sync::Arc};

/// Regenerates the city and its meshes with the current generator, exactly as the Node
/// server does: a separate process, because mesh baking imports the client renderer.
/// `CITY_REGENERATE=0` serves the files already on disk.
fn regenerate() -> Result<(), String> {
    if std::env::var("CITY_REGENERATE").as_deref() == Ok("0") {
        return Ok(());
    }
    let status = Command::new("node")
        .args(["--import", "tsx", "scripts/prepare-city.ts"])
        .status()
        .map_err(|e| format!("cannot run scripts/prepare-city.ts: {e}"))?;
    status.success().then_some(()).ok_or(format!(
        "City generation failed with {status}; see the log above"
    ))
}

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.into())
}

fn boot() -> Result<(Game, Arc<CityStore>), String> {
    regenerate()?;
    let loaded = City::load(&env("CITY_PATH", "data/city.json"))?;
    let meshes = city::Meshes::load(&env("CITY_MESH_PATH", "data/city-meshes.msgpack"))?;
    let store = CityStore::new(&loaded, meshes);
    let world = city::world(&loaded);
    let at = loaded.spawn();
    let spawn = [at[0], loaded.height(at[0], at[1]) + 1.0, at[1]];
    tracing::info!(map = %store.map_id, ?spawn, "city loaded");
    let mut game = Game::new(world, spawn);
    game.set_city(&loaded);
    game.park(&loaded);
    game.add_props(destruction::destructibles(&loaded));
    Ok((game, Arc::new(store)))
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let (game, store) = boot().map_err(std::io::Error::other)?;
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(5174u16);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("listening on {}", listener.local_addr()?);
    let app = afterhours_server::router(game, Some(store), PathBuf::from("dist"));
    afterhours_server::serve(listener, app).await
}
