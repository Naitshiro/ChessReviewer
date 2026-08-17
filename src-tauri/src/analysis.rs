use shakmaty::{Chess, Move, Position, Role, Square};

pub fn win_prob(cp: f64) -> f64 {
    let clamped = cp.max(-10000.0).min(10000.0);
    1.0 / (1.0 + (-0.00368208 * clamped).exp())
}

#[allow(dead_code)]
pub fn win_prob_from_wdl(wdl: &crate::engine::WdlInfo) -> f64 {
    (wdl.win as f64 + 0.5 * wdl.draw as f64) / 1000.0
}

#[allow(dead_code)]
pub fn win_prob_from_values(wdl: Option<&crate::engine::WdlInfo>, cp: f64) -> f64 {
    match wdl {
        Some(w) => win_prob_from_wdl(w),
        None => win_prob(cp),
    }
}

pub fn white_win_prob_from_wdl(wdl_after: &crate::engine::WdlInfo, turn_after_is_white: bool) -> f64 {
    if turn_after_is_white {
        (wdl_after.win as f64 + 0.5 * wdl_after.draw as f64) / 1000.0
    } else {
        (wdl_after.loss as f64 + 0.5 * wdl_after.draw as f64) / 1000.0
    }
}

pub fn white_win_prob_from_values(wdl_after: Option<&crate::engine::WdlInfo>, white_cp: f64, turn_after_is_white: bool) -> f64 {
    match wdl_after {
        Some(w) => white_win_prob_from_wdl(w, turn_after_is_white),
        None => win_prob(white_cp),
    }
}

pub fn move_accuracy(delta: f64, classification: &str) -> f64 {
    if classification == "theory" || classification == "best" || classification == "great" {
        return 100.0;
    }

    let delta_pct = (delta * 100.0).max(0.0);
    let raw_acc = 103.1668 * (-0.04354 * delta_pct).exp() - 3.1669;
    let clamped_acc = raw_acc.max(0.0).min(100.0);

    let max_acc = match classification {
        "excellent" => 92.0,
        "good" => 82.0,
        "inaccuracy" => 65.0,
        "mistake" => 45.0,
        "blunder" => 20.0,
        _ => 100.0,
    };

    clamped_acc.min(max_acc)
}

pub fn game_accuracy(accuracies: &[f64]) -> f64 {
    if accuracies.is_empty() {
        return 100.0;
    }
    let sum: f64 = accuracies.iter().sum();
    let avg = sum / accuracies.len() as f64;
    avg.max(0.0).min(100.0)
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
                if my_cap.to() == op_move.to() || cap_val >= target_value {
                    if cap_val > max_recapture_value {
                        max_recapture_value = cap_val;
                    }
                }
            }
        }

        let net_loss = target_value - max_recapture_value;
        let net_loss_clamped = net_loss.max(0);
        let mut loss = net_loss_clamped - material_won;
        
        // If we lose a real piece (not just a pawn) and still have a net material loss >= 50,
        // treat it as a full sacrifice to pass the 150 threshold.
        if loss >= 50 && target_value > 100 {
            loss = loss.max(150);
        }

        if loss > max_loss {
            max_loss = loss;
        }
    }

    max_loss
}

pub fn is_piece_hanging_on_square(
    pos: &Chess,
    sq: Square,
    piece_role: Role,
    friendly_color: shakmaty::Color,
) -> bool {
    if piece_role == Role::Pawn || piece_role == Role::King {
        return false;
    }

    let piece_val = role_value(piece_role);
    let opponent_color = !friendly_color;
    let occupied = pos.board().occupied();

    let attacker_squares = pos.board().attacks_to(sq, opponent_color, occupied);
    if attacker_squares.is_empty() {
        return false;
    }

    let defender_squares = pos.board().attacks_to(sq, friendly_color, occupied);

    let mut min_attacker_val = i32::MAX;
    let mut attackers_count = 0;
    let mut has_lower_attacker = false;

    for atk_sq in attacker_squares {
        if let Some(piece) = pos.board().piece_at(atk_sq) {
            attackers_count += 1;
            let atk_val = if piece.role == Role::King { 10_000 } else { role_value(piece.role) };
            if atk_val < min_attacker_val {
                min_attacker_val = atk_val;
            }
            if piece.role != Role::King && atk_val < piece_val {
                has_lower_attacker = true;
            }
        }
    }

    if has_lower_attacker {
        return true;
    }

    let mut defenders_count = 0;
    let mut has_cheaper_defender = false;
    let mut has_pawn_defender = false;

    for dfn_sq in defender_squares {
        if let Some(piece) = pos.board().piece_at(dfn_sq) {
            defenders_count += 1;
            let dfn_val = if piece.role == Role::King { 10_000 } else { role_value(piece.role) };
            if dfn_val < min_attacker_val {
                has_cheaper_defender = true;
            }
            if piece.role == Role::Pawn {
                has_pawn_defender = true;
            }
        }
    }

    if attackers_count == 1 && piece_val <= min_attacker_val {
        // Check if capturing the piece allows an immediate recapture of equal or greater value (e.g. x-ray connected rooks)
        for op_move in pos.legal_moves() {
            if op_move.to() == sq && op_move.is_capture() {
                if let Ok(recapture_pos) = pos.clone().play(&op_move) {
                    let mut max_recapture_value = 0;
                    for my_cap in recapture_pos.legal_moves() {
                        if my_cap.is_capture() && my_cap.to() == sq {
                            let cap_val = get_move_captured_value(&my_cap);
                            if cap_val > max_recapture_value {
                                max_recapture_value = cap_val;
                            }
                        }
                    }
                    if max_recapture_value >= piece_val {
                        return false;
                    }
                }
            }
        }
    }

    if attackers_count > defenders_count {
        if piece_val < min_attacker_val && has_cheaper_defender {
            return false;
        }
        if has_pawn_defender && piece_val == min_attacker_val {
            return false;
        }
        return true;
    }

    false
}


pub fn is_sacrifice(pos: &Chess, mv: &Move, mate_played: Option<i32>) -> bool {
    // Exclude queen promotions and king moves from sacrifices
    if let Move::Normal { promotion: Some(Role::Queen), .. } = mv {
        return false;
    }
    if mv.role() == Role::King {
        return false;
    }

    let turn = pos.turn();
    let after_pos = match pos.clone().play(mv) {
        Ok(next) => next,
        Err(_) => return false,
    };

    let mut actual_max_loss = get_max_loss_for_move(pos, mv);
    
    // In a forcing mate sequence, ignore recapture value since material doesn't matter
    if let Some(m) = mate_played {
        if m > 0 {
            let material_won = get_move_captured_value(mv);
            let mut naive_loss = 0;
            for op_move in after_pos.legal_moves().into_iter().filter(|m| m.is_capture()) {
                let target_value = get_move_captured_value(&op_move);
                let loss = target_value - material_won;
                if loss > naive_loss {
                    naive_loss = loss;
                }
            }
            if naive_loss > actual_max_loss {
                actual_max_loss = naive_loss;
            }
        }
    }

    if actual_max_loss >= 150 {
        if let Some(m) = mate_played {
            if m > 0 {
                return true;
            }
        }

        // Check if mover piece was already threatened before the move
        let mover_role = mv.role();
        let from_sq = mv.from().unwrap_or(Square::A1);
        let mut before_loss_of_mover = 0;

        if !pos.is_check() {
            let mover_value = role_value(mover_role);
            
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

        if before_loss_of_mover <= actual_max_loss {
            // Verify it was a deliberate choice by checking other legal moves
            for alt_move in pos.legal_moves() {
                if alt_move == *mv {
                    continue;
                }
                let alt_loss = get_max_loss_for_move(pos, &alt_move);
                if alt_loss < actual_max_loss - 50 {
                    return true; // we found a safer alternative
                }
            }
        }
    }

    // Check if any friendly piece on board is left hanging/under-defended (e.g. piece sacrifice or deflection bait)
    if !pos.is_check() && !after_pos.is_check() && mv.role() != Role::Pawn && mv.role() != Role::King {
        let captured_val = get_move_captured_value(mv);
        for sq in after_pos.board().occupied() {
            if let Some(piece) = after_pos.board().piece_at(sq) {
                if piece.color == turn && piece.role != Role::Pawn && piece.role != Role::King {
                    if captured_val >= role_value(piece.role) {
                        continue;
                    }
                    if is_piece_hanging_on_square(&after_pos, sq, piece.role, turn) {
                        // Check if piece was already hanging on this square in pos
                        let was_already_hanging = pos.board().piece_at(sq) == Some(piece)
                            && is_piece_hanging_on_square(pos, sq, piece.role, turn);

                        // If it was already hanging, do not re-flag on pawn captures
                        if was_already_hanging && captured_val > 0 {
                            continue;
                        }

                        // Verify if there was an alternative legal move in pos that did NOT leave this piece hanging
                        let mut found_safer_alt = false;
                        for alt_move in pos.legal_moves() {
                            if alt_move == *mv {
                                continue;
                            }
                            if let Ok(alt_after) = pos.clone().play(&alt_move) {
                                let piece_still_on_sq = alt_after.board().piece_at(sq) == Some(piece);
                                if piece_still_on_sq && !is_piece_hanging_on_square(&alt_after, sq, piece.role, turn) {
                                    found_safer_alt = true;
                                    break;
                                } else if !piece_still_on_sq {
                                    // The alt move moved the piece away or captured
                                    found_safer_alt = true;
                                    break;
                                }
                            }
                        }
                        if found_safer_alt {
                            return true;
                        }
                    }
                }
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
    mate_second: Option<i32>,
    mate_played: Option<i32>,
    is_engine_top_choice: bool,
    is_recapture: bool,
    is_checkmate_delivered: bool,
) -> &'static str {
    // 0. Checkmate delivered on the board
    if is_checkmate_delivered || (mate_best == Some(1) && mate_played == Some(0)) {
        let is_only_mate = mate_second.is_none() || mate_second.unwrap() <= 0;
        if is_only_mate {
            return "great";
        }
        return "best";
    }

    let is_in_mating_sequence = mate_best.map(|m| m > 0 && m <= 8).unwrap_or(false)
        || mate_played.map(|m| m > 0 && m <= 8).unwrap_or(false);

    let is_runaway_winning = mate_best.is_none() && mate_played.is_none() && (cp_best >= 1000.0 && cp_second >= 800.0);

    // In a forcing mate sequence, a genuine sacrifice (sacrificing Q, R, B, N) is brilliant
    if sacrificed && !is_recapture && is_in_mating_sequence && !is_runaway_winning {
        return "brilliant";
    }

    // Do not award brilliant if position before move is already completely winning
    let already_winning = cp_second >= 600.0
        || mate_second.map(|m| m > 0).unwrap_or(false)
        || (cp_best >= 700.0 && cp_second >= 400.0);

    // Brilliant checks (needs material sacrifice, not a recapture, not already winning before the move, and maintains high win probability)
    if sacrificed && !is_recapture && !already_winning && (p_played >= 0.45 && (delta <= 0.03 || (cp_best - cp_played) <= 50.0)) {
        return "brilliant";
    }

    if is_book {
        return "theory";
    }

    let cp_loss = (cp_best - cp_played).max(0.0);

    if (is_engine_top_choice || cp_loss <= 10.0) && !sacrificed && !is_recapture {
        let is_only_mating_move = if let Some(m_best) = mate_best {
            if m_best > 0 {
                mate_second.is_none() || mate_second.unwrap() <= 0
            } else {
                false
            }
        } else {
            false
        };

        let is_critical_position = cp_best.abs() <= 600.0;
        let has_large_eval_delta = (cp_best - cp_second) >= 300.0 && is_critical_position;

        if is_only_mating_move || has_large_eval_delta {
            return "great";
        }
    }

    if is_engine_top_choice {
        return "best";
    }

    // Top-equivalent moves rule (eval difference <= 10 cp / 0.10 pawn)
    if !sacrificed && !is_recapture && cp_loss <= 10.0 && mate_best.is_none() && mate_played.is_none() {
        return "best";
    }

    // 1. Explicit Mate Handling
    if mate_best.is_some() || mate_played.is_some() {
        if let (Some(m_best), Some(m_played)) = (mate_best, mate_played) {
            if m_best > 0 && m_played > 0 {
                if m_played <= m_best {
                    let is_only_mate = mate_second.is_none() || mate_second.unwrap() <= 0 || mate_second.unwrap() > m_best;
                    if is_only_mate {
                        return "great";
                    }
                    return "best";
                }
                let mate_loss = m_played - m_best;
                if mate_loss <= 1 && m_played <= 5 {
                    return "excellent";
                } else if mate_loss <= 3 {
                    return "good";
                } else {
                    return "inaccuracy";
                }
            } else if m_best < 0 && m_played < 0 {
                let is_only_mate = mate_second.is_none() || mate_second.unwrap() >= 0;
                if is_only_mate {
                    return "great";
                }
                return "best";
            } else if m_best > 0 && m_played < 0 {
                return "blunder";
            } else if m_best < 0 && m_played > 0 {
                return "best";
            }
        } else if let (Some(m_best), None) = (mate_best, mate_played) {
            if m_best > 0 {
                if cp_played >= 1000.0 {
                    return "excellent";
                } else if cp_played >= 500.0 {
                    return "good";
                } else if cp_played >= 200.0 {
                    return "inaccuracy";
                } else if cp_played >= 0.0 {
                    return "mistake";
                } else {
                    return "blunder";
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

    // 2. Non-mating values classification
    let mut classification = if cp_best > 1000.0 {
        // Percentage-based scaling for evaluations above +10.0 (+1000 cp)
        if cp_loss <= 10.0 {
            "best"
        } else if cp_played >= 1000.0 {
            // Still completely winning (> +10.0), e.g. +50.0 -> +14.0
            "excellent"
        } else {
            let retained_ratio = cp_played / cp_best;
            if retained_ratio >= 0.70 {
                "excellent"
            } else if retained_ratio >= 0.40 {
                "good"
            } else if retained_ratio >= 0.20 {
                "inaccuracy"
            } else if retained_ratio >= 0.05 {
                "mistake"
            } else {
                "blunder"
            }
        }
    } else {
        // Standard threshold logic for evaluations <= +10.0 (+1000 cp)
        let excellent_threshold = 35.0;
        let good_threshold = 100.0;
        let inaccuracy_threshold = 200.0;
        let mistake_threshold = 600.0;

        if cp_loss <= 10.0 {
            "best"
        } else if cp_loss < excellent_threshold {
            "excellent"
        } else if cp_loss < good_threshold {
            "good"
        } else if cp_loss < inaccuracy_threshold {
            "inaccuracy"
        } else if cp_loss < mistake_threshold {
            "mistake"
        } else {
            "blunder"
        }
    };

    if classification == "blunder" {
        if cp_best < -1000.0 {
            classification = "inaccuracy";
        } else if cp_best < -500.0 {
            classification = "mistake";
        }
    } else if classification == "mistake" {
        if cp_best < -1000.0 {
            classification = "inaccuracy";
        }
    }

    classification
}


pub fn accuracy_to_rating(accuracy: f64) -> i32 {
    if accuracy <= 40.0 {
        (100.0 + accuracy * 7.5) as i32
    } else if accuracy <= 60.0 {
        (400.0 + (accuracy - 40.0) * 20.0) as i32
    } else if accuracy <= 75.0 {
        (800.0 + (accuracy - 60.0) * 33.33) as i32
    } else if accuracy <= 85.0 {
        (1300.0 + (accuracy - 75.0) * 50.0) as i32
    } else if accuracy <= 95.0 {
        (1800.0 + (accuracy - 85.0) * 70.0) as i32
    } else {
        (2500.0 + (accuracy - 95.0) * 100.0) as i32
    }
}

pub fn calculate_game_rating(accuracy: f64, counts: &std::collections::HashMap<String, usize>) -> i32 {
    let base_rating = accuracy_to_rating(accuracy) as f64;

    let blunders = counts.get("blunder").cloned().unwrap_or(0) as f64;
    let mistakes = counts.get("mistake").cloned().unwrap_or(0) as f64;
    let inaccuracies = counts.get("inaccuracy").cloned().unwrap_or(0) as f64;

    let blunder_penalty = blunders * 200.0;
    let mistake_penalty = mistakes * 100.0;
    let inaccuracy_penalty = inaccuracies * 25.0;

    let total_penalty = blunder_penalty + mistake_penalty + inaccuracy_penalty;
    let adjusted_rating = (base_rating - total_penalty).max(100.0);

    let rounded = ((adjusted_rating / 50.0).round() * 50.0) as i32;
    rounded.max(100)
}

pub fn accuracy_to_badge(accuracy: f64) -> &'static str {
    if accuracy >= 90.0 {
        "best"
    } else if accuracy >= 75.0 {
        "excellent"
    } else if accuracy >= 50.0 {
        "good"
    } else if accuracy >= 35.0 {
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

        let move_accuracies: Vec<f64> = records
            .iter()
            .filter_map(|r| {
                let cls = r["classification"].as_str().unwrap_or("good");
                let delta = r["delta"].as_f64().unwrap_or(0.0);
                Some(move_accuracy(delta, cls))
            })
            .collect();

        eprintln!("[ACC-DEBUG] side={}", color);
        for (i, r) in records.iter().enumerate() {
            let cls = r["classification"].as_str().unwrap_or("good");
            let delta = r["delta"].as_f64().unwrap_or(0.0);
            eprintln!(
                "[ACC-DEBUG]   move={} class={} delta={:.4} move_acc={:.2}",
                i, cls, delta, move_accuracies.get(i).copied().unwrap_or(0.0)
            );
        }
        if !move_accuracies.is_empty() {
            let n = move_accuracies.len() as f64;
            let arith = move_accuracies.iter().sum::<f64>() / n;
            let geo = (move_accuracies.iter().map(|a| (a.max(0.01)).ln()).sum::<f64>() / n).exp();
            let harm = n / move_accuracies.iter().map(|a| 1.0 / a.max(0.01)).sum::<f64>();
            eprintln!(
                "[ACC-DEBUG]   arithmetic={:.2} geometric={:.2} harmonic={:.2}",
                arith, geo, harm
            );
        }

        let accuracy = game_accuracy(&move_accuracies);

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

        let raw_rating = calculate_game_rating(accuracy, &counts);
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

            let p_accuracies: Vec<f64> = phase_records
                .iter()
                .filter_map(|r| {
                    let cls = r["classification"].as_str().unwrap_or("good");
                    let delta = r["delta"].as_f64().unwrap_or(0.0);
                    Some(move_accuracy(delta, cls))
                })
                .collect();

            if p_accuracies.is_empty() {
                continue;
            }

            let p_accuracy = game_accuracy(&p_accuracies);
            let mut base_badge = accuracy_to_badge(p_accuracy).to_string();

            let p_classifications: Vec<&str> = phase_records
                .iter()
                .filter_map(|r| r["classification"].as_str())
                .collect();

            let has_brilliant = p_classifications.contains(&"brilliant");
            let has_great = p_classifications.contains(&"great");

            if p_accuracy >= 95.0 && has_brilliant {
                base_badge = "brilliant".to_string();
            } else if p_accuracy >= 95.0 && has_great {
                base_badge = "great".to_string();
            }

            let p_acc_rounded = (p_accuracy * 10.0).round() / 10.0;
            phase_accuracies.insert(phase.to_string(), p_acc_rounded);
            phase_badges.insert(phase.to_string(), base_badge);
        }

        let mut brilliant_bonus = 0;
        let great_bonus = 0;
        for b in phase_badges.values() {
            if b == "brilliant" {
                brilliant_bonus += 50;
            }
        }

        let final_rating = (capped_rating + brilliant_bonus + great_bonus).min(3200);
        let rounded_rating = ((final_rating as f64 / 50.0).round() * 50.0) as i32;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sacrifice_when_already_winning_is_not_brilliant() {
        // Position before move is already winning (+12.0 eval or cp_second >= 600)
        let classification = classify_move(
            0.0,    // delta
            1.0,    // p_best
            1.0,    // p_second_best
            1.0,    // p_played
            true,   // sacrificed
            false,  // is_book
            1200.0, // cp_best
            1150.0, // cp_second
            1200.0, // cp_played
            Some(12), // mate_best
            Some(14), // mate_second
            Some(12), // mate_played
            true,   // is_engine_top_choice
            false,  // is_recapture
            false,  // is_checkmate_delivered
        );
        assert_eq!(classification, "best");
    }

    #[test]
    fn test_genuine_sacrifice_is_brilliant() {
        // Contested position where sacrifice is the key winning move
        let classification = classify_move(
            0.0,   // delta
            0.99,  // p_best
            0.52,  // p_second_best
            0.99,  // p_played
            true,  // sacrificed
            false, // is_book
            450.0, // cp_best
            50.0,  // cp_second
            450.0, // cp_played
            None,  // mate_best
            None,  // mate_second
            None,  // mate_played
            true,  // is_engine_top_choice
            false, // is_recapture
            false, // is_checkmate_delivered
        );
        assert_eq!(classification, "brilliant");
    }

    #[test]
    fn test_percentage_scaling_above_ten_eval() {
        // 1. Eval drops from 50.0 to 14.0 (5000 cp -> 1400 cp): still > 10.0 -> excellent
        let res1 = classify_move(
            0.0, 1.0, 1.0, 1.0, false, false,
            5000.0, 4800.0, 1400.0,
            None, None, None,
            false, false, false,
        );
        assert_eq!(res1, "excellent");

        // 2. Eval drops from 30.0 to 11.0 (3000 cp -> 1100 cp): still > 10.0 -> excellent
        let res2 = classify_move(
            0.0, 1.0, 1.0, 1.0, false, false,
            3000.0, 2800.0, 1100.0,
            None, None, None,
            false, false, false,
        );
        assert_eq!(res2, "excellent");

        // 3. Eval drops from 50.0 to 0.0 (5000 cp -> 0 cp): 0% retained -> blunder
        let res3 = classify_move(
            0.5, 1.0, 1.0, 0.5, false, false,
            5000.0, 4800.0, 0.0,
            None, None, None,
            false, false, false,
        );
        assert_eq!(res3, "blunder");

        // 4. Eval drops from 20.0 to 8.0 (2000 cp -> 800 cp): 40% retained -> good
        let res4 = classify_move(
            0.01, 1.0, 1.0, 0.99, false, false,
            2000.0, 1800.0, 800.0,
            None, None, None,
            false, false, false,
        );
        assert_eq!(res4, "good");

        // 5. Eval drops from 20.0 to 5.0 (2000 cp -> 500 cp): 25% retained -> inaccuracy
        let res5 = classify_move(
            0.05, 1.0, 1.0, 0.95, false, false,
            2000.0, 1800.0, 500.0,
            None, None, None,
            false, false, false,
        );
        assert_eq!(res5, "inaccuracy");

        // 6. Eval drops from 20.0 to 1.5 (2000 cp -> 150 cp): 7.5% retained -> mistake
        let res6 = classify_move(
            0.3, 1.0, 1.0, 0.7, false, false,
            2000.0, 1800.0, 150.0,
            None, None, None,
            false, false, false,
        );
        assert_eq!(res6, "mistake");
    }

    #[test]
    fn test_standard_thresholds_under_ten_eval() {
        // Standard normal range (+4.0 -> +3.95): 5 cp loss (<= 10 cp) -> best
        let res_best = classify_move(
            0.005, 0.91, 0.91, 0.905, false, false,
            400.0, 390.0, 395.0,
            None, None, None,
            false, false, false,
        );
        assert_eq!(res_best, "best");

        // Standard normal range (+4.0 -> +3.8): 20 cp loss -> excellent
        let res1 = classify_move(
            0.01, 0.91, 0.91, 0.90, false, false,
            400.0, 390.0, 380.0,
            None, None, None,
            false, false, false,
        );
        assert_eq!(res1, "excellent");

        // Standard normal range (+4.0 -> +1.5): 250 cp loss -> mistake
        let res2 = classify_move(
            0.21, 0.91, 0.91, 0.70, false, false,
            400.0, 390.0, 150.0,
            None, None, None,
            false, false, false,
        );
        assert_eq!(res2, "mistake");
    }

    #[test]
    fn test_piece_hanging_deflection_sacrifice_is_brilliant() {
        use shakmaty::fen::Fen;
        use shakmaty::CastlingMode;

        // Position before 26. Qc3 (after 25... Qa2)
        let fen: Fen = "r5k1/1p2Rppp/1p6/8/1P6/B4Q1P/q7/5K2 w - - 0 26".parse().unwrap();
        let pos: Chess = fen.into_position(CastlingMode::Standard).unwrap();

        // 26. Qc3 (f3 -> c3)
        let mv = Move::Normal {
            role: Role::Queen,
            from: Square::F3,
            to: Square::C3,
            capture: None,
            promotion: None,
        };

        let sacrificed = is_sacrifice(&pos, &mv, None);
        assert!(sacrificed, "26. Qc3 should be recognized as a sacrifice (leaving Ba3 under-defended)");

        let classification = classify_move(
            0.0,
            0.95,
            0.90,
            0.95,
            sacrificed,
            false,
            350.0,
            280.0,
            350.0,
            None,
            None,
            None,
            true,
            false,
            false,
        );
        assert_eq!(classification, "brilliant");
    }


    #[test]
    fn test_non_sacrifices_are_not_brilliant() {
        use shakmaty::fen::Fen;
        use shakmaty::CastlingMode;

        // 0. Move 21. Ra1 (Rook battery connecting against Re1)
        let fen_ra1: Fen = "r3q1k1/1pp2ppp/1b6/1p6/1P6/B4Q1P/R2P1PP1/4rRK1 w - - 0 21".parse().unwrap();
        let pos_ra1: Chess = fen_ra1.into_position(CastlingMode::Standard).unwrap();
        let mv_ra1 = Move::Normal {
            role: Role::Rook,
            from: Square::A2,
            to: Square::A1,
            capture: None,
            promotion: None,
        };
        assert!(!is_sacrifice(&pos_ra1, &mv_ra1, None), "21. Ra1 must not be a sacrifice");

        // 1. Move 31. Kg1 (King escaping check)
        // Position before 31. Kg1 (after 30... Qc4+)
        let fen_kg1: Fen = "4r1k1/1R3ppp/1p6/2Q5/2q5/B3Q2P/8/5K2 w - - 1 31".parse().unwrap();
        let pos_kg1: Chess = fen_kg1.into_position(CastlingMode::Standard).unwrap();
        let mv_kg1 = Move::Normal {
            role: Role::King,
            from: Square::F1,
            to: Square::G1,
            capture: None,
            promotion: None,
        };
        assert!(!is_sacrifice(&pos_kg1, &mv_kg1, None), "31. Kg1 must not be a sacrifice");

        // 2. Move 27. Rxb7 (capturing a pawn while Ba3 remains on board)
        let fen_rxb7: Fen = "r4k2/1p2Rppp/1p6/8/1P6/B1Q4P/q7/5K2 w - - 1 27".parse().unwrap();
        let pos_rxb7: Chess = fen_rxb7.into_position(CastlingMode::Standard).unwrap();
        let mv_rxb7 = Move::Normal {
            role: Role::Rook,
            from: Square::E7,
            to: Square::B7,
            capture: Some(Role::Pawn),
            promotion: None,
        };
        assert!(!is_sacrifice(&pos_rxb7, &mv_rxb7, None), "27. Rxb7 must not be a sacrifice");

        // 3. Move 28. Qc5+ (checking while Ba3 remains on board)
        let fen_before_qc5: Fen = "4rk2/1R3ppp/8/1p6/1P6/B1Q4P/q7/5K2 w - - 2 28".parse().unwrap();
        let pos_qc5: Chess = fen_before_qc5.into_position(CastlingMode::Standard).unwrap();
        let mv_qc5 = Move::Normal {
            role: Role::Queen,
            from: Square::C3,
            to: Square::C5,
            capture: None,
            promotion: None,
        };
        assert!(!is_sacrifice(&pos_qc5, &mv_qc5, None), "28. Qc5+ must not be a sacrifice");

        // 4. Move 9. dxc6 (pawn capture trading knights)
        let fen_dxc6: Fen = "r1bqk2r/ppppnppp/1b6/3P4/1P2p3/2N2N2/2PP1PPP/R1BQKB1R w KQkq - 0 9".parse().unwrap();
        let pos_dxc6: Chess = fen_dxc6.into_position(CastlingMode::Standard).unwrap();
        let mv_dxc6 = Move::Normal {
            role: Role::Pawn,
            from: Square::D5,
            to: Square::C6,
            capture: Some(Role::Knight),
            promotion: None,
        };
        assert!(!is_sacrifice(&pos_dxc6, &mv_dxc6, None), "9. dxc6 must not be a sacrifice");

        // 5. Move 15. Qxf5 (queen capturing hanging bishop)
        let fen_qxf5: Fen = "r4rk1/ppp2ppp/1bp5/5b2/1P6/5Q2/1PPPBPPP/R1B2RK1 w - - 1 15".parse().unwrap();
        let pos_qxf5: Chess = fen_qxf5.into_position(CastlingMode::Standard).unwrap();
        let mv_qxf5 = Move::Normal {
            role: Role::Queen,
            from: Square::F3,
            to: Square::F5,
            capture: Some(Role::Bishop),
            promotion: None,
        };
        assert!(!is_sacrifice(&pos_qxf5, &mv_qxf5, None), "15. Qxf5 must not be a sacrifice");
    }

    #[test]
    fn test_full_game_only_qc3_is_brilliant() {
        use shakmaty::san::San;

        let pgn_moves = [
            "e4", "e5", "Nf3", "Nc6", "Nc3", "Bb4", "Nd5", "Ba5", "c3", "Nge7",
            "b4", "Bb6", "a4", "Nxd5", "exd5", "e4", "dxc6", "exf3", "Qxf3", "dxc6",
            "a5", "O-O", "axb6", "Re8+", "Be2", "cxb6", "O-O", "Bf5", "Qxf5", "Rxe2",
            "Qf3", "Qe8", "Ra2", "Re1", "h3", "a5", "Ba3", "axb4", "cxb4", "b5",
            "Ra1", "Rxf1+", "Kxf1", "Qe5", "Re1", "Qd6", "Re3", "Qxd2", "Re7", "Qa2",
            "Qc3", "Kf8", "Rxb7", "Re8", "Qc5+", "Kg8", "Qc1", "Qe6", "Qe3", "Qc4+",
            "Kg1", "Kf8", "Qd2", "Kg8", "Bb2", "Qe6", "Qd7", "Qxd7", "Rxd7", "Re1+",
            "Kh2", "f6", "Bc3", "Rc1", "Bd4", "Rd1", "Rd6", "Kf7", "Bc5", "Rxd6",
            "Bxd6", "Ke6", "Bc5", "h5", "Kg3", "g5", "h4", "Ke5", "hxg5", "fxg5",
            "f4+", "gxf4+", "Kh4", "f3", "gxf3", "Kf4", "Kxh5", "Kxf3", "Kg6", "Ke4",
            "Kf6", "Kd5", "Ke7", "Ke5", "Bd6+", "Kd4", "Kd7", "Kd5", "Bc5", "Kc4",
            "Kxc6", "Kd3", "Kxb5", "Kc3", "Ka5", "Kc4", "Bf8", "Kd5", "b5", "Ke6",
            "b6", "Kd7", "Ka6", "Kc8", "Ka7", "Kd7", "b7", "Ke8", "b8=Q+", "Kd7",
            "Qe5", "Kc8", "Ka6", "Kd7", "Ka5", "Kc6", "Qb5+", "Kc7", "Qe5+", "Kc6",
            "Qc5+", "Kd7", "Qd6+", "Kc8", "Qc6+", "Kd8", "Qb7", "Ke8", "Qe7#",
        ];

        let mut pos = Chess::default();
        let mut brilliant_sacrifices: Vec<(usize, String, String)> = Vec::new();

        for (i, san_str) in pgn_moves.iter().enumerate() {
            let ply = i + 1;
            let move_num = (i / 2) + 1;
            let is_white = i % 2 == 0;
            let san: San = san_str.parse().unwrap();
            let mv = san.to_move(&pos).unwrap();

            let is_sac = is_sacrifice(&pos, &mv, None);
            if is_white && is_sac {
                brilliant_sacrifices.push((ply, format!("{}. {}", move_num, san_str), "White".to_string()));
            }

            pos = pos.play(&mv).unwrap();
        }

        println!("White sacrifices found across game: {:?}", brilliant_sacrifices);
        // Only 26. Qc3 and endgame 55. Bc5 (which is filtered out by already_winning in classify_move) are sacrifices.
        // Verify 21. Ra1, 27. Rxb7, 28. Qc5+, 31. Kg1, 9. dxc6, 15. Qxf5, 18. h3 are NOT sacrifices:
        let sac_moves: Vec<String> = brilliant_sacrifices.iter().map(|s| s.1.clone()).collect();
        assert!(sac_moves.contains(&"26. Qc3".to_string()), "26. Qc3 must be a sacrifice");
        assert!(!sac_moves.contains(&"21. Ra1".to_string()), "21. Ra1 must NOT be a sacrifice");
        assert!(!sac_moves.contains(&"27. Rxb7".to_string()), "27. Rxb7 must NOT be a sacrifice");
        assert!(!sac_moves.contains(&"28. Qc5+".to_string()), "28. Qc5+ must NOT be a sacrifice");
        assert!(!sac_moves.contains(&"31. Kg1".to_string()), "31. Kg1 must NOT be a sacrifice");
        assert!(!sac_moves.contains(&"9. dxc6".to_string()), "9. dxc6 must NOT be a sacrifice");
        assert!(!sac_moves.contains(&"15. Qxf5".to_string()), "15. Qxf5 must NOT be a sacrifice");
        assert!(!sac_moves.contains(&"18. h3".to_string()), "18. h3 must NOT be a sacrifice");

        // Verify classify_move for 26. Qc3 produces "brilliant"
        let qc3_classification = classify_move(
            0.0, 0.95, 0.90, 0.95, true, false,
            350.0, 280.0, 350.0, None, None, None, true, false, false,
        );
        assert_eq!(qc3_classification, "brilliant");

        // Verify classify_move for 55. Bc5 (already winning +30.0) produces "best", not "brilliant"
        let bc5_classification = classify_move(
            0.0, 1.0, 1.0, 1.0, true, false,
            3000.0, 2900.0, 3000.0, None, None, None, true, false, false,
        );
        assert_eq!(bc5_classification, "best");
    }

    #[test]
    fn test_horowitz_mating_sequence_brilliancies() {
        use shakmaty::san::San;

        let pgn_moves = [
            "e4", "e5", "Nc3", "Nc6", "Bc4", "Bc5", "Qg4", "Qf6", "Nd5", "Qxf2+",
            "Kd1", "Kf8", "Nh3", "Qd4", "d3", "Bb6", "Rf1", "Nf6", "Rxf6", "d6",
            "Qxg7+", "Kxg7", "Bh6+", "Kg8", "Rg6+", "hxg6", "Nf6#",
        ];

        let mut pos = Chess::default();
        let mut sacrifices = Vec::new();

        for (i, san_str) in pgn_moves.iter().enumerate() {
            let move_num = (i / 2) + 1;
            let is_white = i % 2 == 0;
            let san: San = san_str.parse().unwrap();
            let mv = san.to_move(&pos).unwrap();

            let mate_played = match move_num {
                10 if is_white => Some(4),
                11 if is_white => Some(3),
                12 if is_white => Some(2),
                13 if is_white => Some(1),
                _ => None,
            };

            let is_sac = is_sacrifice(&pos, &mv, mate_played);
            if is_white && is_sac {
                sacrifices.push(format!("{}. {}", move_num, san_str));
            }

            pos = pos.play(&mv).unwrap();
        }

        println!("Horowitz White sacrifices: {:?}", sacrifices);
        assert!(sacrifices.contains(&"10. Rxf6".to_string()), "10. Rxf6 must be a sacrifice");
        assert!(sacrifices.contains(&"11. Qxg7+".to_string()), "11. Qxg7+ must be a sacrifice");
        assert!(!sacrifices.contains(&"12. Bh6+".to_string()), "12. Bh6+ is not a sacrifice");
        assert!(sacrifices.contains(&"13. Rg6+".to_string()), "13. Rg6+ must be a sacrifice");

        // Verify classify_move for 10. Rxf6 (Rook sacrifice), 11. Qxg7+ (Queen sacrifice), 13. Rg6+ (Rook sacrifice)
        let rxf6_class = classify_move(0.0, 1.0, 0.9, 1.0, true, false, 500.0, 200.0, 500.0, Some(4), Some(6), Some(4), true, false, false);
        assert_eq!(rxf6_class, "brilliant");

        let qxg7_class = classify_move(0.0, 1.0, 1.0, 1.0, true, false, 1500.0, 1200.0, 1500.0, Some(3), Some(5), Some(3), true, false, false);
        assert_eq!(qxg7_class, "brilliant");

        let rg6_class = classify_move(0.0, 1.0, 1.0, 1.0, true, false, 2000.0, 1800.0, 2000.0, Some(1), Some(3), Some(1), true, false, false);
        assert_eq!(rg6_class, "brilliant");
    }

    #[test]
    fn test_user_game_nf7_not_brilliant() {
        use shakmaty::san::San;

        let pgn_moves = [
            "e4", "e5", "Nf3", "Nc6", "Nc3", "Nf6", "Bc4", "b5", "Bb3", "b4",
            "Ng5", "bxc3", "Bxf7+", "Ke7", "Bb3", "cxb2", "Bxb2", "d5", "exd5", "Nb4",
            "d6+", "cxd6", "Nf7", "Qb6", "Nxh8",
        ];

        let mut pos = Chess::default();
        let mut sacrifices = Vec::new();

        for (i, san_str) in pgn_moves.iter().enumerate() {
            let move_num = (i / 2) + 1;
            let is_white = i % 2 == 0;
            let san: San = san_str.parse().unwrap();
            let mv = san.to_move(&pos).unwrap();

            let is_sac = is_sacrifice(&pos, &mv, None);
            if is_white && is_sac {
                sacrifices.push(format!("{}. {}", move_num, san_str));
            }

            pos = pos.play(&mv).unwrap();
        }

        println!("User game White sacrifices: {:?}", sacrifices);
        assert!(!sacrifices.contains(&"12. Nf7".to_string()), "12. Nf7 should NOT be a sacrifice");
    }

    #[test]
    fn test_checkmate_delivered_is_great_or_best() {
        // Only one move mates: is_only_mate = true -> great
        let class_only_mate = classify_move(
            0.0, 1.0, 0.0, 1.0, false, false,
            0.0, 0.0, 0.0,
            Some(1), None, Some(0),
            true, false, true,
        );
        assert_eq!(class_only_mate, "great");

        // Multiple moves mate (Qg4#, Qh8#, Qh6#) -> mate_second is Some(1) -> best
        let class_multi_mate = classify_move(
            0.0, 1.0, 1.0, 1.0, false, false,
            0.0, 0.0, 0.0,
            Some(1), Some(1), Some(0),
            false, false, true,
        );
        assert_eq!(class_multi_mate, "best");
    }

    #[test]
    fn test_top_equivalent_moves_within_point_one_are_best() {
        // cp_loss is 8.0 (<= 10 cp / 0.08 eval delta), not engine's top choice -> best
        let res_near_top = classify_move(
            0.008, 0.85, 0.84, 0.842, false, false,
            300.0, 292.0, 292.0,
            None, None, None,
            false, false, false,
        );
        assert_eq!(res_near_top, "best");

        // cp_loss is 25.0 (> 10 cp, < 35 cp) -> excellent
        let res_excellent = classify_move(
            0.025, 0.85, 0.84, 0.825, false, false,
            300.0, 290.0, 275.0,
            None, None, None,
            false, false, false,
        );
        assert_eq!(res_excellent, "excellent");
    }

    #[test]
    fn test_reciprocal_piece_trade_h6_not_brilliant() {
        use shakmaty::san::San;

        let pgn_moves = [
            "e4", "e5", "Nf3", "Nc6", "Nc3", "Nf6", "Bc4", "Bc5", "Ng5", "O-O",
            "O-O", "Na5", "Na4", "Bxf2+", "Rxf2", "Nxc4", "b3", "h6",
        ];

        let mut pos = Chess::default();
        let mut sacrifices = Vec::new();

        for (i, san_str) in pgn_moves.iter().enumerate() {
            let move_num = (i / 2) + 1;
            let is_white = i % 2 == 0;
            let san: San = san_str.parse().unwrap();
            let mv = san.to_move(&pos).unwrap();

            let is_sac = is_sacrifice(&pos, &mv, None);
            if is_sac {
                sacrifices.push(format!("{}. {}{}", move_num, if is_white { "" } else { ".. " }, san_str));
            }

            pos = pos.play(&mv).unwrap();
        }

        println!("Sacrifices found: {:?}", sacrifices);
        assert!(!sacrifices.contains(&"9. .. h6".to_string()), "9... h6 is a reciprocal piece trade and must NOT be a sacrifice");
    }
}




