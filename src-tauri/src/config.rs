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
    // 1. Look for config.json next to the executable, then walk up the tree.
    //    This covers both release builds (exe in target\release\) and dev runs.
    if let Ok(exe_path) = std::env::current_exe() {
        let mut dir = exe_path.parent().map(|p| p.to_path_buf());
        while let Some(ref d) = dir {
            let candidate = d.join("config.json");
            if candidate.exists() {
                return candidate;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }

    // 2. Check the current working directory and its parents.
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = Some(cwd);
        while let Some(ref d) = dir {
            let candidate = d.join("config.json");
            if candidate.exists() {
                return candidate;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }

    // 3. Last resort: relative path in CWD
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
