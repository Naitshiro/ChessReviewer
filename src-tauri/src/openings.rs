use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use shakmaty::{Chess, Position};
use shakmaty::san::San;

pub struct EcoDb {
    pub lookup: HashMap<String, (String, usize)>,
    pub prefixes: HashSet<Vec<String>>,
}

static ECO_DB: OnceLock<EcoDb> = OnceLock::new();

pub fn get_fen_key(fen: &str) -> String {
    fen.split_whitespace().take(3).collect::<Vec<&str>>().join(" ")
}

pub fn parse_san_sequence(moves_str: &str) -> Vec<String> {
    let mut san_moves = Vec::new();
    for t in moves_str.split_whitespace() {
        // Skip move numbers like "1.", "1...", "2."
        if t.contains('.') {
            continue;
        }
        san_moves.push(t.to_string());
    }
    san_moves
}

pub fn get_eco_db() -> &'static EcoDb {
    ECO_DB.get_or_init(|| {
        let mut lookup = HashMap::new();
        let mut prefixes = HashSet::new();

        let pgn_data = include_str!("eco.pgn");
        let mut current_opening = String::new();
        let mut current_variation = String::new();
        let mut in_comment = false;

        for line in pgn_data.lines() {
            let mut line = line.trim();
            if line.is_empty() {
                continue;
            }

            if in_comment {
                if let Some(pos) = line.find('}') {
                    line = line[pos + 1..].trim();
                    in_comment = false;
                    if line.is_empty() {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            if line.starts_with('{') {
                if let Some(pos) = line.find('}') {
                    line = line[pos + 1..].trim();
                    if line.is_empty() {
                        continue;
                    }
                } else {
                    in_comment = true;
                    continue;
                }
            }

            if line.starts_with('[') {
                if let Some(tag_content) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                    let parts: Vec<&str> = tag_content.splitn(2, ' ').collect();
                    if parts.len() == 2 {
                        let tag_name = parts[0];
                        let tag_val = parts[1].trim_matches('"');
                        match tag_name {
                            "Opening" => current_opening = tag_val.to_string(),
                            "Variation" => current_variation = tag_val.to_string(),
                            _ => {}
                        }
                    }
                }
            } else {
                // Move line (e.g. "1. b4 Nh6 *")
                let moves_str = line.trim_end_matches('*').trim();
                let seq = parse_san_sequence(moves_str);
                if !seq.is_empty() {
                    let mut pos = Chess::default();
                    let mut valid = true;
                    let mut fen_keys = Vec::new();

                    for san_str in &seq {
                        if let Ok(san) = san_str.parse::<San>() {
                            if let Ok(mv) = san.to_move(&pos) {
                                pos.play_unchecked(&mv);
                                let fen_after = shakmaty::fen::Fen::from_position(pos.clone(), shakmaty::EnPassantMode::Always).to_string();
                                fen_keys.push(get_fen_key(&fen_after));
                            } else {
                                valid = false;
                                break;
                            }
                        } else {
                            valid = false;
                            break;
                        }
                    }

                    if valid {
                        let name = if current_variation.is_empty() {
                            current_opening.clone()
                        } else {
                            let var_lower = current_variation.to_lowercase();
                            if var_lower.contains("variation") {
                                format!("{} ({})", current_opening, current_variation)
                            } else {
                                format!("{} ({} variation)", current_opening, current_variation)
                            }
                        };

                        let seq_len = seq.len();
                        for key in fen_keys {
                            let should_insert = match lookup.get(&key) {
                                Some((_, existing_len)) => seq_len < *existing_len,
                                None => true,
                            };
                            if should_insert {
                                lookup.insert(key, (name.clone(), seq_len));
                            }
                        }

                        for i in 1..=seq.len() {
                            prefixes.insert(seq[0..i].to_vec());
                        }
                    }
                }

                current_opening.clear();
                current_variation.clear();
            }
        }

        EcoDb { lookup, prefixes }
    })
}

pub fn get_opening_name(fen: &str) -> Option<String> {
    let db = get_eco_db();
    let key = get_fen_key(fen);
    db.lookup.get(&key).map(|(name, _)| name.clone())
}

pub fn is_book_sequence(san_history: &[String]) -> bool {
    let db = get_eco_db();
    let history_vec = san_history.to_vec();
    db.prefixes.contains(&history_vec)
}
