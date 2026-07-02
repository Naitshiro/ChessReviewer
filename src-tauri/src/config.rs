use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub stockfish_path: String,
    pub engine_threads: u32,
    pub engine_hash_mb: u32,
    pub analysis_depth: u32,
    pub server_host: String,
    pub server_port: u16,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            stockfish_path: "".to_string(),
            engine_threads: 4,
            engine_hash_mb: 2048,
            analysis_depth: 12,
            server_host: "127.0.0.1".to_string(),
            server_port: 8000,
        }
    }
}

pub fn get_config_path() -> PathBuf {
    // Look for config.json next to the executable
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let config_next_to_exe = parent.join("config.json");
            if config_next_to_exe.exists() {
                return config_next_to_exe;
            }
        }
    }
    // Dev fallback: root folder of project
    PathBuf::from("config.json")
}

pub fn load_config() -> AppConfig {
    let path = get_config_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                return config;
            }
        }
    }
    AppConfig::default()
}
