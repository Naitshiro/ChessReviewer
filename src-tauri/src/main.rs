#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod analysis;
mod openings;
mod engine;
mod server;

#[tauri::command]
fn get_server_port() -> u16 {
    config::AppConfig::default().server_port
}

#[tokio::main]
async fn main() {
    // 1. Initialize default config settings
    let config = config::AppConfig::default();

    // 2. Spawn the Axum server in the background
    let config_clone = config.clone();
    tokio::spawn(async move {
        server::start_axum_server(config_clone).await;
    });

    // 3. Launch Tauri application window
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_server_port])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
