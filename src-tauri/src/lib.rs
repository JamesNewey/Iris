// Bridges Tauri commands/events to the Node sidecar's loopback WebSocket.
// Rust owns the sidecar's process lifecycle: spawn on start, restart with
// backoff if it dies unexpectedly, and kill its whole process group (not
// just the immediate child) on app exit.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
const MAX_BACKOFF_MS: u64 = 15_000;

type WsWriter = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;

struct SidecarState {
    writer: Mutex<Option<WsWriter>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    child: Mutex<Option<Child>>,
    shutting_down: AtomicBool,
}

impl SidecarState {
    fn new() -> Self {
        Self {
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            child: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
        }
    }
}

async fn send_request(state: &SidecarState, mut payload: Value) -> Result<Value, String> {
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

macro_rules! sidecar_command {
    ($name:ident, $wire_type:literal $(, $arg:ident : $ty:ty => $key:literal)* $(,)?) => {
        #[tauri::command]
        async fn $name(
            state: tauri::State<'_, Arc<SidecarState>>,
            $($arg: $ty),*
        ) -> Result<Value, String> {
            send_request(&state, json!({ "type": $wire_type $(, $key: $arg)* })).await
        }
    };
}

#[tauri::command]
async fn add_connection(
    state: tauri::State<'_, Arc<SidecarState>>,
    name: String,
    endpoint: String,
    token: Option<String>,
) -> Result<Value, String> {
    let mut payload = json!({ "type": "addConnection", "name": name, "endpoint": endpoint });
    if let Some(t) = token {
        payload["token"] = json!(t);
    }
    send_request(&state, payload).await
}
sidecar_command!(remove_connection, "removeConnection", connection_id: String => "connectionId");
sidecar_command!(list_sessions, "listSessions", connection_id: String => "connectionId");
sidecar_command!(navigate, "navigate", connection_id: String => "connectionId", session_id: String => "sessionId", url: String => "url");
sidecar_command!(reload_session, "reload", connection_id: String => "connectionId", session_id: String => "sessionId");
sidecar_command!(go_back, "goBack", connection_id: String => "connectionId", session_id: String => "sessionId");
sidecar_command!(go_forward, "goForward", connection_id: String => "connectionId", session_id: String => "sessionId");
sidecar_command!(close_session, "closeSession", connection_id: String => "connectionId", session_id: String => "sessionId");
sidecar_command!(take_control, "takeControl", connection_id: String => "connectionId", session_id: String => "sessionId");
sidecar_command!(release_control, "releaseControl", connection_id: String => "connectionId", session_id: String => "sessionId");
sidecar_command!(start_screencast, "startScreencast", connection_id: String => "connectionId", session_id: String => "sessionId");
sidecar_command!(stop_screencast, "stopScreencast", connection_id: String => "connectionId", session_id: String => "sessionId");
sidecar_command!(stop_thumbnail, "stopThumbnail", connection_id: String => "connectionId", session_id: String => "sessionId");
sidecar_command!(send_key, "key", connection_id: String => "connectionId", session_id: String => "sessionId", text: String => "text");

#[tauri::command]
async fn start_thumbnail(
    state: tauri::State<'_, Arc<SidecarState>>,
    connection_id: String,
    session_id: String,
) -> Result<Value, String> {
    send_request(
        &state,
        json!({ "type": "startThumbnail", "connectionId": connection_id, "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
async fn send_click(
    state: tauri::State<'_, Arc<SidecarState>>,
    connection_id: String,
    session_id: String,
    x: f64,
    y: f64,
) -> Result<Value, String> {
    send_request(
        &state,
        json!({ "type": "click", "connectionId": connection_id, "sessionId": session_id, "x": x, "y": y }),
    )
    .await
}

enum ConnectOutcome {
    Connected(WebSocketStream<MaybeTlsStream<TcpStream>>),
    ProcessExited(String),
    ShuttingDown,
}

/// Polls for the sidecar's WS server to come up, bailing out early (instead
/// of retrying forever) if the process exits before ever accepting a
/// connection.
async fn connect_to_sidecar_with_retry(state: &SidecarState, child: &mut Child) -> ConnectOutcome {
    let url = format!("ws://127.0.0.1:{SIDECAR_PORT}");
    loop {
        if state.shutting_down.load(Ordering::SeqCst) {
            return ConnectOutcome::ShuttingDown;
        }
        if let Ok(Some(status)) = child.try_wait() {
            return ConnectOutcome::ProcessExited(format!("{status:?}"));
        }
        match connect_async(&url).await {
            Ok((ws, _)) => return ConnectOutcome::Connected(ws),
            Err(_) => tokio::time::sleep(Duration::from_millis(300)).await,
        }
    }
}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: u32) {}

/// Spawns the sidecar, bridges its WS traffic, and returns once the
/// connection ends (crash, deliberate shutdown, or spawn failure).
async fn run_sidecar_once(app: &AppHandle, state: &Arc<SidecarState>) -> Result<(), String> {
    let mut cmd = Command::new("../node_modules/.bin/tsx");
    cmd.arg("../sidecar/src/index.ts");
    cmd.kill_on_drop(true);
    // Put the sidecar (and anything it forks, e.g. tsx's own node child) in
    // its own process group so we can kill the whole tree on exit instead of
    // just the immediate PID, which otherwise leaves orphans holding the WS
    // port open across restarts.
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn sidecar: {e}"))?;
    let pid = child.id();

    let ws = match connect_to_sidecar_with_retry(state, &mut child).await {
        ConnectOutcome::Connected(ws) => ws,
        ConnectOutcome::ProcessExited(status) => {
            let msg = format!("sidecar exited before becoming ready: {status}");
            let _ = app.emit("sidecar-event", json!({ "type": "sidecarCrashed", "error": msg }));
            return Err(msg);
        }
        ConnectOutcome::ShuttingDown => {
            if let Some(pid) = pid {
                kill_process_group(pid);
            }
            return Ok(());
        }
    };

    *state.child.lock().await = Some(child);
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
        if msg_type == "thumbnail" {
            let _ = app.emit("sidecar-thumbnail", &value);
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

    *state.writer.lock().await = None;
    let mut pending = state.pending.lock().await;
    for (_, tx) in pending.drain() {
        let _ = tx.send(json!({ "type": "error", "error": "sidecar disconnected" }));
    }
    drop(pending);
    let _ = app.emit("sidecar-disconnected", ());
    Ok(())
}

fn spawn_sidecar_supervisor(app: &AppHandle, state: Arc<SidecarState>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut backoff_ms = 500u64;
        loop {
            if state.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            let result = run_sidecar_once(&app, &state).await;
            if state.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            if result.is_ok() {
                // Clean-ish disconnect (sidecar's WS loop ended); still worth
                // a short backoff so a persistently failing sidecar doesn't
                // spin-loop the CPU.
                backoff_ms = 500;
            }
            let _ = app.emit(
                "sidecar-event",
                json!({ "type": "sidecarRestarting", "delayMs": backoff_ms }),
            );
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(MAX_BACKOFF_MS);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(SidecarState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(state.clone())
        .setup(move |app| {
            spawn_sidecar_supervisor(app.handle(), state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_connection,
            remove_connection,
            list_sessions,
            navigate,
            reload_session,
            go_back,
            go_forward,
            close_session,
            take_control,
            release_control,
            start_screencast,
            stop_screencast,
            start_thumbnail,
            stop_thumbnail,
            send_click,
            send_key,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Arc<SidecarState>>() {
                    state.shutting_down.store(true, Ordering::SeqCst);
                    if let Ok(mut guard) = state.child.try_lock() {
                        if let Some(child) = guard.take() {
                            if let Some(pid) = child.id() {
                                kill_process_group(pid);
                            }
                        }
                    }
                }
            }
        });
}
