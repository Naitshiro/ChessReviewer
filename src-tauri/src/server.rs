use axum::{
    extract::{State, Query, ws::{WebSocket, WebSocketUpgrade, Message}},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use futures_util::{SinkExt, StreamExt};
use tower_http::cors::{Any, CorsLayer};
use shakmaty::{Chess, Position, Role, Square, Color};
use shakmaty::san::San;
use rand::{seq::SliceRandom, Rng};

use crate::config::AppConfig;
use crate::engine::EngineManager;

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub engine: EngineManager,
}

#[derive(Deserialize)]
pub struct SyzygySettingsRequest {
    pub syzygy_path: String,
}

#[derive(Deserialize)]
pub struct EngineSettingsRequest {
    pub stockfish_path: Option<String>,
    pub engine_threads: Option<u32>,
    pub engine_hash_mb: Option<u32>,
}

#[derive(Deserialize)]
pub struct TheoryRequest {
    pub sans: Vec<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct ClassifyRequest {
    pub fen_before: String,
    pub move_uci: String,
    pub best_move_uci: Option<String>,
    pub cp_best: f64,
    pub cp_second: f64,
    pub cp_played: f64,
    pub mate_best: Option<i32>,
    pub mate_second: Option<i32>,
    pub mate_played: Option<i32>,
    pub is_book: bool,
    #[serde(default)]
    pub is_recapture: bool,
    pub wdl_best: Option<crate::engine::WdlInfo>,
    pub wdl_second: Option<crate::engine::WdlInfo>,
    pub wdl_played: Option<crate::engine::WdlInfo>,
}

#[derive(Deserialize)]
pub struct ThreatRequest {
    pub fen: String,
    pub current_eval_cp: f64,
}

#[derive(Deserialize)]
pub struct AnalyzeRequest {
    pub pgn: String,
    pub depth: Option<u32>,
}

#[derive(Deserialize)]
pub struct ExplorerRequest {
    pub fen: Option<String>,
    pub moves: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct EngineMoveRequest {
    pub fen: String,
    pub elo: i32,
}

pub struct ParsedGame {
    pub headers: std::collections::HashMap<String, String>,
    pub moves: Vec<serde_json::Value>,
    pub fens: Vec<String>,
}

fn find_legal_move_permissive(pos: &shakmaty::Chess, raw_san: &str) -> Option<shakmaty::Move> {
    // 1. Try standard strict parsing first (for perfect PGNs)
    if let Ok(san) = raw_san.parse::<shakmaty::san::San>() {
        if let Ok(mv) = san.to_move(pos) {
            return Some(mv);
        }
    }

    // 2. Strict parsing failed -> Normalize the input string for loose matching
    // Remove checks (+), checkmates (#), capture markers (x, X), promotion symbols (=), and parens
    let clean_input = raw_san
        .replace(['+', '#', 'x', 'X', '=', '(', ')'], "")
        .replace('0', "O") // Normalize standard vs letter castling typos
        .replace('o', "O")
        .trim()
        .to_string();

    // 3. Scan all legal moves calculated by the engine for this turn
    for mv in pos.legal_moves() {
        let legal_san_str = shakmaty::san::San::from_move(pos, &mv).to_string();
        let clean_legal = legal_san_str
            .replace(['+', '#', 'x', 'X', '=', '(', ')'], "")
            .replace('0', "O")
            .replace('o', "O")
            .trim()
            .to_string();

        // Check if our sanitized strings match (e.g., "Be7" matching "Be7")
        if clean_input == clean_legal {
            return Some(mv);
        }

        // 4. Advanced Fallback: Handle short file-to-file pawn captures (e.g., "ed" instead of "exd4")
        if clean_input.len() == 2 {
            if let (Some(from_char), Some(to_char)) = (clean_input.chars().nth(0), clean_input.chars().nth(1)) {
                if let (Some(from_file), Some(to_file)) = (shakmaty::File::from_char(from_char), shakmaty::File::from_char(to_char)) {
                    if mv.is_capture() && mv.role() == shakmaty::Role::Pawn {
                        if let Some(from_sq) = mv.from() {
                            if from_sq.file() == from_file && mv.to().file() == to_file {
                                return Some(mv);
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

// ---------------------------------------------------------------------------
// PGN Parsing Utility
// ---------------------------------------------------------------------------
pub fn parse_pgn(pgn: &str) -> Result<ParsedGame, String> {
    let mut raw_fen_line = None;
    for line in pgn.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('[') && !trimmed.is_empty() {
            if let Ok(_) = trimmed.parse::<shakmaty::fen::Fen>() {
                raw_fen_line = Some(trimmed.to_string());
                break;
            }
        }
    }

    let mut headers = std::collections::HashMap::new();
    let mut moves_sans = Vec::new();
    let mut nags_per_move: Vec<Vec<i32>> = Vec::new();
    let mut clks_per_move: Vec<Option<String>> = Vec::new();

    let mut in_curly = false;
    let mut in_paren = 0i32;
    let mut cur_comment = String::new();

    for line in pgn.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if let Some(quote_start) = trimmed.find('"') {
                if let Some(quote_end) = trimmed.rfind('"') {
                    let key = trimmed[1..quote_start].trim();
                    let val = &trimmed[quote_start + 1..quote_end];
                    headers.insert(key.to_string(), val.to_string());
                }
            }
        } else if !trimmed.is_empty() {
            if let Some(ref rfl) = raw_fen_line {
                if trimmed == rfl {
                    continue;
                }
            }
            // Strip comments in curly braces or parentheses, but extract NAGs and clk annotations
            let mut clean_line = String::new();

            for c in trimmed.chars() {
                if c == '{' {
                    in_curly = true;
                    cur_comment.clear();
                } else if c == '}' {
                    in_curly = false;
                    // Extract %clk from the comment
                    let clk = extract_clk_from_comment(&cur_comment);
                    // Associate with next move index (will be done after parsing)
                    clks_per_move.push(clk);
                    cur_comment.clear();
                } else if c == '(' {
                    in_paren += 1;
                } else if c == ')' {
                    in_paren -= 1;
                } else if in_curly {
                    cur_comment.push(c);
                } else if in_paren <= 0 {
                    clean_line.push(c);
                }
            }

            for token in clean_line.split_whitespace() {
                if token.contains('.') {
                    continue;
                }
                if token == "1-0" || token == "0-1" || token == "1/2-1/2" || token == "*" {
                    continue;
                }
                // NAG tokens ($N)
                if token.starts_with('$') {
                    if let Ok(nag) = token[1..].parse::<i32>() {
                        if let Some(last) = nags_per_move.last_mut() {
                            last.push(nag);
                        }
                    }
                    continue;
                }
                moves_sans.push(token.to_string());
                nags_per_move.push(Vec::new());
            }
        }
    }

    // Align clks to moves: clks_per_move contains one entry per `}` comment,
    // which should correspond 1:1 to moves in order.
    // We pad/trim to length of moves_sans.
    while clks_per_move.len() < moves_sans.len() {
        clks_per_move.push(None);
    }

    let mut pos = if let Some(ref rfl) = raw_fen_line {
        let fen = rfl.parse::<shakmaty::fen::Fen>()
            .map_err(|e| format!("Failed to parse raw FEN line: {}", e))?;
        fen.into_position::<Chess>(shakmaty::CastlingMode::Standard)
            .map_err(|e| format!("Invalid chess position from raw FEN: {}", e))?
    } else if let Some(fen_str) = headers.get("FEN").or_else(|| headers.get("fen")).or_else(|| headers.get("Fen")) {
        let fen = fen_str.parse::<shakmaty::fen::Fen>()
            .map_err(|e| format!("Failed to parse FEN header: {}", e))?;
        fen.into_position::<Chess>(shakmaty::CastlingMode::Standard)
            .map_err(|e| format!("Invalid chess position from FEN header: {}", e))?
    } else {
        Chess::default()
    };
    let initial_fen = shakmaty::fen::Fen::from_position(pos.clone(), shakmaty::EnPassantMode::Always).to_string();
    let mut fens = vec![initial_fen];
    let mut move_records = Vec::new();
    let mut last_opening = "".to_string();

    for (i, san_str) in moves_sans.iter().enumerate() {
        let mv = match find_legal_move_permissive(&pos, san_str) {
            Some(m) => m,
            None => return Err(format!("Illegal or unparseable move sequence: {} at step {}", san_str, i + 1)),
        };

        let fen_before = shakmaty::fen::Fen::from_position(pos.clone(), shakmaty::EnPassantMode::Always).to_string();
        let color = if pos.turn().is_white() { "white" } else { "black" };
        let move_number = pos.fullmoves().get();

        // Calculate material to determine game phase
        let mut non_pawn_material = 0;
        let board = pos.board();
        for col in &[Color::White, Color::Black] {
            let color_bb = board.by_color(*col);
            non_pawn_material += (board.knights() & color_bb).count() as i32 * 320;
            non_pawn_material += (board.bishops() & color_bb).count() as i32 * 330;
            non_pawn_material += (board.rooks() & color_bb).count() as i32 * 500;
            non_pawn_material += (board.queens() & color_bb).count() as i32 * 900;
        }

        let book = crate::openings::is_book_sequence(&moves_sans[0..=i]);

        let white_queens = (board.queens() & board.by_color(Color::White)).count();
        let black_queens = (board.queens() & board.by_color(Color::Black)).count();
        let total_queens = white_queens + black_queens;

        let phase = if book || move_number <= 10 {
            "opening"
        } else if (total_queens == 0 && non_pawn_material <= 2600) || (total_queens > 0 && non_pawn_material <= 1600) {
            "endgame"
        } else {
            "middlegame"
        };

        let book = crate::openings::is_book_sequence(&moves_sans[0..=i]);
        let sacrificed = crate::analysis::is_sacrifice(&pos, &mv, None);
        let uci = shakmaty::uci::Uci::from_move(&mv, shakmaty::CastlingMode::Standard).to_string();

        let nags = nags_per_move.get(i).cloned().unwrap_or_default();
        let clk = clks_per_move.get(i).cloned().flatten();

        pos = pos.play(&mv).map_err(|e| format!("Error playing move: {} ({})", san_str, e))?;

        let fen_after = shakmaty::fen::Fen::from_position(pos.clone(), shakmaty::EnPassantMode::Always).to_string();
        fens.push(fen_after.clone());

        let mut opening_name = crate::openings::get_opening_name(&fen_after).unwrap_or_else(|| "".to_string());
        if opening_name.is_empty() {
            opening_name = last_opening.clone();
        } else {
            last_opening = opening_name.clone();
        }

        move_records.push(serde_json::json!({
            "index": i,
            "move_number": move_number,
            "color": color,
            "san": san_str,
            "uci": uci,
            "fen_before": fen_before,
            "fen_after": fen_after,
            "phase": phase,
            "is_book": book,
            "is_sacrifice": sacrificed,
            "opening": opening_name,
            "nags": nags,
            "clk": clk,
            "move_time": serde_json::Value::Null,
            "cp_best": serde_json::Value::Null,
            "cp_played": serde_json::Value::Null,
            "score_mate": serde_json::Value::Null,
            "white_cp": 0,
            "white_win_prob": 0.5,
            "white_win": 0.33,
            "black_win": 0.33,
            "draw_prob": 0.34,
            "p_best": serde_json::Value::Null,
            "p_played": serde_json::Value::Null,
            "delta": 0,
            "classification": serde_json::Value::Null,
            "best_move": serde_json::Value::Null,
            "top_moves": serde_json::json!([]),
        }));
    }

    // --- Calculate and populate move times spent ---
    let has_real_clocks = move_records.iter().any(|m| m["clk"].is_string());
    let tc_str = headers.get("TimeControl").map(|s| s.as_str()).unwrap_or("");
    let (initial_time, increment) = parse_time_control(tc_str);

    let mut all_clocks = Vec::new();
    for m in &move_records {
        if let Some(clk_str) = m["clk"].as_str() {
            if let Some(sec) = parse_clock_to_seconds(clk_str) {
                all_clocks.push(sec);
            }
        }
    }

    let computed_initial_time = if !all_clocks.is_empty() && initial_time == 0.0 {
        all_clocks.iter().copied().fold(f64::NEG_INFINITY, f64::max)
    } else {
        initial_time
    };

    let mut white_prev_clock = if computed_initial_time > 0.0 { Some(computed_initial_time) } else { None };
    let mut black_prev_clock = if computed_initial_time > 0.0 { Some(computed_initial_time) } else { None };

    let mut move_times: Vec<Option<String>> = Vec::new();
    for (_i, m) in move_records.iter().enumerate() {
        let color = m["color"].as_str().unwrap_or("white");
        let clk_str = m["clk"].as_str();
        let mut time_spent_str = None;

        if has_real_clocks {
            if let Some(clk_val_str) = clk_str {
                if let Some(clk_val) = parse_clock_to_seconds(clk_val_str) {
                    if color == "white" {
                        if white_prev_clock.is_none() {
                            white_prev_clock = Some(clk_val);
                        }
                        if let Some(prev) = white_prev_clock {
                            let diff = (prev - clk_val + increment).max(0.0);
                            time_spent_str = Some(format_time_spent(diff));
                        }
                        white_prev_clock = Some(clk_val);
                    } else {
                        if black_prev_clock.is_none() {
                            black_prev_clock = Some(clk_val);
                        }
                        if let Some(prev) = black_prev_clock {
                            let diff = (prev - clk_val + increment).max(0.0);
                            time_spent_str = Some(format_time_spent(diff));
                        }
                        black_prev_clock = Some(clk_val);
                    }
                }
            }
        } else {
            time_spent_str = None;
        }

        move_times.push(time_spent_str);
    }

    for (i, m) in move_records.iter_mut().enumerate() {
        if let Some(ref t) = move_times[i] {
            m["move_time"] = serde_json::json!(t);
        }
    }

    Ok(ParsedGame {
        headers,
        moves: move_records,
        fens,
    })
}

/// Extract [%clk h:mm:ss] or [%clk m:ss] from a PGN comment string.
fn extract_clk_from_comment(comment: &str) -> Option<String> {
    let prefix = "%clk ";
    if let Some(idx) = comment.find(prefix) {
        let rest = &comment[idx + prefix.len()..];
        let time_str = rest.split_whitespace().next()?;
        // Remove trailing ']' if present
        let time_str = time_str.trim_end_matches(']');
        if !time_str.is_empty() {
            return Some(time_str.to_string());
        }
    }
    None
}

fn parse_clock_to_seconds(clk_str: &str) -> Option<f64> {
    let parts: Vec<&str> = clk_str.split(':').collect();
    if parts.len() == 3 {
        let h = parts[0].parse::<f64>().ok()?;
        let m = parts[1].parse::<f64>().ok()?;
        let s = parts[2].parse::<f64>().ok()?;
        Some(h * 3600.0 + m * 60.0 + s)
    } else if parts.len() == 2 {
        let m = parts[0].parse::<f64>().ok()?;
        let s = parts[1].parse::<f64>().ok()?;
        Some(m * 60.0 + s)
    } else if parts.len() == 1 {
        parts[0].parse::<f64>().ok()
    } else {
        None
    }
}

fn parse_time_control(tc_str: &str) -> (f64, f64) {
    let mut initial_time = 0.0;
    let mut increment = 0.0;
    if !tc_str.is_empty() {
        let parts: Vec<&str> = tc_str.split('+').collect();
        if let Some(&first) = parts.first() {
            if let Ok(t) = first.parse::<f64>() {
                initial_time = t;
            }
        }
        if parts.len() > 1 {
            if let Ok(inc) = parts[1].parse::<f64>() {
                increment = inc;
            }
        }
    }
    (initial_time, increment)
}

fn format_time_spent(diff: f64) -> String {
    if diff < 60.0 {
        format!("{:.1}s", diff)
    } else {
        format!("{}m {:.1}s", (diff / 60.0) as i32, diff % 60.0)
    }
}

// ---------------------------------------------------------------------------
// HTTP Handlers
// ---------------------------------------------------------------------------
async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    let (engine_ready, err_msg) = match state.engine.ensure_ready().await {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e)),
    };
    let cfg = state.engine.get_config().await;
    Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "authors": env!("CARGO_PKG_AUTHORS"),
        "engine": {
            "ready": engine_ready,
            "error": err_msg,
            "threads": cfg.engine_threads,
            "hash": cfg.engine_hash_mb,
            "depth": cfg.analysis_depth,
            "path": cfg.stockfish_path
        }
    }))
}

async fn check_theory_handler(Json(req): Json<TheoryRequest>) -> impl IntoResponse {
    let is_theory = crate::openings::is_book_sequence(&req.sans);

    // Play the moves to get the final FEN and look up the opening name
    let mut pos = Chess::default();
    let mut last_opening = "".to_string();

    for san_str in &req.sans {
        if let Some(mv) = find_legal_move_permissive(&pos, san_str) {
            pos = match pos.play(&mv) {
                Ok(p) => p,
                Err(_) => break,
            };
            let fen_after = shakmaty::fen::Fen::from_position(pos.clone(), shakmaty::EnPassantMode::Always).to_string();
            if let Some(name) = crate::openings::get_opening_name(&fen_after) {
                last_opening = name;
            }
        } else {
            break;
        }
    }

    Json(serde_json::json!({
        "is_theory": is_theory,
        "opening": last_opening,
    }))
}

async fn classify_handler(Json(req): Json<ClassifyRequest>) -> impl IntoResponse {
    // Parse the move as UCI (from/to squares), not SAN
    let sacrificed = if req.move_uci.len() >= 4 {
        match req.fen_before.parse::<shakmaty::fen::Fen>() {
            Ok(fen) => {
                match fen.into_position::<Chess>(shakmaty::CastlingMode::Standard) {
                    Ok(pos) => {
                        let from_sq = Square::from_ascii(req.move_uci[0..2].as_bytes()).ok();
                        let to_sq = Square::from_ascii(req.move_uci[2..4].as_bytes()).ok();
                        let promo = if req.move_uci.len() == 5 {
                            match req.move_uci.chars().nth(4) {
                                Some('q') => Some(Role::Queen),
                                Some('r') => Some(Role::Rook),
                                Some('b') => Some(Role::Bishop),
                                Some('n') => Some(Role::Knight),
                                _ => None,
                            }
                        } else {
                            None
                        };
                        if let (Some(from), Some(to)) = (from_sq, to_sq) {
                            // Find the matching legal move
                            let resolved = pos.legal_moves().into_iter()
                                .find(|m| m.from() == Some(from) && m.to() == to && m.promotion() == promo);
                            if let Some(m) = resolved {
                                crate::analysis::is_sacrifice(&pos, &m, req.mate_played)
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    }
                    _ => false,
                }
            }
            _ => false,
        }
    } else {
        false
    };

    let is_engine_top_choice = req.best_move_uci.as_ref().map(|b| b == &req.move_uci).unwrap_or(false);
    let p_best = crate::analysis::win_prob(req.cp_best);
    let p_second_best = crate::analysis::win_prob(req.cp_second);
    let p_played = crate::analysis::win_prob(req.cp_played);
    let delta = (p_best - p_played).max(0.0);

    let classification = crate::analysis::classify_move(
        delta,
        p_best,
        p_second_best,
        p_played,
        sacrificed,
        req.is_book,
        req.cp_best,
        req.cp_second,
        req.cp_played,
        req.mate_best,
        req.mate_second,
        req.mate_played,
        is_engine_top_choice,
        req.is_recapture,
    );

    Json(serde_json::json!({ "classification": classification }))
}

async fn threats_handler(State(state): State<AppState>, Json(req): Json<ThreatRequest>) -> impl IntoResponse {
    match state.engine.calculate_threats(&req.fen, req.current_eval_cp).await {
        Ok(threats) => Json(serde_json::json!({ "threats": threats })).into_response(),
        Err(_) => {
            Json(serde_json::json!({ "threats": [] })).into_response()
        }
    }
}

async fn import_handler(Json(req): Json<AnalyzeRequest>) -> Response {
    match parse_pgn(&req.pgn) {
        Ok(game) => {
            // Build accuracy report with null classifications (no analysis done yet)
            let accuracy = crate::analysis::build_accuracy_report(&game.moves);

            let metadata = serde_json::json!({
                "white": game.headers.get("White").cloned().unwrap_or_else(|| "White".to_string()),
                "black": game.headers.get("Black").cloned().unwrap_or_else(|| "Black".to_string()),
                "white_elo": game.headers.get("WhiteElo").cloned().unwrap_or_else(|| "".to_string()),
                "black_elo": game.headers.get("BlackElo").cloned().unwrap_or_else(|| "".to_string()),
                "white_title": game.headers.get("WhiteTitle").cloned().unwrap_or_else(|| "".to_string()),
                "black_title": game.headers.get("BlackTitle").cloned().unwrap_or_else(|| "".to_string()),
                "event": game.headers.get("Event").cloned().unwrap_or_else(|| "".to_string()),
                "date": game.headers.get("Date").cloned().unwrap_or_else(|| "".to_string()),
                "result": game.headers.get("Result").cloned().unwrap_or_else(|| "*".to_string()),
                "time_control": game.headers.get("TimeControl").cloned().unwrap_or_else(|| "".to_string()),
                "termination": game.headers.get("Termination").cloned().unwrap_or_else(|| "".to_string()),
                "depth_used": 0,
            });

            Json(serde_json::json!({
                "metadata": metadata,
                "initial_fen": game.fens.first().cloned().unwrap_or_else(|| "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string()),
                "moves": game.moves,
                "accuracy": accuracy,
            })).into_response()
        }
        Err(e) => (
            axum::http::StatusCode::BAD_REQUEST, 
            Json(serde_json::json!({ "detail": e }))
        ).into_response(),
    }
}

async fn openings_list_handler() -> impl IntoResponse {
    let list_json = include_str!("openings.json");
    let val: serde_json::Value = serde_json::from_str(list_json).unwrap_or(serde_json::Value::Null);
    Json(val)
}

async fn openings_explorer_handler(Json(req): Json<ExplorerRequest>) -> Response {
    let fen_result = if let Some(ref f) = req.fen {
        Ok(f.clone())
    } else if let Some(ref mv_seq) = req.moves {
        let mut pos = Chess::default();
        let mut ok = true;
        for m in mv_seq {
            if let Ok(mv) = m.parse::<San>() {
                if let Ok(resolved) = mv.to_move(&pos) {
                    if let Ok(next) = pos.clone().play(&resolved) {
                        pos = next;
                        continue;
                    }
                }
            }
            ok = false;
            break;
        }
        if ok {
            Ok(shakmaty::fen::Fen::from_position(pos.clone(), shakmaty::EnPassantMode::Always).to_string())
        } else {
            Err("Invalid moves".to_string())
        }
    } else {
        Ok("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string())
    };

    let fen = match fen_result {
        Ok(f) => f,
        Err(e) => return (axum::http::StatusCode::BAD_REQUEST, e).into_response(),
    };

    // Fetch from Lichess Opening Explorer
    let url = format!("https://explorer.lichess.ovh/masters?fen={}", urlencoding::encode(&fen));
    if let Ok(res) = reqwest::get(&url).await {
        if let Ok(data) = res.json::<serde_json::Value>().await {
            return Json(data).into_response();
        }
    }
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch from Lichess").into_response()
}

async fn curated_puzzles_handler() -> impl IntoResponse {
    let puzzles_json = include_str!("puzzles.json");
    let val: serde_json::Value = serde_json::from_str(puzzles_json).unwrap_or(serde_json::Value::Null);
    Json(val)
}

async fn daily_puzzle_handler() -> Response {
    let url = "https://lichess.org/api/puzzle/daily";
    let client = reqwest::Client::new();
    if let Ok(res) = client.get(url).header("User-Agent", "ChessReviewer/1.0.0").send().await {
        if let Ok(data) = res.json::<serde_json::Value>().await {
            let puzzle_data = &data["puzzle"];
            let initial_fen = puzzle_data["initialFen"].as_str().unwrap_or("");
            let solution = &puzzle_data["solution"];
            let rating = puzzle_data["rating"].as_i64().unwrap_or(1500);
            let theme = data["game"]["perf"]["name"].as_str().unwrap_or("Tactics");
            let puzzle_id = puzzle_data["id"].as_str().unwrap_or("daily");

            let player_color = if let Ok(fen) = initial_fen.parse::<shakmaty::fen::Fen>() {
                if let Ok(pos) = fen.into_position::<Chess>(shakmaty::CastlingMode::Standard) {
                    if pos.turn().is_white() { "black" } else { "white" }
                } else {
                    "white"
                }
            } else {
                "white"
            };

            return Json(serde_json::json!({
                "id": format!("lichess_{}", puzzle_id),
                "title": format!("Lichess Daily Puzzle ({})", puzzle_id),
                "description": format!("Find the winning line. Play as {}.", if player_color == "white" { "White" } else { "Black" }),
                "rating": rating,
                "theme": theme,
                "initialFen": initial_fen,
                "solution": solution,
                "player_color": player_color
            })).into_response();
        }
    }

    // Fallback to random puzzle from local curated list
    let puzzles_json = include_str!("puzzles.json");
    if let Ok(puzzles) = serde_json::from_str::<Vec<serde_json::Value>>(puzzles_json) {
        if !puzzles.is_empty() {
            let mut rng = rand::thread_rng();
            if let Some(p) = puzzles.choose(&mut rng) {
                return Json(p.clone()).into_response();
            }
        }
    }

    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "Failed to load puzzle").into_response()
}

async fn update_syzygy_handler(
    State(state): State<AppState>,
    Json(req): Json<SyzygySettingsRequest>,
) -> Response {
    state.engine.set_syzygy_path(req.syzygy_path).await;
    Json(serde_json::json!({ "status": "ok" })).into_response()
}

async fn update_engine_handler(
    State(state): State<AppState>,
    Json(req): Json<EngineSettingsRequest>,
) -> Response {
    let current_cfg = state.engine.get_config().await;
    let path = req.stockfish_path.unwrap_or(current_cfg.stockfish_path);
    let threads = req.engine_threads.unwrap_or(current_cfg.engine_threads);
    let hash_mb = req.engine_hash_mb.unwrap_or(current_cfg.engine_hash_mb);

    state.engine.update_engine_config(path, threads, hash_mb).await;
    Json(serde_json::json!({ "status": "ok" })).into_response()
}

async fn engine_move_handler(State(state): State<AppState>, Json(req): Json<EngineMoveRequest>) -> Response {
    if let Ok(fen) = req.fen.parse::<shakmaty::fen::Fen>() {
        if let Ok(pos) = fen.into_position::<Chess>(shakmaty::CastlingMode::Standard) {
            if pos.is_game_over() {
                return Json(serde_json::json!({
                    "best_move": null,
                    "san": null,
                    "fen_after": req.fen,
                    "game_over": true
                })).into_response();
            }

            if state.engine.ensure_ready().await.is_err() {
                return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "Engine not ready").into_response();
            }

            // Blunder rate: ELO 800 -> ~30%, ELO 1000 -> ~18%, ELO 1200 -> ~7%, >= 1320 -> 0%
            let play_random = if req.elo < 1320 {
                let diff = (1320 - req.elo).max(0);
                let blunder_prob = ((diff as f64) / 1700.0).max(0.0).min(0.5);
                blunder_prob > 0.0 && rand::thread_rng().gen::<f64>() < blunder_prob
            } else {
                false
            };

            let mut engine_move = None;

            if !play_random {
                if let Ok(top_choice) = state.engine.analyze_with_elo(&req.fen, req.elo).await {
                    if let Some(best_move_str) = top_choice.pv.first() {
                        if best_move_str.len() >= 4 {
                            let from_sq = Square::from_ascii(best_move_str[0..2].as_bytes()).ok();
                            let to_sq = Square::from_ascii(best_move_str[2..4].as_bytes()).ok();

                            if let (Some(from), Some(to)) = (from_sq, to_sq) {
                                // Find matching legal move (handles promotions)
                                let promo = if best_move_str.len() == 5 {
                                    match best_move_str.chars().nth(4) {
                                        Some('q') => Some(Role::Queen),
                                        Some('r') => Some(Role::Rook),
                                        Some('b') => Some(Role::Bishop),
                                        Some('n') => Some(Role::Knight),
                                        _ => None,
                                    }
                                } else {
                                    None
                                };

                                let resolved_move = pos.legal_moves().into_iter()
                                    .find(|m| m.from() == Some(from) && m.to() == to
                                        && m.promotion() == promo);

                                if let Some(m) = resolved_move {
                                    engine_move = Some(m);
                                }
                            }
                        }
                    }
                }
            }

            // Fallback/forced random move selection if engine failed or blunder triggered
            let m = match engine_move {
                Some(mv) => mv,
                None => {
                    let legal_moves = pos.legal_moves();
                    if legal_moves.is_empty() {
                        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "No legal moves available").into_response();
                    }
                    let mut rng = rand::thread_rng();
                    legal_moves.choose(&mut rng).cloned().unwrap()
                }
            };

            let san = San::from_move(&pos, &m).to_string();
            let next_pos = pos.clone().play(&m).unwrap();
            let new_fen = shakmaty::fen::Fen::from_position(next_pos.clone(), shakmaty::EnPassantMode::Always).to_string();

            return Json(serde_json::json!({
                "best_move": shakmaty::uci::Uci::from_move(&m, shakmaty::CastlingMode::Standard).to_string(),
                "san": san,
                "fen_after": new_fen,
                "game_over": next_pos.is_game_over()
            })).into_response();
        }
    }
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "Engine error").into_response()
}

// ---------------------------------------------------------------------------
// Chess.com Profile Games Import
// ---------------------------------------------------------------------------
fn get_archive_label(url: &str) -> String {
    let parts: Vec<&str> = url.split('/').collect();
    if parts.len() >= 2 {
        let year = parts[parts.len() - 2];
        let month = parts[parts.len() - 1];
        let month_name = match month {
            "01" => "Jan",
            "02" => "Feb",
            "03" => "Mar",
            "04" => "Apr",
            "05" => "May",
            "06" => "Jun",
            "07" => "Jul",
            "08" => "Aug",
            "09" => "Sep",
            "10" => "Oct",
            "11" => "Nov",
            "12" => "Dec",
            _ => month,
        };
        format!("{} {}", month_name, year)
    } else {
        url.to_string()
    }
}

async fn chesscom_games_handler(
    Query(params): Query<std::collections::HashMap<String, String>>
) -> Response {
    let username = match params.get("username") {
        Some(u) => u.trim().to_string(),
        None => return (axum::http::StatusCode::BAD_REQUEST, "Missing username").into_response(),
    };

    let client = reqwest::Client::new();
    let user_agent = "ChessReviewer/1.0 (https://github.com/Naitshiro/ChessReviewer)";

    // 1. Fetch archives
    let url_archives = format!("https://api.chess.com/pub/player/{}/games/archives", username);
    let res = match client.get(&url_archives).header("User-Agent", user_agent).send().await {
        Ok(r) => r,
        Err(e) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to fetch archives: {}", e)).into_response(),
    };

    if res.status() == 404 {
        return (axum::http::StatusCode::NOT_FOUND, format!("Chess.com user '{}' not found.", username)).into_response();
    }

    let data = match res.json::<serde_json::Value>().await {
        Ok(d) => d,
        Err(e) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to parse archives: {}", e)).into_response(),
    };

    let archives = match data["archives"].as_array() {
        Some(a) if !a.is_empty() => a.clone(),
        _ => return Json(serde_json::json!({ "status": "ok", "games": [] })).into_response(),
    };

    // Determine which archive to fetch:
    // If the query contains "archive", use that one. Otherwise use the last one (latest).
    let target_archive_url = match params.get("archive") {
        Some(url) if !url.trim().is_empty() => url.trim().to_string(),
        _ => archives.last().unwrap().as_str().unwrap_or("").to_string(),
    };

    if target_archive_url.is_empty() {
        return Json(serde_json::json!({ "status": "ok", "games": [] })).into_response();
    }

    // 2. Fetch games from archive
    let res_games = match client.get(&target_archive_url).header("User-Agent", user_agent).send().await {
        Ok(r) => r,
        Err(e) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to fetch games: {}", e)).into_response(),
    };

    let games_data = match res_games.json::<serde_json::Value>().await {
        Ok(d) => d,
        Err(e) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to parse games: {}", e)).into_response(),
    };

    let games_list = match games_data["games"].as_array() {
        Some(g) => g.clone(),
        None => return Json(serde_json::json!({ "status": "ok", "games": [] })).into_response(),
    };

    let mut recent_games = Vec::new();
    for g in games_list.iter().rev() {
        let white = &g["white"];
        let black = &g["black"];

        recent_games.push(serde_json::json!({
            "url": g["url"],
            "pgn": g["pgn"],
            "time_class": g["time_class"],
            "time_control": g["time_control"],
            "rated": g["rated"],
            "end_time": g["end_time"],
            "white": {
                "username": white["username"],
                "rating": white["rating"],
                "result": white["result"]
            },
            "black": {
                "username": black["username"],
                "rating": black["rating"],
                "result": black["result"]
            }
        }));
    }

    // Convert archives to format with labels, newest first
    let mut mapped_archives = Vec::new();
    for a in archives.iter().rev() {
        if let Some(url) = a.as_str() {
            let label = get_archive_label(url);
            mapped_archives.push(serde_json::json!({
                "label": label,
                "url": url
            }));
        }
    }

    Json(serde_json::json!({
        "status": "ok",
        "games": recent_games,
        "archives": mapped_archives,
        "selected_archive": target_archive_url
    })).into_response()
}

// ---------------------------------------------------------------------------
// Batch Analyze NDJSON Stream Handler
// ---------------------------------------------------------------------------
async fn analyze_handler(State(state): State<AppState>, Json(req): Json<AnalyzeRequest>) -> Response {
    let parsed = match parse_pgn(&req.pgn) {
        Ok(game) => game,
        Err(e) => return (
            axum::http::StatusCode::BAD_REQUEST, 
            Json(serde_json::json!({ "detail": e }))
        ).into_response(),
    };

    let depth = req.depth.unwrap_or(state.config.analysis_depth);
    let (tx, rx) = mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(100);

    tokio::spawn(async move {
        let total = parsed.fens.len();
        let mut engine_scores: Vec<serde_json::Value> = Vec::new();

        // --- Phase 1: Analyze every FEN position ---
        for (i, fen_str) in parsed.fens.iter().enumerate() {
            if tx.send(Ok(bytes::Bytes::from(
                format!("{{\"type\": \"progress\", \"current\": {}, \"total\": {}}}\n", i + 1, total)
            ))).await.is_err() {
                break;
            }

            let pos = match fen_str.parse::<shakmaty::fen::Fen>() {
                Ok(f) => f.into_position::<Chess>(shakmaty::CastlingMode::Standard).unwrap_or(Chess::default()),
                _ => Chess::default(),
            };

            if pos.is_game_over() {
                // Checkmate: relative cp = -10000 (loser's turn, they are mated)
                // Draw: relative cp = 0
                let rel_cp = if pos.is_checkmate() { -10000 } else { 0 };
                let mate_val: Option<i32> = if pos.is_checkmate() { Some(0) } else { None };
                let terminal_wdl = if pos.is_checkmate() {
                    serde_json::json!({"win": 0, "draw": 0, "loss": 1000})
                } else {
                    serde_json::json!({"win": 0, "draw": 1000, "loss": 0})
                };
                engine_scores.push(serde_json::json!({
                    "fen": fen_str,
                    "relative_cp": rel_cp,
                    "score_mate": mate_val,
                    "pv1": null, "pv2": null, "pv3": null,
                    "pv1_full": null, "pv2_full": null, "pv3_full": null,
                    "cp1": rel_cp, "cp2": rel_cp, "cp3": rel_cp,
                    "mate1": mate_val, "mate2": null, "mate3": null,
                    "wdl1": terminal_wdl, "wdl2": null, "wdl3": null,
                    "relative_wdl": terminal_wdl,
                }));
                continue;
            }

            if tx.is_closed() {
                break;
            }

            let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
            let tx_clone = tx.clone();
            tokio::spawn(async move {
                tx_clone.closed().await;
                let _ = cancel_tx.send(());
            });

            match state.engine.analyze_position_cancelable(fen_str, depth, cancel_rx).await {
                Ok(pv_list) => {
                    let mut score_entry = serde_json::json!({
                        "fen": fen_str,
                        "relative_cp": 0,
                        "score_mate": null,
                        "pv1": null, "pv2": null, "pv3": null,
                        "cp1": null, "cp2": null, "cp3": null,
                        "mate1": null, "mate2": null, "mate3": null,
                        "wdl1": null, "wdl2": null, "wdl3": null,
                        "relative_wdl": null,
                    });

                    for (idx, info) in pv_list.iter().take(3).enumerate() {
                        // cp is relative to the side to move (as returned by Stockfish)
                        let cp_val = if let Some(m) = info.mate {
                            if m > 0 { 10000.0 - (m as f64) * 10.0 } else { -10000.0 - (m as f64) * 10.0 }
                        } else {
                            info.cp as f64
                        };

                        let abs_mate = info.mate.map(|m| {
                            let turn_white = pos.turn().is_white();
                            if turn_white { m } else { -m }
                        });

                        let key_pv = format!("pv{}", idx + 1);
                        let key_cp = format!("cp{}", idx + 1);
                        let key_mate = format!("mate{}", idx + 1);
                        let key_wdl = format!("wdl{}", idx + 1);

                        // Store the first move UCI of the PV
                        let first_pv_uci = info.pv.first().cloned().unwrap_or_default();
                        score_entry[&key_pv] = serde_json::json!(first_pv_uci);
                        score_entry[&format!("{}_full", key_pv)] = serde_json::json!(info.pv);
                        score_entry[&key_cp] = serde_json::json!(cp_val);
                        score_entry[&key_mate] = serde_json::json!(abs_mate);
                        score_entry[&key_wdl] = serde_json::json!(info.wdl);

                        if idx == 0 {
                            score_entry["relative_cp"] = serde_json::json!(cp_val);
                            score_entry["score_mate"] = serde_json::json!(abs_mate);
                            score_entry["relative_wdl"] = serde_json::json!(info.wdl);
                        }
                    }
                    engine_scores.push(score_entry);
                }
                Err(e) => {
                    if e == "Cancelled" {
                        break;
                    }
                    engine_scores.push(serde_json::json!({
                        "fen": fen_str,
                        "relative_cp": 0,
                        "score_mate": null,
                        "pv1": null, "pv2": null, "pv3": null,
                        "pv1_full": null, "pv2_full": null, "pv3_full": null,
                        "cp1": 0.0, "cp2": -0.01, "cp3": -0.02,
                        "mate1": null, "mate2": null, "mate3": null,
                        "wdl1": null, "wdl2": null, "wdl3": null,
                        "relative_wdl": null,
                    }));
                }
            }

        }

        if engine_scores.len() < total {
            return;
        }

        // --- Phase 2: Compute move records with correct scores ---
        let mut final_moves = Vec::new();
        let mut brilliant_theory_found = false;
        let mut last_opening = "".to_string();
        let mut last_uci: Option<String> = None;

        for (i, mut m_val) in parsed.moves.into_iter().enumerate() {
            let fen_before = m_val["fen_before"].as_str().unwrap_or("").to_string();
            let fen_after = m_val["fen_after"].as_str().unwrap_or("").to_string();
            let uci = m_val["uci"].as_str().unwrap_or("").to_string();
            let color = m_val["color"].as_str().unwrap_or("white").to_string();

            if i + 1 >= engine_scores.len() {
                final_moves.push(m_val);
                last_uci = Some(uci);
                continue;
            }

            let score_before = &engine_scores[i];
            let score_after = &engine_scores[i + 1];

            // cp_best: best move centipawn from position before (relative to side to move)
            let cp_best = score_before["cp1"].as_f64().unwrap_or(0.0);
            let cp_second = score_before["cp2"].as_f64().unwrap_or(cp_best);

            // cp_played: NEGATE the relative score of the position AFTER the move
            // because the score_after is from the opponent's perspective
            let cp_after_relative = score_after["relative_cp"].as_f64().unwrap_or(0.0);
            let cp_played = -cp_after_relative;

            // Helper to parse WDL from JSON
            let _parse_wdl = |v: &serde_json::Value| -> Option<crate::engine::WdlInfo> {
                serde_json::from_value(v.clone()).ok()
            };

            let wdl_after = _parse_wdl(&score_after["relative_wdl"]);

            // Win probabilities from current player's perspective
            let p_best = crate::analysis::win_prob(cp_best);
            let p_played = crate::analysis::win_prob(cp_played);
            let p_second_best = crate::analysis::win_prob(cp_second);
            let delta = (p_best - p_played).max(0.0);

            // Check if the played move was the engine's top choice
            let is_engine_top_choice = score_before["pv1"].as_str()
                .map(|pv1| pv1 == uci)
                .unwrap_or(false);

            // Convert mate scores from White's absolute perspective to the active player's perspective
            let player_white = color == "white";
            let mate_best = score_before["score_mate"].as_i64().map(|m| {
                if player_white { m as i32 } else { -m as i32 }
            });
            let mate_second = score_before["mate2"].as_i64().map(|m| {
                if player_white { m as i32 } else { -m as i32 }
            });
            let mate_played = score_after["score_mate"].as_i64().map(|m| {
                if player_white { m as i32 } else { -m as i32 }
            });

            // Sacrifice detection with mate info
            let pos_before = match fen_before.parse::<shakmaty::fen::Fen>() {
                Ok(f) => f.into_position::<Chess>(shakmaty::CastlingMode::Standard).unwrap_or(Chess::default()),
                _ => Chess::default(),
            };
            let resolved_move = if uci.len() >= 4 {
                let from_sq = Square::from_ascii(uci[0..2].as_bytes()).ok();
                let to_sq = Square::from_ascii(uci[2..4].as_bytes()).ok();
                let promo = if uci.len() == 5 {
                    match uci.chars().nth(4) {
                        Some('q') => Some(Role::Queen),
                        Some('r') => Some(Role::Rook),
                        Some('b') => Some(Role::Bishop),
                        Some('n') => Some(Role::Knight),
                        _ => None,
                    }
                } else {
                    None
                };
                if let (Some(from), Some(to)) = (from_sq, to_sq) {
                    pos_before.legal_moves().into_iter()
                        .find(|m| m.from() == Some(from) && m.to() == to && m.promotion() == promo)
                } else {
                    None
                }
            } else {
                None
            };

            let sacrificed = if let Some(ref m) = resolved_move {
                crate::analysis::is_sacrifice(&pos_before, m, mate_played)
            } else {
                false
            };

            // Stop marking book moves after a brilliant theory move
            let is_book = if brilliant_theory_found {
                false
            } else {
                m_val["is_book"].as_bool().unwrap_or(false)
            };

            let is_recapture = if let Some(ref prev_uci) = last_uci {
                if prev_uci.len() >= 4 && uci.len() >= 4 {
                    prev_uci[2..4] == uci[2..4]
                } else {
                    false
                }
            } else {
                false
            };
            last_uci = Some(uci.clone());

            let classification = crate::analysis::classify_move(
                delta,
                p_best,
                p_second_best,
                p_played,
                sacrificed,
                is_book,
                cp_best,
                cp_second,
                cp_played,
                mate_best,
                mate_second,
                mate_played,
                is_engine_top_choice,
                is_recapture,
            );

            // Track brilliant theory
            if classification == "brilliant" && is_book {
                brilliant_theory_found = true;
            }

            // Compute White's absolute centipawn for eval bar/graph
            // post_relative is from the opponent's perspective → negate if White is to move next
            let next_pos = match fen_after.parse::<shakmaty::fen::Fen>() {
                Ok(f) => f.into_position::<Chess>(shakmaty::CastlingMode::Standard).unwrap_or(Chess::default()),
                _ => Chess::default(),
            };
            let board_after_turn = next_pos.turn();
            let white_cp = if board_after_turn.is_white() {
                cp_after_relative
            } else {
                -cp_after_relative
            };
            let white_win_prob = crate::analysis::white_win_prob_from_values(
                wdl_after.as_ref(),
                white_cp,
                board_after_turn.is_white(),
            );

            // Opening name
            let mut opening_name = crate::openings::get_opening_name(&fen_after).unwrap_or_else(|| "".to_string());
            if opening_name.is_empty() {
                opening_name = last_opening.clone();
            } else {
                last_opening = opening_name.clone();
            }

            // Build top_moves list (first UCI of each PV)
            let top_moves: Vec<String> = ["pv1", "pv2", "pv3"]
                .iter()
                .filter_map(|k| score_before[k].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string()))
                .collect();

            // best_move is the first move of PV1
            let best_move = score_before["pv1"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());

            // Populate all expected fields
            let (w_win, b_win, w_draw) = match wdl_after.as_ref() {
                Some(w) => {
                    if board_after_turn.is_white() {
                        (w.win as f64 / 1000.0, w.loss as f64 / 1000.0, w.draw as f64 / 1000.0)
                    } else {
                        (w.loss as f64 / 1000.0, w.win as f64 / 1000.0, w.draw as f64 / 1000.0)
                    }
                }
                None => {
                    let p = white_win_prob;
                    let d = 0.5 * (1.0 - (2.0 * p - 1.0).abs());
                    let w = p - 0.5 * d;
                    let b = 1.0 - p - 0.5 * d;
                    (w, b, d)
                }
            };

            m_val["cp_best"] = serde_json::json!((cp_best * 100.0).round() / 100.0);
            m_val["cp_played"] = serde_json::json!((cp_played * 100.0).round() / 100.0);
            m_val["score_mate"] = score_after["score_mate"].clone();
            m_val["white_cp"] = serde_json::json!((white_cp * 100.0).round() / 100.0);
            m_val["white_win_prob"] = serde_json::json!((white_win_prob * 10000.0).round() / 10000.0);
            m_val["white_win"] = serde_json::json!((w_win * 10000.0).round() / 10000.0);
            m_val["black_win"] = serde_json::json!((b_win * 10000.0).round() / 10000.0);
            m_val["draw_prob"] = serde_json::json!((w_draw * 10000.0).round() / 10000.0);
            m_val["p_best"] = serde_json::json!((p_best * 10000.0).round() / 10000.0);
            m_val["p_played"] = serde_json::json!((p_played * 10000.0).round() / 10000.0);
            m_val["delta"] = serde_json::json!((delta * 10000.0).round() / 10000.0);
            m_val["classification"] = serde_json::json!(classification);
            m_val["best_move"] = serde_json::json!(best_move);
            m_val["top_moves"] = serde_json::json!(top_moves);
            m_val["pv1_full"] = score_before["pv1_full"].clone();
            m_val["mate_best"] = serde_json::json!(mate_best);
            m_val["is_book"] = serde_json::json!(is_book);
            m_val["is_sacrifice"] = serde_json::json!(sacrificed);
            m_val["opening"] = serde_json::json!(opening_name);
            // color key for accuracy report
            m_val["color"] = serde_json::json!(color);

            final_moves.push(m_val);
        }

        // --- Phase 3: Build accuracy report ---
        let report = crate::analysis::build_accuracy_report(&final_moves);

        let metadata = serde_json::json!({
            "white": parsed.headers.get("White").cloned().unwrap_or_else(|| "White".to_string()),
            "black": parsed.headers.get("Black").cloned().unwrap_or_else(|| "Black".to_string()),
            "white_elo": parsed.headers.get("WhiteElo").cloned().unwrap_or_else(|| "".to_string()),
            "black_elo": parsed.headers.get("BlackElo").cloned().unwrap_or_else(|| "".to_string()),
            "white_title": parsed.headers.get("WhiteTitle").cloned().unwrap_or_else(|| "".to_string()),
            "black_title": parsed.headers.get("BlackTitle").cloned().unwrap_or_else(|| "".to_string()),
            "event": parsed.headers.get("Event").cloned().unwrap_or_else(|| "".to_string()),
            "date": parsed.headers.get("Date").cloned().unwrap_or_else(|| "".to_string()),
            "result": parsed.headers.get("Result").cloned().unwrap_or_else(|| "*".to_string()),
            "time_control": parsed.headers.get("TimeControl").cloned().unwrap_or_else(|| "".to_string()),
            "termination": parsed.headers.get("Termination").cloned().unwrap_or_else(|| "".to_string()),
            "depth_used": depth,
        });

        // Compute initial position's white_cp from engine_scores[0]
        let initial_white_cp = if let Some(init_score) = engine_scores.first() {
            let cp0 = init_score["cp1"].as_f64().unwrap_or(0.0);
            let mate0 = init_score["score_mate"].as_i64();
            // engine_scores[0] is for the initial FEN (white to move = fens[0])
            // The turn of the initial position
            let init_fen = parsed.fens.first().map(|s| s.as_str()).unwrap_or("");
            let init_turn_white = init_fen.split_whitespace().nth(1).unwrap_or("w") == "w";
            let cp0_white = if init_turn_white { cp0 } else { -cp0 };
            let mate0_white = mate0.map(|m| if init_turn_white { m } else { -m });
            serde_json::json!({
                "white_cp": (cp0_white * 100.0).round() / 100.0,
                "score_mate": mate0_white,
            })
        } else {
            serde_json::json!({ "white_cp": 0, "score_mate": null })
        };

        let final_result = serde_json::json!({
            "type": "result",
            "data": {
                "metadata": metadata,
                "initial_fen": parsed.fens.first().cloned().unwrap_or_else(|| "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string()),
                "initial_eval": initial_white_cp,
                "moves": final_moves,
                "accuracy": report
            }
        });

        let _ = tx.send(Ok(bytes::Bytes::from(format!("{}\n", final_result)))).await;
    });

    Response::builder()
        .header("content-type", "application/x-ndjson")
        .body(axum::body::Body::from_stream(ReceiverStream::new(rx)))
        .unwrap()
}

// ---------------------------------------------------------------------------
// WebSocket Handler — Live Analysis Board
// ---------------------------------------------------------------------------
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_socket(socket, state))
}

async fn handle_ws_socket(socket: WebSocket, state: AppState) {
    let (sender, mut receiver) = socket.split();
    let sender = Arc::new(tokio::sync::Mutex::new(sender));
    let mut current_cancel: Option<tokio::sync::oneshot::Sender<()>> = None;

    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                let msg_type = val["type"].as_str().unwrap_or("");

                if msg_type == "set_fen" {
                    // Cancel any previous analysis
                    if let Some(cancel) = current_cancel.take() {
                        let _ = cancel.send(());
                    }

                    let fen = val["fen"].as_str().unwrap_or("").to_string();
                    let depth = val["depth"].as_u64().unwrap_or(18) as u32;

                    if fen.is_empty() {
                        let mut write_lock = sender.lock().await;
                        let _ = write_lock.send(Message::Text("{\"type\": \"error\", \"message\": \"Missing FEN\"}".to_string())).await;
                        continue;
                    }

                    let (tx_cancel, rx_cancel) = tokio::sync::oneshot::channel();
                    current_cancel = Some(tx_cancel);

                    let engine = state.engine.clone();
                    let sender_clone = sender.clone();
                    let fen_clone = fen.clone();

                    tokio::spawn(async move {
                        if engine.ensure_ready().await.is_err() {
                            let mut w = sender_clone.lock().await;
                            let _ = w.send(Message::Text("{\"type\": \"error\", \"message\": \"Engine not ready\"}".to_string())).await;
                            return;
                        }

                        // Check for game-over before analysis
                        if let Ok(pos_fen) = fen_clone.parse::<shakmaty::fen::Fen>() {
                            if let Ok(pos) = pos_fen.into_position::<Chess>(shakmaty::CastlingMode::Standard) {
                                if pos.is_game_over() {
                                    // Build and send terminal payload
                                    let (winner_str, white_cp, score_cp) = if pos.is_checkmate() {
                                        let winner_white = pos.turn().is_black(); // the player who just moved won
                                        let w_cp: i64 = if winner_white { 10000 } else { -10000 };
                                        let s_cp: i64 = if pos.turn().is_white() { w_cp } else { -w_cp };
                                        (if winner_white { "white" } else { "black" }, w_cp, s_cp)
                                    } else {
                                        ("draw", 0, 0)
                                    };

                                    let win_p = crate::analysis::win_prob(white_cp as f64);
                                    let (w_win, b_win, w_draw) = if winner_str == "white" {
                                         (1.0, 0.0, 0.0)
                                     } else if winner_str == "black" {
                                         (0.0, 1.0, 0.0)
                                     } else {
                                         (0.0, 0.0, 1.0)
                                     };
                                     let payload = serde_json::json!({
                                         "type": "info",
                                         "multipv": 1,
                                         "depth": 100,
                                         "score_cp": score_cp,
                                         "score_mate": if pos.is_checkmate() { serde_json::json!(0) } else { serde_json::Value::Null },
                                         "white_cp": white_cp,
                                         "white_win_prob": win_p,
                                         "white_win": w_win,
                                         "black_win": b_win,
                                         "draw_prob": w_draw,
                                         "pv": [],
                                         "from_sq": null,
                                         "to_sq": null,
                                         "game_over": true,
                                         "winner": winner_str
                                     });
                                    let mut w = sender_clone.lock().await;
                                    let _ = w.send(Message::Text(payload.to_string())).await;
                                    return;
                                }
                            }
                        }

                        // Determine turn for white_cp calculation
                        let fen_parts: Vec<&str> = fen_clone.split_whitespace().collect();
                        let turn_white = fen_parts.get(1).copied().unwrap_or("w") == "w";

                        let fen_for_analysis = fen_clone.clone();
                        let fen_for_info = fen_for_analysis.clone();

                        // Use an mpsc channel to bridge the sync on_info callback to the async WS sender
                        let (info_tx, mut info_rx) = mpsc::channel::<String>(64);

                        // Spawn a forwarder task that reads from info_tx and sends to the WebSocket
                        let sender_fwd = sender_clone.clone();
                        tokio::spawn(async move {
                            while let Some(msg_text) = info_rx.recv().await {
                                let mut w = sender_fwd.lock().await;
                                let _ = w.send(Message::Text(msg_text)).await;
                            }
                        });

                        // Run streaming analysis — on_info is a sync FnMut
                        let result = engine.analyze_position_streaming(
                            &fen_for_analysis,
                            depth,
                            rx_cancel,
                            move |mut info| {
                                // Enrich info with white_cp, absolute score_mate, and game_over
                                let score_cp = info["score_cp"].as_i64().unwrap_or(0) as f64;
                                let white_cp = if turn_white { score_cp } else { -score_cp };
                                let wdl: Option<crate::engine::WdlInfo> = serde_json::from_value(info["wdl"].clone()).ok();
                                let white_win_prob = crate::analysis::white_win_prob_from_values(
                                    wdl.as_ref(),
                                    white_cp,
                                    turn_white,
                                );

                                let (w_win, b_win, w_draw) = match wdl.as_ref() {
                                    Some(w) => {
                                        if turn_white {
                                            (w.win as f64 / 1000.0, w.loss as f64 / 1000.0, w.draw as f64 / 1000.0)
                                        } else {
                                            (w.loss as f64 / 1000.0, w.win as f64 / 1000.0, w.draw as f64 / 1000.0)
                                        }
                                    }
                                    None => {
                                        let p = white_win_prob;
                                        let d = 0.5 * (1.0 - (2.0 * p - 1.0).abs());
                                        let w = p - 0.5 * d;
                                        let b = 1.0 - p - 0.5 * d;
                                        (w, b, d)
                                    }
                                };

                                if let Some(m) = info["score_mate"].as_i64() {
                                    let abs_mate = if turn_white { m } else { -m };
                                    info["score_mate"] = serde_json::json!(abs_mate);
                                }

                                info["white_cp"] = serde_json::json!(white_cp as i64);
                                info["white_win_prob"] = serde_json::json!((white_win_prob * 10000.0).round() / 10000.0);
                                info["white_win"] = serde_json::json!((w_win * 10000.0).round() / 10000.0);
                                info["black_win"] = serde_json::json!((b_win * 10000.0).round() / 10000.0);
                                info["draw_prob"] = serde_json::json!((w_draw * 10000.0).round() / 10000.0);
                                info["game_over"] = serde_json::json!(false);
                                info["winner"] = serde_json::json!(null);
                                info["fen"] = serde_json::json!(fen_for_info);
                                info["type"] = serde_json::json!("info");

                                // Try to send; ignore if buffer is full (drop old updates gracefully)
                                let _ = info_tx.try_send(info.to_string());
                            }
                        ).await;

                        // Send done message
                        if result.is_ok() {
                            let mut w = sender_clone.lock().await;
                            let _ = w.send(Message::Text("{\"type\": \"done\"}".to_string())).await;
                        }
                    });

                } else if msg_type == "ping" {
                    let mut write_lock = sender.lock().await;
                    let _ = write_lock.send(Message::Text("{\"type\": \"pong\"}".to_string())).await;
                } else {
                    let mut write_lock = sender.lock().await;
                    let _ = write_lock.send(Message::Text(
                        format!("{{\"type\": \"error\", \"message\": \"Unknown message type: {}\"}}", msg_type)
                    )).await;
                }
            }
        }
    }

    // Cleanup: cancel any running analysis
    if let Some(cancel) = current_cancel.take() {
        let _ = cancel.send(());
    }
}

// ---------------------------------------------------------------------------
// Server Entrypoint
// ---------------------------------------------------------------------------
pub async fn start_axum_server(config: AppConfig) {
    let engine = EngineManager::new(config.clone());
    let state = AppState { config: config.clone(), engine };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/theory", post(check_theory_handler))
        .route("/api/classify", post(classify_handler))
        .route("/api/threats", post(threats_handler))
        .route("/api/import", post(import_handler))
        .route("/api/analyze", post(analyze_handler))
        .route("/api/settings/syzygy", post(update_syzygy_handler))
        .route("/api/settings/engine", post(update_engine_handler))
        .route("/api/openings/list", get(openings_list_handler))
        .route("/api/openings/explorer", post(openings_explorer_handler))
        .route("/api/training/curated-puzzles", get(curated_puzzles_handler))
        .route("/api/training/daily-puzzle", get(daily_puzzle_handler))
        .route("/api/training/engine-move", post(engine_move_handler))
        .route("/api/chesscom/games", get(chesscom_games_handler))
        .route("/ws/analyze", get(ws_handler))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], config.server_port));
    println!("[INFO] Rust Axum Backend listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
