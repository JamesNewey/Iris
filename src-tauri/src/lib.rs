// Phase 1 walking skeleton: spawn the Node sidecar, bridge its loopback
// WebSocket to Tauri commands/events. This is throwaway plumbing proving the
// architecture works end to end; Phase 2/3 replace it with the real
// multi-connection sidecar and a properly supervised IPC layer.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

const SIDECAR_PORT: u16 = 8765;

type WsWriter = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;

struct SidecarState {
    writer: Mutex<Option<WsWriter>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    child: Mutex<Option<Child>>,
}

impl SidecarState {
    fn new() -> Self {
        Self {
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            child: Mutex::new(None),
        }
    }
}

async fn send_request(
    state: &SidecarState,
    mut payload: Value,
) -> Result<Value, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    payload["requestId"] = json!(id);

    let (tx, rx) = oneshot::channel();
    state.pending.lock().await.insert(id, tx);

    {
        let mut writer_guard = state.writer.lock().await;
        let writer = writer_guard.as_mut().ok_or("sidecar not connected")?;
        writer
            .send(Message::Text(payload.to_string()))
            .await
            .map_err(|e| format!("failed to send to sidecar: {e}"))?;
    }

    match tokio::time::timeout(Duration::from_secs(15), rx).await {
        Ok(Ok(value)) => {
            if value.get("type").and_then(|t| t.as_str()) == Some("error") {
                let msg = value
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown sidecar error");
                Err(msg.to_string())
            } else {
                Ok(value)
            }
        }
        Ok(Err(_)) => Err("sidecar dropped the request".to_string()),
        Err(_) => Err("sidecar request timed out".to_string()),
    }
}

#[tauri::command]
async fn connect_client(
    state: tauri::State<'_, Arc<SidecarState>>,
    endpoint: String,
) -> Result<Value, String> {
    send_request(&state, json!({ "type": "connect", "endpoint": endpoint })).await
}

#[tauri::command]
async fn start_screencast(
    state: tauri::State<'_, Arc<SidecarState>>,
    session_id: String,
) -> Result<Value, String> {
    send_request(
        &state,
        json!({ "type": "startScreencast", "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
async fn stop_screencast(
    state: tauri::State<'_, Arc<SidecarState>>,
    session_id: String,
) -> Result<Value, String> {
    send_request(
        &state,
        json!({ "type": "stopScreencast", "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
async fn send_click(
    state: tauri::State<'_, Arc<SidecarState>>,
    session_id: String,
    x: f64,
    y: f64,
) -> Result<Value, String> {
    send_request(
        &state,
        json!({ "type": "click", "sessionId": session_id, "x": x, "y": y }),
    )
    .await
}

async fn connect_to_sidecar_with_retry() -> WebSocketStream<MaybeTlsStream<TcpStream>> {
    let url = format!("ws://127.0.0.1:{SIDECAR_PORT}");
    loop {
        match connect_async(&url).await {
            Ok((ws, _)) => return ws,
            Err(_) => tokio::time::sleep(Duration::from_millis(300)).await,
        }
    }
}

fn spawn_sidecar_and_bridge(app: &AppHandle, state: Arc<SidecarState>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Dev-mode path: run the sidecar straight from source via tsx.
        // Phase 2/3 will swap this for a proper bundled sidecar binary.
        let mut cmd = Command::new("../node_modules/.bin/tsx");
        cmd.arg("../sidecar/src/index.ts");
        cmd.kill_on_drop(true);

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("failed to spawn sidecar: {e}");
                return;
            }
        };
        *state.child.lock().await = Some(child);

        let ws = connect_to_sidecar_with_retry().await;
        let (writer, mut reader) = ws.split();
        *state.writer.lock().await = Some(writer);
        let _ = app.emit("sidecar-ready", ());

        while let Some(msg) = reader.next().await {
            let Ok(Message::Text(text)) = msg else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };

            let msg_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if msg_type == "frame" {
                let _ = app.emit("sidecar-frame", &value);
                continue;
            }

            if let Some(request_id) = value.get("requestId").and_then(|v| v.as_u64()) {
                if let Some(tx) = state.pending.lock().await.remove(&request_id) {
                    let _ = tx.send(value);
                    continue;
                }
            }
            let _ = app.emit("sidecar-event", &value);
        }
        let _ = app.emit("sidecar-disconnected", ());
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(SidecarState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state.clone())
        .setup(move |app| {
            spawn_sidecar_and_bridge(app.handle(), state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect_client,
            start_screencast,
            stop_screencast,
            send_click
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Arc<SidecarState>>() {
                    if let Ok(mut guard) = state.child.try_lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.start_kill();
                        }
                    }
                }
            }
        });
}
