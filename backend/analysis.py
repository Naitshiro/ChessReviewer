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
    CAPS2-style game accuracy percentage.
    Accuracy = 100 * (1 - tanh(2.5 * mean(deltas)))
    
    Args:
        deltas: List of (P_best - P_played) values for each move.
    Returns:
        Accuracy in [0, 100].
    """
    if not deltas:
        return 100.0
    avg = sum(deltas) / len(deltas)
    return 100.0 * (1.0 - math.tanh(2.5 * avg))


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
        op_piece = after_board.piece_at(op_move.from_square)
        op_value = PIECE_VALUES.get(op_piece.piece_type, 0) if op_piece else 0

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
        recaptures = [m for m in recapture_board.legal_moves if m.to_square == op_move.to_square]

        if recaptures:
            net_loss = target_value - op_value
        else:
            if target_value <= PIECE_VALUES[chess.PAWN]:
                net_loss = 0
            else:
                net_loss = target_value
                
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
    actual_max_loss = get_max_loss_for_move(board, move)
    
    if actual_max_loss >= 50:
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
    if is_book:
        return "book"

    # Brilliant (!!): strict special case
    if (delta < 0.05
            and sacrificed
            and p_played >= 0.45):
        return "brilliant"

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


def build_accuracy_report(
    move_records: list[dict],
) -> dict:
    """
    Compute per-side accuracy and classification counts from a list of move records.
    
    Each record must have: {'color': bool, 'delta': float, 'classification': str}
    chess.WHITE = True, chess.BLACK = False
    
    Returns:
        {
          'white': {'accuracy': float, 'counts': {...}},
          'black': {'accuracy': float, 'counts': {...}},
        }
    """
    labels = ["brilliant", "great", "best", "excellent", "good",
              "inaccuracy", "mistake", "blunder", "book"]

    def _side_report(color: bool) -> dict:
        records = [r for r in move_records if r["color"] == color]
        deltas = [r["delta"] for r in records if r["classification"] not in ("book",)]
        accuracy = game_accuracy(deltas)
        counts = {lbl: 0 for lbl in labels}
        for r in records:
            c = r["classification"]
            if c in counts:
                counts[c] += 1
        return {"accuracy": round(accuracy, 1), "counts": counts}

    return {
        "white": _side_report(chess.WHITE),
        "black": _side_report(chess.BLACK),
    }
