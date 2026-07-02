use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

#[derive(Deserialize)]
pub struct EcoInfo {
    pub name: String,
    pub moves: String,
}

pub struct EcoDb {
    pub lookup: HashMap<String, String>,
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

        // Embed the JSON opening database at compile time
        let json_data = include_str!("../../backend/eco_interpolated.json");
        if let Ok(data) = serde_json::from_str::<HashMap<String, EcoInfo>>(json_data) {
            for (fen_str, info) in data {
                let key = get_fen_key(&fen_str);
                lookup.insert(key, info.name);

                let seq = parse_san_sequence(&info.moves);
                for i in 1..=seq.len() {
                    prefixes.insert(seq[0..i].to_vec());
                }
            }
        }

        EcoDb { lookup, prefixes }
    })
}

pub fn get_opening_name(fen: &str) -> Option<String> {
    let db = get_eco_db();
    let key = get_fen_key(fen);
    db.lookup.get(&key).cloned()
}

pub fn is_book_sequence(san_history: &[String]) -> bool {
    let db = get_eco_db();
    let history_vec = san_history.to_vec();
    db.prefixes.contains(&history_vec)
}
