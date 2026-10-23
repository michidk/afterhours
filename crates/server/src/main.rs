use afterhours_server::{City, CityStore, Game, city, destruction};
use std::{path::PathBuf, process::Command, sync::Arc};

/// Regenerates the city and its meshes with the current generator, exactly as the Node
/// server does: a separate process, because mesh baking imports the client renderer.
/// `CITY_REGENERATE=0` serves the files already on disk.
fn regenerate(test_world: bool, city: &str, meshes: &str) -> Result<(), String> {
    if std::env::var("CITY_REGENERATE").as_deref() == Ok("0") {
        return Ok(());
    }
    let mut command = Command::new("node");
    command
        .args(["--import", "tsx", "scripts/prepare-city.ts"])
        .env("CITY_PATH", city)
        .env("CITY_MESH_PATH", meshes);
    if test_world {
        command.env("CITY_WORLD", "test");
    }
    let status = command
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
    // `TEST_WORLD=1` serves the hand-built test world with a showroom of every vehicle and item
    // beside the spawn, instead of the generated city (docs/test-world.md).
    let test_world = std::env::var("TEST_WORLD").as_deref() == Ok("1");
    let (city_path, mesh_path) = if test_world {
        ("data/test-world.json", "data/test-world-meshes.msgpack")
    } else {
        ("data/city.json", "data/city-meshes.msgpack")
    };
    let (city_path, mesh_path) = (
        env("CITY_PATH", city_path),
        env("CITY_MESH_PATH", mesh_path),
    );
    regenerate(test_world, &city_path, &mesh_path)?;
    let loaded = City::load(&city_path)?;
    let meshes = city::Meshes::load(&mesh_path)?;
    let store = CityStore::new(&loaded, meshes);
    let world = city::world(&loaded);
    let at = loaded.spawn();
    let spawn = [at[0], loaded.height(at[0], at[1]) + 1.0, at[1]];
    tracing::info!(map = %store.map_id, ?spawn, "city loaded");
    let mut game = Game::new(world, spawn);
    game.set_city(&loaded);
    game.stock(&loaded)?;
    game.add_props(destruction::destructibles(&loaded));
    let pads: Vec<_> = loaded
        .pickups
        .iter()
        .map(|p| (p.x, p.z, p.weapon.clone()))
        .collect();
    game.combat.supplies(&pads, |x, z| loaded.height(x, z));
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
