"""
backend/analysis.py

Strictly-coded mathematical formulas for chess move evaluation.
All formulas match the spec exactly.
"""

import math
from typing import Optional
import chess


# ---------------------------------------------------------------------------
# Piece values (centipawns) for material counting
# ---------------------------------------------------------------------------
PIECE_VALUES: dict[chess.PieceType, int] = {
    chess.PAWN:   100,
    chess.KNIGHT: 320,
    chess.BISHOP: 330,
    chess.ROOK:   500,
    chess.QUEEN:  900,
    chess.KING:   0,   # King has no material value
}


# ---------------------------------------------------------------------------
# Core formulas
# ---------------------------------------------------------------------------

def win_prob(cp: float) -> float:
    """
    Win probability from centipawns (White's perspective).
    P = 1 / (1 + exp(-0.004 * cp))
    
    Args:
        cp: Centipawn evaluation from White's perspective.
            Positive = White winning, negative = Black winning.
    Returns:
        Win probability in [0, 1] for the side with the advantage.
    """
    # Clamp to avoid overflow in exp
    cp = max(-3000.0, min(3000.0, float(cp)))
    return 1.0 / (1.0 + math.exp(-0.004 * cp))


def game_accuracy(deltas: list[float]) -> float:
    """
    Chess.com CAPS-style game accuracy percentage.
    Calculates a non-linear accuracy score per move and averages them, 
    applying a harsher penalty to games with multiple blunders.
    """
    if not deltas:
        return 100.0
        
    move_accs = []
    for d in deltas:
        if d <= 0.0:
            move_accs.append(100.0)
        elif d <= 0.02:
            move_accs.append(100.0 - (d / 0.02) * 5.0)  # 100 to 95
        elif d <= 0.05:
            move_accs.append(95.0 - ((d - 0.02) / 0.03) * 15.0)  # 95 to 80
        elif d <= 0.10:
            move_accs.append(80.0 - ((d - 0.05) / 0.05) * 35.0)  # 80 to 45
        elif d <= 0.20:
            move_accs.append(45.0 - ((d - 0.10) / 0.10) * 35.0)  # 45 to 10
        elif d <= 0.30:
            move_accs.append(10.0 - ((d - 0.20) / 0.10) * 10.0)  # 10 to 0
        else:
            move_accs.append(0.0)
            
    # Harsher penalty for games with many bad moves: apply a dynamic exponent based on error counts.
    avg_acc = sum(move_accs) / len(move_accs)
    
    num_major = sum(1 for d in deltas if d >= 0.20)
    num_minor = sum(1 for d in deltas if 0.10 <= d < 0.20)
    exponent = 1.04 + 0.192 * num_major + 0.06 * num_minor

    normalized = (avg_acc / 100.0)
    final_acc = (normalized ** exponent) * 100.0
    return max(0.0, min(100.0, final_acc))


def material_value(board: chess.Board, color: chess.Color) -> int:
    """Sum of all piece values for a given color (excluding king)."""
    total = 0
    for piece_type, value in PIECE_VALUES.items():
        total += len(board.pieces(piece_type, color)) * value
    return total


def get_max_loss_for_move(board: chess.Board, move: chess.Move) -> int:
    """Calculate the maximum net material loss the opponent can inflict after this move."""
    captured_piece = board.piece_at(move.to_square)
    if captured_piece:
        material_won = PIECE_VALUES.get(captured_piece.piece_type, 0)
    elif board.is_en_passant(move):
        material_won = PIECE_VALUES[chess.PAWN]
    else:
        material_won = 0

    after_board = board.copy()
    after_board.push(move)

    opponent_captures = [m for m in after_board.legal_moves if after_board.is_capture(m)]
    max_loss = 0

    for op_move in opponent_captures:
        target_piece = after_board.piece_at(op_move.to_square)
        if target_piece:
            target_value = PIECE_VALUES.get(target_piece.piece_type, 0)
        else:
            if after_board.is_en_passant(op_move):
                target_value = PIECE_VALUES[chess.PAWN]
            else:
                continue

        recapture_board = after_board.copy()
        recapture_board.push(op_move)
        
        # Find the maximum value we can capture anywhere on the board
        max_recapture_value = 0
        for my_cap in recapture_board.legal_moves:
            if recapture_board.is_capture(my_cap):
                cap_target = recapture_board.piece_at(my_cap.to_square)
                if cap_target:
                    max_recapture_value = max(max_recapture_value, PIECE_VALUES.get(cap_target.piece_type, 0))
                elif recapture_board.is_en_passant(my_cap):
                    max_recapture_value = max(max_recapture_value, PIECE_VALUES[chess.PAWN])

        # If we can capture an equal or more valuable piece, it's a trade/fork, not a sacrifice
        net_loss = target_value - max_recapture_value
        if net_loss < 0:
            net_loss = 0
            
        max_loss = max(max_loss, net_loss - material_won)
        
    return max_loss


def is_sacrifice(board: chess.Board, move: chess.Move) -> bool:
    """
    Detect if a move results in a material sacrifice or exchange disadvantage.
    
    A move is a sacrifice if the opponent has a legal capture that results in
    a net material disadvantage for us, EVEN AFTER accounting for any material
    we just captured on this turn.
    
    Args:
        board: The board BEFORE the move is played.
        move:  The move to evaluate.
    Returns:
        True if the move leaves material in a sacrifice state.
    """
    # If the opponent is forced to capture (has only one legal move and it's a capture),
    # it is an involuntary sacrifice/sequence, so we do not count it as a sacrifice.
    after_board = board.copy()
    after_board.push(move)
    opponent_moves = list(after_board.legal_moves)
    if len(opponent_moves) == 1:
        forced_move = opponent_moves[0]
        if after_board.is_capture(forced_move):
            return False

    actual_max_loss = get_max_loss_for_move(board, move)
    
    if actual_max_loss >= 200:
        # 0. Check if the piece we are moving was ALREADY under a severe LEAGAL threat
        mover_piece = board.piece_at(move.from_square)
        before_loss_of_mover = 0
        if mover_piece and not board.is_check():
            mover_value = PIECE_VALUES.get(mover_piece.piece_type, 0)
            null_board = board.copy()
            null_board.push(chess.Move.null())
            for op_move in null_board.legal_moves:
                if op_move.to_square == move.from_square:
                    op_piece = null_board.piece_at(op_move.from_square)
                    op_val = PIECE_VALUES.get(op_piece.piece_type, 0) if op_piece else 0
                    if board.attackers(board.turn, move.from_square):
                        loss = max(0, mover_value - op_val)
                    else:
                        loss = mover_value
                    before_loss_of_mover = max(before_loss_of_mover, loss)

        # Prevent "escaping" from being flagged as a sacrifice.
        if before_loss_of_mover > actual_max_loss:
            return False

        # Verify it was a DELIBERATE choice to lose material.
        # If every legal move results in losing material, it's a forced loss, not a sacrifice.
        for alt_move in board.legal_moves:
            if alt_move == move:
                continue
            alt_loss = get_max_loss_for_move(board, alt_move)
            if alt_loss < 50:
                # We FOUND a safe move that doesn't lose material!
                # This means our sacrifice was a CHOICE.
                return True
                
        # If we get here, every legal move lost >= 50 material. It was forced!
        return False

    return False


def classify_move(
    delta: float,
    p_best: float,
    p_second_best: float,
    p_played: float,
    sacrificed: bool,
    is_book: bool,
    cp_best: float,
    cp_second: float,
    cp_played: float,
    mate_best: Optional[int] = None,
    mate_played: Optional[int] = None,
    is_engine_top_choice: bool = False,
) -> str:
    """
    Classify a chess move based on win probability delta and special conditions.
    
    Move Classifications (Delta = P_best - P_played):
      Book:      move exists in opening database
      Brilliant: delta < 0.02 AND is_sacrifice AND p_played >= 0.45
      Great (!): delta < 0.02 AND cp_best > 0.0 AND cp_second <= 0.0
      Best:      delta == 0
      Excellent: delta < 0.02
      Good:      0.02 <= delta < 0.05
      Inaccuracy:0.05 <= delta < 0.10
      Mistake:   0.10 <= delta < 0.20
      Blunder:   delta >= 0.20

    Args:
        delta:         P_best - P_played  (always >= 0)
        p_best:        Win probability of the best move
        p_second_best: Win probability of the second-best move
        p_played:      Win probability of the actually played move
        sacrificed:    True if the move is a material sacrifice
        is_book:       True if the move is in the opening database
        cp_best:       Centipawn evaluation of the best move
        cp_second:     Centipawn evaluation of the second-best move
    Returns:
        Classification string.
    """

    # Force delta to 0.0 if the user played the exact move the engine recommended
    if is_engine_top_choice:
        delta = 0.0
        
    # Brilliant check first so that a brilliant theory move gets the 'brilliant' badge
    # But only if we are not continuing an already existing winning mating sequence.
    is_continuing_mate = (mate_best is not None and mate_best > 0)
    if not is_continuing_mate and (sacrificed and p_played >= 0.45 and (cp_best - cp_played) <= 50.0):
        return "brilliant"

    if is_book:
        return "theory"

    # If it is the engine's top choice, it must be brilliant, theory, great, or best
    if is_engine_top_choice:
        if (delta < 0.02
                and cp_best > 0.0
                and cp_second <= 0.0):
            return "great"
        return "best"

    # 1. Explicit Mate Handling
    if mate_best is not None or mate_played is not None:
        if mate_best is not None and mate_played is not None:
            if mate_best > 0 and mate_played > 0:
                # We had mate, and we still have mate.
                # A perfect move reduces the mate distance by exactly 1 move.
                optimal_mate = mate_best - 1
                diff = mate_played - optimal_mate
                if diff <= 0:
                    return "best"
                elif 1 <= diff <= 7:
                    return "excellent"
                else:
                    return "good"
            elif mate_best < 0 and mate_played < 0:
                # We are getting mated.
                # Closer to 0 means a faster mate for the opponent (worse for us).
                optimal_defense = mate_best + 1
                diff = mate_played - optimal_defense
                if diff <= 0:
                    return "best"
                elif 1 <= diff <= 7:
                    return "excellent"
                else:
                    return "good"
            elif mate_best > 0 and mate_played < 0:
                # We had forced mate, but blundered into getting mated.
                return "blunder"
            elif mate_best < 0 and mate_played > 0:
                # Engine horizon anomaly: we were getting mated, but found a mate.
                return "best"
        
        elif mate_best is not None and mate_played is None:
            if mate_best > 0:
                # We had a forced mate, but lost it. Evaluate based on remaining advantage.
                if cp_played > 500:
                    return "good"
                elif cp_played > 200:
                    return "inaccuracy"
                else:
                    return "mistake"
            else:
                # We were getting mated, but escaped.
                return "best"

        elif mate_best is None and mate_played is not None:
            if mate_played < 0:
                # We allowed the opponent a forced mate.
                if cp_best > -400.0:
                    return "blunder"
                elif cp_best > -1500.0:
                    return "mistake"
                return "inaccuracy"
            else:
                # We found a mate that the engine didn't see initially.
                return "best"

    # Great (!): only move that doesn't lose the advantage
    if (delta < 0.02
            and cp_best > 0.0
            and cp_second <= 0.0):
        return "great"

    # Best: evaluate after Brilliant/Great
    if delta == 0.0:
        return "best"

    # Standard classifications by delta
    if delta < 0.02:
        return "excellent"
    if delta < 0.05:
        return "good"
    if delta < 0.10:
        return "inaccuracy"

    if delta < 0.20:
        return "mistake"
        
    return "blunder"


# ---------------------------------------------------------------------------
# Score normalization helpers
# ---------------------------------------------------------------------------

def cp_from_score(score: Optional["chess.engine.Score"], mate_score: int = 10000) -> float:
    """
    Convert a python-chess engine Score to centipawns (clamped).
    Mate scores map to ±mate_score.
    The returned value is from the perspective of the side to move (relative).
    """
    if score is None:
        return 0.0
    cp = score.score(mate_score=mate_score)
    if cp is None:
        return float(mate_score) if score.is_mate() and score.mate() > 0 else float(-mate_score)
    return float(cp)


def get_mate_moves(score_mate: Optional[int], color: chess.Color) -> Optional[int]:
    """
    Convert score_mate (from White's perspective, in moves) into the number of full MOVES
    to mate from the perspective of the given color.
    Positive means `color` is delivering mate. Negative means `color` is getting mated.
    """
    if score_mate is None:
        return None
    return score_mate if color == chess.WHITE else -score_mate


def accuracy_to_rating(accuracy: float) -> int:
    """
    Empirical mapping of accuracy percentage to estimated Elo rating.
    Maps 65% to ~600 and 100% to ~4000 to match chess.com CAPS distributions.
    """
    if accuracy <= 50:
        return 100
    elif accuracy <= 65:
        # 50 -> 100, 65 -> 600
        return int(100 + (accuracy - 50) * (500.0 / 15.0))
    elif accuracy <= 75:
        # 65 -> 600, 75 -> 1200
        return int(600 + (accuracy - 65) * 60.0)
    elif accuracy <= 85:
        # 75 -> 1200, 85 -> 1800
        return int(1200 + (accuracy - 75) * 60.0)
    elif accuracy <= 95:
        # 85 -> 1800, 95 -> 2800
        return int(1800 + (accuracy - 85) * 100.0)
    else:
        # 95 -> 2800, 100 -> 4000
        return int(2800 + (accuracy - 95) * 240.0)

def accuracy_to_badge(accuracy: float) -> str:
    """Map a phase accuracy percentage to a classification badge."""
    if accuracy >= 95.0:
        return "best"
    if accuracy >= 85.0:
        return "excellent"
    if accuracy >= 70.0:
        return "good"
    if accuracy >= 50.0:
        return "inaccuracy"
    if accuracy >= 30.0:
        return "mistake"
    return "blunder"

def build_accuracy_report(
    move_records: list[dict],
) -> dict:
    """
    Compute per-side accuracy and classification counts from a list of move records.
    
    Each record must have: {'color': bool, 'delta': float, 'classification': str}
    chess.WHITE = True, chess.BLACK = False
    
    Returns:
        {
          'white': {'accuracy': float, 'estimated_rating': int, 'counts': {...}},
          'black': {'accuracy': float, 'estimated_rating': int, 'counts': {...}},
        }
    """
    labels = ["brilliant", "great", "best", "excellent", "good",
              "theory", "inaccuracy", "mistake", "blunder"]

    def _side_report(color: bool) -> dict:
        records = [r for r in move_records if r["color"] == color]
        deltas = [0.0 if r["classification"] == "theory" else r["delta"] for r in records]
        accuracy = game_accuracy(deltas)
        counts = {lbl: 0 for lbl in labels}
        for r in records:
            c = r["classification"]
            if c in counts:
                counts[c] += 1
                
        raw_rating = accuracy_to_rating(accuracy)
        
        # Base rating is capped by game complexity (approximated by game length)
        num_moves = len(records)
        base_cap = 3200
        if num_moves <= 10:
            base_cap = 2000
        elif num_moves <= 15:
            base_cap = 2500
        elif num_moves <= 25:
            base_cap = 3000
            
        capped_rating = min(raw_rating, base_cap)
        
        # Calculate Phase badges
        phase_badges = {}
        for phase in ["opening", "middlegame", "endgame"]:
            phase_records = [r for r in records if r.get("phase") == phase]
            if not phase_records:
                continue
            
            p_deltas = [0.0 if r["classification"] == "theory" else r["delta"] for r in phase_records]
            p_accuracy = game_accuracy(p_deltas)
            base_badge = accuracy_to_badge(p_accuracy)
            
            p_classifications = [r["classification"] for r in phase_records]
            has_brilliant = "brilliant" in p_classifications
            has_great = "great" in p_classifications
            
            if p_accuracy >= 95.0 and has_brilliant:
                base_badge = "brilliant"
            elif p_accuracy == 100.0 or (p_accuracy >= 95.0 and has_great) or (p_accuracy >= 85.0 and has_brilliant):
                base_badge = "great"
            
            phase_badges[phase] = base_badge
            
        # The only way to break the baseline cap and reach 3500-4000 is to find 
        # incredibly difficult, highly evaluated moves across a full phase.
        brilliant_bonus = sum(500 for b in phase_badges.values() if b == "brilliant")
        great_bonus = sum(100 for b in phase_badges.values() if b == "great")
        
        final_rating = capped_rating + brilliant_bonus + great_bonus
        
        # Hard cap at 4000
        final_rating = min(final_rating, 4000)
        
        # Round to the nearest 100
        rounded_rating = int(round(final_rating, -2))
        
        return {
            "accuracy": round(accuracy, 1),
            "estimated_rating": rounded_rating,
            "counts": counts,
            "phases": phase_badges
        }

    return {
        "white": _side_report(chess.WHITE),
        "black": _side_report(chess.BLACK),
    }


def generate_null_move_fen(fen: str) -> str:
    """
    Flip the active turn character ('w' to 'b', or 'b' to 'w') and
    clear any active en passant target square (replacing that field with a '-')
    to maintain a structurally valid FEN string.
    """
    parts = fen.split()
    if len(parts) < 4:
        return fen
    # Flip turn
    parts[1] = 'b' if parts[1] == 'w' else 'w'
    # Clear en passant target square
    parts[3] = '-'
    return ' '.join(parts)

