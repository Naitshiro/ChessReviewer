use shakmaty::{Chess, Move, Position, Role, Square};

pub fn win_prob(cp: f64) -> f64 {
    let clamped = cp.max(-3000.0).min(3000.0);
    1.0 / (1.0 + (-0.004 * clamped).exp())
}

pub fn game_accuracy(deltas: &[f64]) -> f64 {
    if deltas.is_empty() {
        return 100.0;
    }
    let sum: f64 = deltas.iter().sum();
    let avg = sum / deltas.len() as f64;
    let raw_acc = 100.0 * (-11.3 * avg).exp();
    raw_acc.max(0.0).min(100.0)
}

pub fn role_value(role: Role) -> i32 {
    match role {
        Role::Pawn => 100,
        Role::Knight => 320,
        Role::Bishop => 330,
        Role::Rook => 500,
        Role::Queen => 900,
        Role::King => 0,
    }
}

pub fn get_move_captured_value(mv: &Move) -> i32 {
    match mv {
        Move::Normal { capture, .. } => capture.map(role_value).unwrap_or(0),
        Move::EnPassant { .. } => 100, // En Passant always captures a pawn
        _ => 0,                        // Castle and Put never capture
    }
}

pub fn get_max_loss_for_move(pos: &Chess, mv: &Move) -> i32 {
    let material_won = get_move_captured_value(mv);

    let after_pos = pos.clone();
    let after_pos = match after_pos.play(mv) {
        Ok(next) => next,
        Err(_) => return 0,
    };

    let mut max_loss = 0;
    let opponent_captures: Vec<Move> = after_pos
        .legal_moves()
        .into_iter()
        .filter(|m| m.is_capture())
        .collect();

    for op_move in opponent_captures {
        let target_value = get_move_captured_value(&op_move);

        let recapture_pos = after_pos.clone();
        let recapture_pos = match recapture_pos.play(&op_move) {
            Ok(next) => next,
            Err(_) => continue,
        };

        let mut max_recapture_value = 0;
        for my_cap in recapture_pos.legal_moves() {
            if my_cap.is_capture() {
                let cap_val = get_move_captured_value(&my_cap);
                if cap_val > max_recapture_value {
                    max_recapture_value = cap_val;
                }
            }
        }

        let net_loss = target_value - max_recapture_value;
        let net_loss_clamped = net_loss.max(0);
        let loss = net_loss_clamped - material_won;
        if loss > max_loss {
            max_loss = loss;
        }
    }

    max_loss
}

pub fn is_sacrifice(pos: &Chess, mv: &Move, mate_played: Option<i32>) -> bool {
    // Exclude queen promotions from sacrifices
    if let Move::Normal { promotion: Some(Role::Queen), .. } = mv {
        return false;
    }

    let actual_max_loss = get_max_loss_for_move(pos, mv);
    if actual_max_loss >= 200 {
        if mate_played.is_some() && mate_played.unwrap() > 0 {
            return true;
        }

        // Check if mover piece was already threatened before the move
        let mover_role = mv.role();
        let from_sq = mv.from().unwrap_or(Square::A1);
        let mut before_loss_of_mover = 0;

        if !pos.is_check() {
            let mover_value = role_value(mover_role);
            let turn = pos.turn();
            
            let fen = shakmaty::fen::Fen::from_position(pos.clone(), shakmaty::EnPassantMode::Always).to_string();
            let mut parts: Vec<&str> = fen.split_whitespace().collect();
            if parts.len() >= 4 {
                parts[1] = if parts[1] == "w" { "b" } else { "w" };
                parts[3] = "-";
                let null_fen = parts.join(" ");
                
                if let Ok(null_pos_fen) = null_fen.parse::<shakmaty::fen::Fen>() {
                    if let Ok(null_pos) = null_pos_fen.into_position::<Chess>(shakmaty::CastlingMode::Standard) {
                        let defended = !pos.board().attacks_to(from_sq, turn, pos.board().occupied()).is_empty();
                        
                        for op_move in null_pos.legal_moves() {
                            if op_move.to() == from_sq {
                                let attacker_role = op_move.role();
                                let op_val = role_value(attacker_role);
                                let loss = if defended {
                                    (mover_value - op_val).max(0)
                                } else {
                                    mover_value
                                };
                                if loss > before_loss_of_mover {
                                    before_loss_of_mover = loss;
                                }
                            }
                        }
                    }
                }
            }
        }

        if before_loss_of_mover > actual_max_loss {
            return false;
        }

        // Verify it was a deliberate choice by checking other legal moves
        for alt_move in pos.legal_moves() {
            if alt_move == *mv {
                continue;
            }
            let alt_loss = get_max_loss_for_move(pos, &alt_move);
            if alt_loss < 50 {
                return true; // we found a safe alternative
            }
        }
    }

    // Default return
    false
}

pub fn classify_move(
    delta: f64,
    _p_best: f64,
    _p_second_best: f64,
    p_played: f64,
    sacrificed: bool,
    is_book: bool,
    cp_best: f64,
    cp_second: f64,
    cp_played: f64,
    mate_best: Option<i32>,
    mate_played: Option<i32>,
    is_engine_top_choice: bool,
) -> &'static str {
    let mut adjusted_delta = delta;
    if is_engine_top_choice {
        adjusted_delta = 0.0;
    }

    // Brilliant checks (needs material sacrifice, high win probability, and within evaluation loss threshold)
    if sacrificed && p_played >= 0.45 && (cp_best - cp_played) <= 50.0 {
        return "brilliant";
    }

    if is_book {
        return "theory";
    }

    if is_engine_top_choice {
        if adjusted_delta < 0.02 && cp_best > 0.0 && cp_second <= 0.0 {
            return "great";
        }
        return "best";
    }

    // 1. Explicit Mate Handling
    if mate_best.is_some() || mate_played.is_some() {
        if let (Some(m_best), Some(m_played)) = (mate_best, mate_played) {
            if m_best > 0 && m_played > 0 {
                let optimal_mate = m_best - 1;
                let diff = m_played - optimal_mate;
                if diff <= 0 {
                    return "best";
                } else if diff <= 7 {
                    return "excellent";
                } else {
                    return "good";
                }
            } else if m_best < 0 && m_played < 0 {
                let optimal_defense = m_best + 1;
                let diff = m_played - optimal_defense;
                if diff <= 0 {
                    return "best";
                } else if diff <= 7 {
                    return "excellent";
                } else {
                    return "good";
                }
            } else if m_best > 0 && m_played < 0 {
                return "blunder";
            } else if m_best < 0 && m_played > 0 {
                return "best";
            }
        } else if let (Some(m_best), None) = (mate_best, mate_played) {
            if m_best > 0 {
                if cp_played > 500.0 {
                    return "good";
                } else if cp_played > 200.0 {
                    return "inaccuracy";
                } else {
                    return "mistake";
                }
            } else {
                return "best";
            }
        } else if let (None, Some(m_played)) = (mate_best, mate_played) {
            if m_played < 0 {
                if cp_best > -400.0 {
                    return "blunder";
                } else if cp_best > -1500.0 {
                    return "mistake";
                }
                return "inaccuracy";
            } else {
                return "best";
            }
        }
    }

    // Great move check
    if adjusted_delta < 0.02 && cp_best > 0.0 && cp_second <= 0.0 {
        return "great";
    }

    // Best move check
    if adjusted_delta == 0.0 {
        return "best";
    }

    // Delta-based checks
    if adjusted_delta < 0.02 {
        return "excellent";
    }
    if adjusted_delta < 0.05 {
        return "good";
    }
    if adjusted_delta < 0.10 {
        return "inaccuracy";
    }
    if adjusted_delta < 0.20 {
        return "mistake";
    }
    "blunder"
}

pub fn accuracy_to_rating(accuracy: f64) -> i32 {
    if accuracy <= 50.0 {
        100
    } else if accuracy <= 65.0 {
        (100.0 + (accuracy - 50.0) * (500.0 / 15.0)) as i32
    } else if accuracy <= 75.0 {
        (600.0 + (accuracy - 65.0) * 60.0) as i32
    } else if accuracy <= 85.0 {
        (1200.0 + (accuracy - 75.0) * 60.0) as i32
    } else if accuracy <= 95.0 {
        (1800.0 + (accuracy - 85.0) * 100.0) as i32
    } else {
        (2800.0 + (accuracy - 95.0) * 240.0) as i32
    }
}

pub fn accuracy_to_badge(accuracy: f64) -> &'static str {
    if accuracy >= 90.0 {
        "best"
    } else if accuracy >= 75.0 {
        "excellent"
    } else if accuracy >= 50.0 {
        "good"
    } else if accuracy >= 30.0 {
        "inaccuracy"
    } else if accuracy >= 20.0 {
        "mistake"
    } else {
        "blunder"
    }
}

pub fn build_accuracy_report(moves: &[serde_json::Value]) -> serde_json::Value {
    let labels = ["brilliant", "great", "best", "excellent", "good",
                  "theory", "inaccuracy", "mistake", "blunder"];

    let side_report = |color: &str| {
        let records: Vec<&serde_json::Value> = moves
            .iter()
            .filter(|r| r["color"].as_str() == Some(color))
            .collect();

        let deltas: Vec<f64> = records
            .iter()
            .map(|r| {
                if r["classification"].as_str() == Some("theory") {
                    0.0
                } else {
                    r["delta"].as_f64().unwrap_or(0.0)
                }
            })
            .collect();

        let accuracy = game_accuracy(&deltas);

        let mut counts = std::collections::HashMap::new();
        for lbl in &labels {
            counts.insert(lbl.to_string(), 0);
        }

        for r in &records {
            if let Some(c) = r["classification"].as_str() {
                if counts.contains_key(c) {
                    *counts.get_mut(c).unwrap() += 1;
                }
            }
        }

        let raw_rating = accuracy_to_rating(accuracy);
        let num_moves = records.len();
        let mut base_cap = 3200;
        if num_moves <= 10 {
            base_cap = 2000;
        } else if num_moves <= 15 {
            base_cap = 2500;
        } else if num_moves <= 25 {
            base_cap = 3000;
        }

        let capped_rating = raw_rating.min(base_cap);

        // Phase calculations
        let mut phase_badges = std::collections::HashMap::new();
        let mut phase_accuracies = std::collections::HashMap::new();

        for phase in &["opening", "middlegame", "endgame"] {
            let phase_records: Vec<&serde_json::Value> = records
                .iter()
                .filter(|r| r["phase"].as_str() == Some(*phase))
                .cloned()
                .collect();

            if phase_records.is_empty() {
                continue;
            }

            let p_deltas: Vec<f64> = phase_records
                .iter()
                .map(|r| {
                    if r["classification"].as_str() == Some("theory") {
                        0.0
                    } else {
                        r["delta"].as_f64().unwrap_or(0.0)
                    }
                })
                .collect();

            let p_accuracy = game_accuracy(&p_deltas);
            let mut base_badge = accuracy_to_badge(p_accuracy).to_string();

            let p_classifications: Vec<&str> = phase_records
                .iter()
                .filter_map(|r| r["classification"].as_str())
                .collect();

            let has_brilliant = p_classifications.contains(&"brilliant");
            let has_great = p_classifications.contains(&"great");

            if p_accuracy >= 95.0 && has_brilliant {
                base_badge = "brilliant".to_string();
            } else if p_accuracy == 100.0 || (p_accuracy >= 95.0 && has_great) || (p_accuracy >= 85.0 && has_brilliant) {
                base_badge = "great".to_string();
            }

            let p_acc_rounded = (p_accuracy * 10.0).round() / 10.0;
            phase_accuracies.insert(phase.to_string(), p_acc_rounded);
            phase_badges.insert(phase.to_string(), base_badge);
        }

        let mut brilliant_bonus = 0;
        let mut great_bonus = 0;
        for b in phase_badges.values() {
            if b == "brilliant" {
                brilliant_bonus += 500;
            } else if b == "great" {
                great_bonus += 100;
            }
        }

        let final_rating = (capped_rating + brilliant_bonus + great_bonus).min(4000);
        // Round to nearest 100
        let rounded_rating = ((final_rating as f64 / 100.0).round() * 100.0) as i32;

        serde_json::json!({
            "accuracy": (accuracy * 10.0).round() / 10.0,
            "estimated_rating": rounded_rating,
            "counts": counts,
            "phases": phase_badges,
            "phase_accuracies": phase_accuracies
        })
    };

    serde_json::json!({
        "white": side_report("white"),
        "black": side_report("black")
    })
}
