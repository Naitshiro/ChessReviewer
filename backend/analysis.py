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


def is_sacrifice(board: chess.Board, move: chess.Move) -> bool:
    """
    Detect if a move constitutes a material sacrifice on the exact ply.
    
    A move is a sacrifice if the opponent has a legal capture of our moved piece,
    and either we cannot recapture (leading to a net material loss), or we can recapture
    but the exchange results in a net material loss for us on that square.
    
    Args:
        board: The board BEFORE the move is played.
        move:  The move to evaluate.
    Returns:
        True if the move is a material sacrifice.
    """
    mover_piece = board.piece_at(move.from_square)
    if mover_piece is None:
        return False
    mover_value = PIECE_VALUES.get(mover_piece.piece_type, 0)
    mover_color = mover_piece.color

    # Value of captured piece (0 if no capture)
    captured_piece = board.piece_at(move.to_square)
    captured_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0

    # En passant capture
    if board.is_en_passant(move):
        captured_value = PIECE_VALUES[chess.PAWN]

    after_board = board.copy()
    after_board.push(move)

    # Find all legal opponent captures of our moved piece
    opponent_captures = [m for m in after_board.legal_moves if m.to_square == move.to_square]
    if not opponent_captures:
        return False

    # For each legal capture, check if it leads to a sacrifice
    for op_move in opponent_captures:
        op_piece = after_board.piece_at(op_move.from_square)
        op_value = PIECE_VALUES.get(op_piece.piece_type, 0) if op_piece else 0

        # Check if we can recapture
        recapture_board = after_board.copy()
        recapture_board.push(op_move)
        recaptures = [m for m in recapture_board.legal_moves if m.to_square == move.to_square]

        if not recaptures:
            # We cannot recapture, so we lose the piece for just the captured_value
            if mover_value > captured_value:
                return True
        else:
            # We can recapture, so the best we can get is captured_value + op_value
            if captured_value + op_value < mover_value:
                return True

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

    # Best: always evaluate this first
    if delta == 0.0:
        return "best"

    # Brilliant (!!): strict special case
    if (delta < 0.02
            and sacrificed
            and p_played >= 0.45):
        return "brilliant"

    # Great (!): only move that doesn't lose the advantage
    if (delta < 0.02
            and cp_best > 0.0
            and cp_second <= 0.0):
        return "great"

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
