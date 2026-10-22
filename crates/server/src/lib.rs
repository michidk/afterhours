//! HTTP + WebSocket front for the game: `/ws` sessions, `/health`, and the built client
//! from `dist/`. The simulation itself lives in `game.rs` on its own task; the prepared
//! city and its `/city/*` routes live in `city.rs`.
pub mod citizens;
pub mod city;
mod combat;
pub mod destruction;
mod game;
pub mod traffic;
pub mod vehicles;

pub use afterhours_physics::World;
pub use city::{City, CityStore};
pub use game::{Event, Game};

use afterhours_protocol::{ClientMessage, TICK_RATE, VERSION, decode};
use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::mpsc};
use tower_http::services::ServeDir;

#[derive(Clone)]
struct App {
    events: mpsc::UnboundedSender<Event>,
}

/// Runs `game` on its own task and builds the HTTP app around it. `city` is `None` only
/// for tests that bring their own world.
pub fn router(game: Game, city: Option<Arc<CityStore>>, dist: PathBuf) -> Router {
    let (events, mut inbox) = mpsc::unbounded_channel();
    let tick = Arc::new(AtomicU32::new(0));
    let counter = tick.clone();
    let mut game = game;
    if let Some(city) = &city {
        game.map = city.manifest.clone();
    }
    tokio::spawn(async move {
        let mut clock = tokio::time::interval(Duration::from_secs_f64(1.0 / TICK_RATE as f64));
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            clock.tick().await;
            while let Ok(event) = inbox.try_recv() {
                game.handle(event);
            }
            game.step();
            counter.fetch_add(1, Ordering::Relaxed);
        }
    });
    let health = move || async move {
        format!(
            r#"{{"ok":true,"version":{VERSION},"tick":{}}}"#,
            tick.load(Ordering::Relaxed)
        )
    };
    let app = Router::new()
        .route("/ws", get(ws))
        .route("/health", get(health))
        .with_state(App { events });
    match city {
        Some(store) => app.merge(city::routes(store)),
        None => app,
    }
    .fallback_service(ServeDir::new(dist))
}

/// Serves until the listener closes.
pub async fn serve(listener: TcpListener, app: Router) -> std::io::Result<()> {
    axum::serve(listener, app).await
}

async fn ws(upgrade: WebSocketUpgrade, State(app): State<App>) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| session(socket, app.events))
}

async fn session(socket: WebSocket, events: mpsc::UnboundedSender<Event>) {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let (out, mut outbox) = mpsc::unbounded_channel::<Vec<u8>>();
    let _ = events.send(Event::Connect(id, out));
    let writer = tokio::spawn(async move {
        while let Some(bytes) = outbox.recv().await {
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        if let Message::Binary(bytes) = msg {
            match decode::<ClientMessage>(&bytes) {
                Ok(m) => {
                    let _ = events.send(Event::Message(id, m));
                }
                Err(e) => tracing::debug!(id, "bad message: {e}"),
            }
        }
    }
    let _ = events.send(Event::Disconnect(id));
    writer.abort();
}
