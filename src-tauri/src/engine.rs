use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::config::AppConfig;
use shakmaty::Position;


#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WdlInfo {
    pub win: i32,
    pub draw: i32,
    pub loss: i32,
}

impl WdlInfo {
    pub fn flip(&self) -> Self {
        Self {
            win: self.loss,
            draw: self.draw,
            loss: self.win,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UciPvInfo {
    pub multipv: usize,
    pub cp: i32,
    pub mate: Option<i32>,
    pub pv: Vec<String>,
    pub wdl: Option<WdlInfo>,
}

pub struct StockfishProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl StockfishProcess {
    pub async fn spawn(path: &str, threads: u32, hash: u32) -> Result<Self, String> {
        let trimmed_path = path.trim();
        if trimmed_path.is_empty() {
            return Err("Stockfish path is not configured. Please set the Stockfish path in Settings.".to_string());
        }
        let p = std::path::Path::new(trimmed_path);
        if !p.exists() {
            return Err(format!("Stockfish executable not found at: {}", trimmed_path));
        }

        let mut cmd = tokio::process::Command::new(trimmed_path);
        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn Stockfish process ({}): {}", trimmed_path, e))?;

        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("Failed to get stdout")?);

        let mut process = Self { child, stdin, stdout };

        // Initialize UCI
        process.send_command("uci").await?;
        process.read_until("uciok").await?;

        // Configure options
        process.send_command(&format!("setoption name Threads value {}", threads)).await?;
        process.send_command(&format!("setoption name Hash value {}", hash)).await?;
        process.send_command("setoption name MultiPV value 3").await?;
        process.send_command("setoption name UCI_ShowWDL value true").await?;
        process.send_command("isready").await?;
        process.read_until("readyok").await?;

        Ok(process)
    }

    pub async fn send_command(&mut self, cmd: &str) -> Result<(), String> {
        let formatted = format!("{}\n", cmd);
        self.stdin
            .write_all(formatted.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to Stockfish: {}", e))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush Stockfish stdin: {}", e))?;
        Ok(())
    }

    pub async fn read_until(&mut self, expected: &str) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            let bytes = self.stdout.read_line(&mut line).await
                .map_err(|e| format!("Failed to read line from Stockfish: {}", e))?;
            if bytes == 0 {
                return Err("Stockfish process exited unexpectedly".to_string());
            }
            let trimmed = line.trim();
            lines.push(trimmed.to_string());
            if trimmed == expected || trimmed.starts_with(expected) {
                break;
            }
        }
        Ok(lines)
    }

    /// Analyze a position with MultiPV=3 and return one result per PV at the final depth.
    pub async fn analyze_position(&mut self, fen: &str, depth: u32) -> Result<Vec<UciPvInfo>, String> {
        self.send_command("isready").await?;
        self.read_until("readyok").await?;

        // Always ensure MultiPV=3 before batch analysis
        self.send_command("setoption name MultiPV value 3").await?;
        self.send_command(&format!("position fen {}", fen)).await?;
        self.send_command(&format!("go depth {}", depth)).await?;

        let mut pv_map: std::collections::HashMap<usize, UciPvInfo> = std::collections::HashMap::new();
        let mut line = String::new();

        loop {
            line.clear();
            let bytes = self.stdout.read_line(&mut line).await
                .map_err(|e| format!("Failed to read line during analysis: {}", e))?;
            if bytes == 0 {
                return Err("Stockfish process exited during analysis".to_string());
            }
            let trimmed = line.trim();

            if trimmed.starts_with("bestmove") {
                break;
            }

            if trimmed.starts_with("info ") {
                if let Some((multipv, cp, mate, pv, wdl)) = parse_info_line(trimmed) {
                    pv_map.insert(multipv, UciPvInfo { multipv, cp, mate, pv, wdl });
                }
            }
        }

        let mut results: Vec<UciPvInfo> = pv_map.into_values().collect();
        results.sort_by_key(|r| r.multipv);
        Ok(results)
    }

    /// Analyze a position with MultiPV=3 and support early cancellation via oneshot receiver.
    pub async fn analyze_position_cancelable(
        &mut self,
        fen: &str,
        depth: u32,
        mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<Vec<UciPvInfo>, String> {
        self.send_command("isready").await?;
        self.read_until("readyok").await?;

        // Always ensure MultiPV=3 before batch analysis
        self.send_command("setoption name MultiPV value 3").await?;
        self.send_command(&format!("position fen {}", fen)).await?;
        self.send_command(&format!("go depth {}", depth)).await?;

        let mut pv_map: std::collections::HashMap<usize, UciPvInfo> = std::collections::HashMap::new();
        let mut line = String::new();

        loop {
            line.clear();
            tokio::select! {
                _cancel_res = &mut cancel_rx => {
                    // Send stop command to Stockfish
                    let _ = self.send_command("stop").await;
                    // Drain stdout until bestmove to keep engine clean
                    loop {
                        line.clear();
                        let bytes = self.stdout.read_line(&mut line).await.unwrap_or(0);
                        if bytes == 0 || line.trim().starts_with("bestmove") {
                            break;
                        }
                    }
                    return Err("Cancelled".to_string());
                }
                read_res = self.stdout.read_line(&mut line) => {
                    let bytes = read_res.map_err(|e| format!("Failed to read line during analysis: {}", e))?;
                    if bytes == 0 {
                        return Err("Stockfish process exited during analysis".to_string());
                    }
                    let trimmed = line.trim();

                    if trimmed.starts_with("bestmove") {
                        break;
                    }

                    if trimmed.starts_with("info ") {
                        if let Some((multipv, cp, mate, pv, wdl)) = parse_info_line(trimmed) {
                            pv_map.insert(multipv, UciPvInfo { multipv, cp, mate, pv, wdl });
                        }
                    }
                }
            }
        }

        let mut results: Vec<UciPvInfo> = pv_map.into_values().collect();
        results.sort_by_key(|r| r.multipv);
        Ok(results)
    }

    /// Stream analysis info lines, calling the callback for each info update.
    /// Stops when `cancel_rx` fires or `bestmove` is received.
    pub async fn analyze_position_streaming(
        &mut self,
        fen: &str,
        depth: u32,
        mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
        mut on_info: impl FnMut(serde_json::Value),
    ) -> Result<(), String> {
        
        // 1. Stop any ongoing search and ensure Stockfish is ready
        let _ = self.send_command("stop").await;
        self.send_command("isready").await?;
        self.read_until("readyok").await?;

        // 2. Ensure MultiPV is set to 3 for live streaming analysis
        self.send_command("setoption name MultiPV value 3").await?;
        self.send_command("isready").await?;
        self.read_until("readyok").await?;

        // 3. Check if already cancelled before starting the engine command
        match cancel_rx.try_recv() {
            Ok(_) | Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                return Ok(());
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
        }

        self.send_command(&format!("position fen {}", fen)).await?;
        self.send_command(&format!("go depth {}", depth)).await?;

        let mut line = String::new();
        let mut last_info: Option<serde_json::Value> = None;

        loop {
            line.clear();
            tokio::select! {
                _cancel_res = &mut cancel_rx => {
                    // Engine was cancelled
                    let _ = self.send_command("stop").await;
                    let _ = self.send_command("isready").await;
                    let _ = self.read_until("readyok").await;
                    return Ok(());
                }
                read_res = self.stdout.read_line(&mut line) => {
                    let bytes = read_res.map_err(|e| format!("Failed to read line during analysis stream: {}", e))?;
                    if bytes == 0 {
                        eprintln!("[live engine] Stockfish process pipe closed unexpectedly.");
                        break;
                    }
                    
                    let trimmed = line.trim();

                    if trimmed.starts_with("bestmove") {
                        let parts: Vec<&str> = trimmed.split_whitespace().collect();
                        if parts.len() >= 2 && parts[1] != "(none)" {
                            let bm = parts[1].to_string();
                            let (from_sq, to_sq) = if bm.len() >= 4 {
                                (bm[0..2].to_string(), bm[2..4].to_string())
                            } else {
                                (String::new(), String::new())
                            };
                            
                            if let Some(mut info) = last_info.take() {
                                if let Some(pv) = info.get_mut("pv").and_then(|v| v.as_array_mut()) {
                                    if pv.is_empty() {
                                        pv.push(serde_json::json!(bm));
                                        info["from_sq"] = serde_json::json!(from_sq);
                                        info["to_sq"] = serde_json::json!(to_sq);
                                        on_info(info);
                                    }
                                }
                            } else {
                                // Never got any info, send fallback
                                on_info(serde_json::json!({
                                    "multipv": 1,
                                    "depth": 0,
                                    "score_cp": 0,
                                    "score_mate": null,
                                    "pv": [bm],
                                    "from_sq": from_sq,
                                    "to_sq": to_sq,
                                    "wdl": null
                                }));
                            }
                        }
                        break;
                    }

                    if trimmed.starts_with("info ") && trimmed.contains(" score ") {
                        if let Some((multipv, cp, mate, pv, wdl)) = parse_info_line(trimmed) {
                            let depth_val = extract_token(trimmed, "depth")
                                .and_then(|s| s.parse::<u32>().ok())
                                .unwrap_or(0);

                            // Compute from_sq / to_sq from first PV move
                            let (from_sq, to_sq) = if let Some(first) = pv.first() {
                                if first.len() >= 4 {
                                    (first[0..2].to_string(), first[2..4].to_string())
                                } else {
                                    (String::new(), String::new())
                                }
                            } else {
                                (String::new(), String::new())
                            };

                            // score_cp is relative to side to move; convert to white-absolute later
                            let score_cp = if let Some(m) = mate {
                                if m > 0 { 10000 } else { -10000 }
                            } else {
                                cp
                            };

                            let info_json = serde_json::json!({
                                "multipv": multipv,
                                "depth": depth_val,
                                "score_cp": score_cp,
                                "score_mate": mate,
                                "pv": pv,
                                "from_sq": from_sq,
                                "to_sq": to_sq,
                                "wdl": wdl
                            });
                            
                            // Only update last_info for multipv 1
                            if multipv == 1 {
                                last_info = Some(info_json.clone());
                            }
                            
                            on_info(info_json);
                        }
                    }
                }
            }
        }

        Ok(())
    }

    /// Run a quick analysis on a null-move FEN to calculate threats.
    /// Returns top moves from the flipped position.
    pub async fn calculate_threats_analysis(&mut self, null_fen: &str) -> Result<Vec<UciPvInfo>, String> {
        self.send_command("isready").await?;
        self.read_until("readyok").await?;

        self.send_command(&format!("position fen {}", null_fen)).await?;
        // Use movetime 300ms (~0.3s like Python) instead of depth for responsive threats
        self.send_command("go movetime 300 multipv 3").await?;

        let mut pv_map: std::collections::HashMap<usize, UciPvInfo> = std::collections::HashMap::new();
        let mut line = String::new();

        loop {
            line.clear();
            let bytes = self.stdout.read_line(&mut line).await
                .map_err(|e| format!("Failed to read during threat analysis: {}", e))?;
            if bytes == 0 {
                break;
            }
            let trimmed = line.trim();

            if trimmed.starts_with("bestmove") {
                break;
            }

            if trimmed.starts_with("info ") {
                if let Some((multipv, cp, mate, pv, wdl)) = parse_info_line(trimmed) {
                    if !pv.is_empty() {
                        pv_map.insert(multipv, UciPvInfo { multipv, cp, mate, pv, wdl });
                    }
                }
            }
        }

        let mut results: Vec<UciPvInfo> = pv_map.into_values().collect();
        results.sort_by_key(|r| r.multipv);
        Ok(results)
    }

    /// Analyze a position with ELO-limited engine (for play vs engine).
    pub async fn analyze_with_elo(&mut self, fen: &str, elo: i32) -> Result<UciPvInfo, String> {
        let result = self.analyze_with_elo_run(fen, elo).await;
        // Always reset strength limiting and MultiPV after use, even on error
        let _ = self.send_command("setoption name UCI_LimitStrength value false").await;
        let _ = self.send_command("setoption name MultiPV value 3").await;
        result
    }

    async fn analyze_with_elo_run(&mut self, fen: &str, elo: i32) -> Result<UciPvInfo, String> {
        // Clamp ELO to valid range
        let elo = elo.max(800).min(3200);

        // Configure ELO-limited strength
        if elo >= 3200 {
            self.send_command("setoption name UCI_LimitStrength value false").await?;
        } else {
            self.send_command("setoption name UCI_LimitStrength value true").await?;
            // Stockfish UCI_Elo range is typically 1320-3190
            let engine_min = 1320;
            let engine_max = 3190;
            let clamped_elo = elo.max(engine_min).min(engine_max);
            self.send_command(&format!("setoption name UCI_Elo value {}", clamped_elo)).await?;
        }

        // Limit MultiPV to 1 for game play ELO analysis to avoid score pollution
        self.send_command("setoption name MultiPV value 1").await?;

        self.send_command("isready").await?;
        self.read_until("readyok").await?;
        self.send_command(&format!("position fen {}", fen)).await?;

        // Adjust time limit based on ELO gap below minimum (safer limits to prevent crashes)
        let movetime = if elo >= 3200 {
            100
        } else if elo < 1320 {
            let diff = 1320 - elo;
            if diff >= 400 { 50 } else if diff >= 200 { 70 } else { 95 }
        } else {
            100
        };

        self.send_command(&format!("go movetime {}", movetime)).await?;

        let mut best_info = UciPvInfo { multipv: 1, cp: 0, mate: None, pv: vec![], wdl: None };
        let mut line = String::new();

        loop {
            line.clear();
            let bytes = self.stdout.read_line(&mut line).await
                .map_err(|e| format!("Failed to read during ELO analysis: {}", e))?;
            if bytes == 0 {
                break;
            }
            let trimmed = line.trim();

            if trimmed.starts_with("bestmove") {
                // Extract best move from bestmove line
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 2 {
                    best_info.pv = vec![parts[1].to_string()];
                }
                break;
            }

            if trimmed.starts_with("info ") {
                if let Some((_, cp, mate, pv, wdl)) = parse_info_line(trimmed) {
                    best_info.cp = cp;
                    best_info.mate = mate;
                    best_info.wdl = wdl;
                    if !pv.is_empty() {
                        best_info.pv = pv;
                    }
                }
            }
        }

        Ok(best_info)
    }
}

impl Drop for StockfishProcess {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

fn extract_token<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let search = format!("{} ", key);
    let idx = line.find(&search)?;
    let rest = &line[idx + search.len()..];
    rest.split_whitespace().next()
}

pub fn parse_info_line(line: &str) -> Option<(usize, i32, Option<i32>, Vec<String>, Option<WdlInfo>)> {
    // We only care about info lines containing score info
    if !line.contains(" score ") {
        return None;
    }

    // Parse multipv
    let multipv = if let Some(idx) = line.find("multipv ") {
        let part = &line[idx + 8..];
        part.split_whitespace().next()?.parse::<usize>().unwrap_or(1)
    } else {
        1
    };

    // Parse score
    let mut cp = 0;
    let mut mate = None;
    if let Some(idx) = line.find("score ") {
        let parts: Vec<&str> = line[idx + 6..].split_whitespace().collect();
        if parts.len() >= 2 {
            if parts[0] == "cp" {
                cp = parts[1].parse::<i32>().unwrap_or(0);
            } else if parts[0] == "mate" {
                mate = Some(parts[1].parse::<i32>().unwrap_or(0));
                cp = if parts[1].parse::<i32>().unwrap_or(0) > 0 { 10000 } else { -10000 };
            }
        }
    }

    // Parse WDL
    let mut wdl = None;
    if let Some(idx) = line.find(" wdl ") {
        let parts: Vec<&str> = line[idx + 5..].split_whitespace().take(3).collect();
        if parts.len() == 3 {
            if let (Ok(w), Ok(d), Ok(l)) = (parts[0].parse::<i32>(), parts[1].parse::<i32>(), parts[2].parse::<i32>()) {
                wdl = Some(WdlInfo { win: w, draw: d, loss: l });
            }
        }
    }

    // Parse PV moves
    let mut pv = Vec::new();
    if let Some(idx) = line.find(" pv ") {
        let moves_str = &line[idx + 4..];
        pv = moves_str.split_whitespace().map(|s| s.to_string()).collect();
    }

    Some((multipv, cp, mate, pv, wdl))
}

#[derive(Clone)]
pub struct EngineManager {
    inner: Arc<Mutex<Option<StockfishProcess>>>,
    config: Arc<Mutex<AppConfig>>,
    syzygy_path: Arc<Mutex<String>>,
}

impl EngineManager {
    pub fn new(config: AppConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            config: Arc::new(Mutex::new(config)),
            syzygy_path: Arc::new(Mutex::new(String::new())),
        }
    }

    pub async fn update_engine_config(&self, stockfish_path: String, threads: u32, hash_mb: u32) {
        let mut cfg = self.config.lock().await;
        let path_changed = cfg.stockfish_path != stockfish_path;
        let threads_changed = cfg.engine_threads != threads;
        let hash_changed = cfg.engine_hash_mb != hash_mb;

        cfg.stockfish_path = stockfish_path;
        cfg.engine_threads = threads;
        cfg.engine_hash_mb = hash_mb;

        if path_changed || threads_changed || hash_changed {
            let mut lock = self.inner.lock().await;
            if let Some(mut process) = lock.take() {
                let _ = process.send_command("quit").await;
                let _ = process.child.kill().await;
            }
        }
    }

    pub async fn get_config(&self) -> AppConfig {
        self.config.lock().await.clone()
    }

    pub async fn ensure_ready(&self) -> Result<(), String> {
        let mut lock = self.inner.lock().await;
        let needs_spawn = match lock.as_mut() {
            None => true,
            Some(process) => {
                match process.child.try_wait() {
                    Ok(Some(_status)) => true, // Exited, needs spawn
                    Ok(None) => false,        // Still running, all good
                    Err(_) => true,           // Error, respawn just in case
                }
            }
        };

        if needs_spawn {
            let (path, threads, hash) = {
                let cfg = self.config.lock().await;
                (cfg.stockfish_path.clone(), cfg.engine_threads, cfg.engine_hash_mb)
            };

            let mut process = StockfishProcess::spawn(
                &path,
                threads,
                hash,
            ).await?;

            // Check syzygy paths and configure if filled
            let path = self.syzygy_path.lock().await.clone();
            let path_trimmed = path.trim();
            if !path_trimmed.is_empty() {
                let cmd1 = format!("setoption name SyzygyPath value {}", path_trimmed);
                process.send_command(&cmd1).await?;

                let cmd2 = "setoption name SyzygyProbeDepth value 16".to_string();
                process.send_command(&cmd2).await?;

                process.send_command("isready").await?;
                let _ = process.read_until("readyok").await?;
            }

            *lock = Some(process);
        }
        Ok(())
    }

    pub async fn set_syzygy_path(&self, path: String) {
        {
            let mut path_lock = self.syzygy_path.lock().await;
            *path_lock = path.clone();
        }

        let mut lock = self.inner.lock().await;
        if let Some(process) = lock.as_mut() {
            let path_trimmed = path.trim();
            if !path_trimmed.is_empty() {
                let cmd1 = format!("setoption name SyzygyPath value {}", path_trimmed);
                let _ = process.send_command(&cmd1).await;

                let cmd2 = "setoption name SyzygyProbeDepth value 16".to_string();
                let _ = process.send_command(&cmd2).await;

                let _ = process.send_command("isready").await;
                let _ = process.read_until("readyok").await;
            } else {
                let cmd = "setoption name SyzygyPath value <empty>".to_string();
                let _ = process.send_command(&cmd).await;
                let _ = process.send_command("isready").await;
                let _ = process.read_until("readyok").await;
            }
        }
    }



    pub async fn analyze_position(&self, fen: &str, depth: u32) -> Result<Vec<UciPvInfo>, String> {
        self.ensure_ready().await?;
        let mut lock = self.inner.lock().await;
        if let Some(process) = lock.as_mut() {
            process.analyze_position(fen, depth).await
        } else {
            Err("Engine not initialized".to_string())
        }
    }

    pub async fn analyze_position_cancelable(
        &self,
        fen: &str,
        depth: u32,
        cancel_rx: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<Vec<UciPvInfo>, String> {
        self.ensure_ready().await?;
        let mut lock = self.inner.lock().await;
        if let Some(process) = lock.as_mut() {
            process.analyze_position_cancelable(fen, depth, cancel_rx).await
        } else {
            Err("Engine not initialized".to_string())
        }
    }

    pub async fn analyze_with_elo(&self, fen: &str, elo: i32) -> Result<UciPvInfo, String> {
        self.ensure_ready().await?;
        let mut lock = self.inner.lock().await;
        if let Some(process) = lock.as_mut() {
            process.analyze_with_elo(fen, elo).await
        } else {
            Err("Engine not initialized".to_string())
        }
    }

    /// Calculate threats using null-move technique.
    /// Returns list of threat moves with from/to squares and score.
    pub async fn calculate_threats(&self, fen: &str, white_cp: f64) -> Result<Vec<serde_json::Value>, String> {
        self.ensure_ready().await?;

        // Parse FEN to know whose turn it is
        let fen_parts: Vec<&str> = fen.split_whitespace().collect();
        let turn_white = fen_parts.get(1).copied().unwrap_or("w") == "w";

        // Don't compute threats when in check or game over
        if let Ok(pos_fen) = fen.parse::<shakmaty::fen::Fen>() {
            if let Ok(pos) = pos_fen.into_position::<shakmaty::Chess>(shakmaty::CastlingMode::Standard) {
                if pos.is_check() || pos.is_game_over() {
                    return Ok(vec![]);
                }
            }
        }

        // Generate null-move FEN: flip the turn, clear en passant
        let null_fen = generate_null_move_fen(fen);

        // current player's cp
        let current_eval_cp = if turn_white { white_cp } else { -white_cp };

        let mut lock = self.inner.lock().await;
        let results = if let Some(process) = lock.as_mut() {
            process.calculate_threats_analysis(&null_fen).await?
        } else {
            return Err("Engine not initialized".to_string());
        };

        let mut threats = Vec::new();
        for info in &results {
            if let Some(first_move) = info.pv.first() {
                if first_move.len() < 4 {
                    continue;
                }
                let from_sq = &first_move[0..2];
                let to_sq = &first_move[2..4];

                let cp = info.cp as f64;
                let eval_drop = current_eval_cp + cp;

                threats.push(serde_json::json!({
                    "from": from_sq,
                    "to": to_sq,
                    "multipv": info.multipv,
                    "score_cp": cp,
                    "eval_drop": eval_drop,
                }));
            }
        }

        Ok(threats)
    }

    /// Stream analysis — calls `on_info` for every engine depth update.
    pub async fn analyze_position_streaming(
        &self,
        fen: &str,
        depth: u32,
        cancel_rx: tokio::sync::oneshot::Receiver<()>,
        on_info: impl FnMut(serde_json::Value),
    ) -> Result<(), String> {
        self.ensure_ready().await?;
        let mut lock = self.inner.lock().await;
        if let Some(process) = lock.as_mut() {
            process.analyze_position_streaming(fen, depth, cancel_rx, on_info).await
        } else {
            Err("Engine not initialized".to_string())
        }
    }
}

/// Flip the active turn in a FEN string and clear the en passant square.
pub fn generate_null_move_fen(fen: &str) -> String {
    let mut parts: Vec<&str> = fen.split_whitespace().collect();
    if parts.len() < 4 {
        return fen.to_string();
    }
    parts[1] = if parts[1] == "w" { "b" } else { "w" };
    parts[3] = "-";
    parts.join(" ")
}
