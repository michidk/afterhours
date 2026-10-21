//! HTTP + WebSocket front for the game: `/ws` sessions, `/health`, and the built client
//! from `dist/`. The simulation itself lives in `game.rs` on its own task.
mod game;

use afterhours_protocol::{ClientMessage, TICK_RATE, decode};
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
use game::{Event, Game};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};
use tokio::{net::TcpListener, sync::mpsc};
use tower_http::services::ServeDir;

#[derive(Clone)]
struct App {
    events: mpsc::UnboundedSender<Event>,
}

/// Runs the simulation and serves until the listener closes.
pub async fn serve(listener: TcpListener, dist: PathBuf) -> std::io::Result<()> {
    let (events, mut inbox) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut game = Game::new();
        let mut clock = tokio::time::interval(Duration::from_secs_f64(1.0 / TICK_RATE as f64));
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            clock.tick().await;
            while let Ok(event) = inbox.try_recv() {
                game.handle(event);
            }
            game.step();
        }
    });
    let app = Router::new()
        .route("/ws", get(ws))
        .route("/health", get(|| async { r#"{"ok":true}"# }))
        .fallback_service(ServeDir::new(dist))
        .with_state(App { events });
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
