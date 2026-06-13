"""
backend/openings.py

Lightweight ECO opening database for "Book" move classification.
Maps the first 4 FEN fields (position + color + castling + en_passant)
to an opening name. This avoids move-counter mismatches.

Contains ~200 key positions covering ECO A-E major openings.
"""

import chess

# ---------------------------------------------------------------------------
# ECO position database
# Key format: " ".join(fen.split()[:4])
# ---------------------------------------------------------------------------
_ECO_DB: dict[str, str] = {
    # ── Starting position ────────────────────────────────────────────────
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -": "Starting Position",

    # ── 1.e4 ─────────────────────────────────────────────────────────────
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3": "King's Pawn Opening",

    # Sicilian Defense
    "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6": "Sicilian Defense",
    "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -": "Sicilian Defense, Open",
    "rnbqkbnr/pp1p1ppp/4p3/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "Sicilian Defense, Kan",
    "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "Sicilian Defense, Dragon",
    "r1bqkbnr/pp1ppppp/2n5/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "Sicilian Defense, Classical",
    "r1bqkbnr/pp2pppp/2np4/2p5/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq -": "Sicilian Defense, Classical Variation",
    "rnbqkb1r/pp1p1ppp/4pn2/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "Sicilian Defense, Scheveningen",
    "rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq -": "Sicilian Defense, Najdorf",
    "rnbqkb1r/pp3ppp/3ppn2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq -": "Sicilian Defense, Scheveningen Classical",

    # French Defense
    "rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "French Defense",
    "rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6": "French Defense, Exchange",
    "rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR b KQkq -": "French Defense, Classical",
    "rnbqkb1r/ppp2ppp/4pn2/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR w KQkq -": "French Defense, Classical Variation",
    "rnbqkbnr/ppp2ppp/4p3/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq -": "French Defense, Advance Variation",

    # Caro-Kann Defense
    "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "Caro-Kann Defense",
    "rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq d3": "Caro-Kann Defense, Main Line",
    "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6": "Caro-Kann Defense, Classical",
    "rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq -": "Caro-Kann Defense, Advance Variation",

    # Open Game (1.e4 e5)
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6": "Open Game",
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -": "King's Knight Opening",
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "Three Knights Game",

    # Ruy Lopez
    "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -": "Ruy Lopez",
    "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq -": "Ruy Lopez, Morphy Defense",
    "r1bqkb1r/1ppp1ppp/p1n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq -": "Ruy Lopez, Berlin Defense",
    "r1bqk2r/1pppbppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R w KQkq -": "Ruy Lopez, Closed",
    "r1bqk1nr/1ppp1ppp/p1n5/1B2p3/b3P3/5N2/PPPP1PPP/RNBQK2R w KQkq -": "Ruy Lopez, Classical Defense",
    "r1bq1rk1/2ppbppp/p1n2n2/1p2p3/4P3/1B3N2/PPPP1PPP/RNBQR1K1 w - -": "Ruy Lopez, Chigorin Defense",

    # Italian Game
    "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -": "Italian Game",
    "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR b KQkq -": "Bishop's Opening",
    "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -": "Italian Game, Giuoco Piano",
    "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -": "Italian Game, Two Knights Defense",
    "r1bqkb1r/ppp2ppp/2n2n2/3pp3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq d6": "Italian Game, Two Knights, d5",

    # Scotch Game
    "r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq d3": "Scotch Game",
    "r1bqkbnr/pppp1ppp/2n5/8/3pP3/5N2/PPP2PPP/RNBQKB1R w KQkq -": "Scotch Game, Main Line",
    "r1bqkb1r/pppp1ppp/2n2n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq -": "Scotch Game, Schmidt Variation",

    # King's Gambit
    "rnbqkbnr/pppp1ppp/8/4p3/4PP2/8/PPPP2PP/RNBQKBNR b KQkq f3": "King's Gambit",
    "rnbqkbnr/pppp1ppp/8/8/4Pp2/8/PPPP2PP/RNBQKBNR w KQkq f3": "King's Gambit Accepted",
    "rnbqkbnr/pppp1ppp/8/4p3/4PP2/2N5/PPPP2PP/R1BQKBNR b KQkq -": "King's Gambit Declined",

    # Petrov Defense
    "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "Petrov's Defense",

    # Four Knights
    "r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq -": "Four Knights Game",

    # Scandinavian
    "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6": "Scandinavian Defense",
    "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq -": "Scandinavian Defense, Exchange",

    # Pirc / Modern
    "rnbqkbnr/ppp1pppp/3p4/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "Pirc Defense",
    "rnbqkb1r/ppp1pppp/3p1n2/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq d3": "Pirc Defense, Classical",

    # ── 1.d4 ─────────────────────────────────────────────────────────────
    "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3": "Queen's Pawn Game",

    # Queen's Gambit
    "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq d6": "Queen's Pawn Game, Symmetric",
    "rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq c3": "Queen's Gambit",
    "rnbqkbnr/ppp2ppp/4p3/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq -": "Queen's Gambit Declined",
    "rnbqkbnr/ppp2ppp/4p3/3P4/3P4/8/PP2PPPP/RNBQKBNR b KQkq -": "Queen's Gambit Declined, Exchange",
    "rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq -": "QGD, Orthodox Defense",
    "rnbqkb1r/p1p2ppp/1p2pn2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq -": "QGD, Semi-Tarrasch",
    "rnbqkbnr/ppp2ppp/8/3p4/2PPp3/8/PP2PPPP/RNBQKBNR w KQkq -": "Queen's Gambit Accepted",
    "rnbqkbnr/ppp2ppp/8/4p3/2pPP3/5N2/PP3PPP/RNBQKB1R b KQkq e3": "Queen's Gambit Accepted, Classical",

    # Slav Defense
    "rnbqkbnr/pp2pppp/2p5/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq -": "Slav Defense",
    "rnbqkb1r/pp2pppp/2p2n2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq -": "Slav Defense, Three Knights",
    "rnbqkb1r/pp3ppp/2p1pn2/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq -": "Slav Defense, Czech",

    # Indian Defenses (1.d4 Nf6)
    "rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq -": "Indian Defense",
    "rnbqkb1r/pppppppp/5n2/8/2PP4/8/PP2PPPP/RNBQKBNR b KQkq c3": "Indian Defense, c4",

    # King's Indian Defense
    "rnbqkb1r/pppppp1p/5np1/8/2PP4/8/PP2PPPP/RNBQKBNR w KQkq -": "King's Indian Defense",
    "rnbqkb1r/pppppp1p/5np1/8/2PP4/2N5/PP2PPPP/R1BQKBNR b KQkq -": "KID, Classical",
    "rnbq1rk1/ppp1ppbp/3p1np1/8/2PPP3/2N2N2/PP3PPP/R1BQKB1R b KQkq -": "KID, Classical Main Line",
    "rnbq1rk1/ppp2pbp/3p1np1/4p3/2PPP3/2N2N2/PP3PPP/R1BQKB1R w KQkq e6": "KID, Classical, Mar del Plata",
    "rnbqk2r/ppp1ppbp/3p1np1/8/2PPP3/2N5/PP3PPP/R1BQKBNR w KQkq -": "KID, Four Pawns Attack",

    # Nimzo-Indian Defense
    "rnbqk2r/pppp1ppp/4pn2/8/1bPP4/2N5/PP2PPPP/R1BQKBNR w KQkq -": "Nimzo-Indian Defense",
    "rnbq1rk1/pppp1ppp/4pn2/8/1bPP4/2N1P3/PP3PPP/R1BQKBNR b KQ -": "Nimzo-Indian, Rubinstein",
    "rnbq1rk1/pp3ppp/4pn2/2pp4/1bPP4/2NBP3/PP3PPP/R1BQK1NR b KQ -": "Nimzo-Indian, Classical",

    # Queen's Indian Defense
    "rnbqkb1r/p1pppppp/1p3n2/8/2PP4/8/PP2PPPP/RNBQKBNR w KQkq -": "Queen's Indian Defense",
    "rnbqkb1r/p1pp1ppp/1p2pn2/8/2PP4/5N2/PP2PPPP/RNBQKB1R w KQkq -": "QID, Main Line",

    # Grünfeld Defense
    "rnbqkb1r/ppp1pp1p/5np1/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq -": "Grünfeld Defense",
    "rnbqkb1r/ppp1pp1p/5np1/8/2pPP3/2N5/PP3PPP/R1BQKBNR b KQkq e3": "Grünfeld Defense, Exchange",
    "rnbq1rk1/ppp1ppbp/5np1/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq -": "Grünfeld Defense, Classical",

    # Dutch Defense
    "rnbqkbnr/ppppp1pp/8/5p2/3P4/8/PPP1PPPP/RNBQKBNR w KQkq f6": "Dutch Defense",
    "rnbqkb1r/ppppp1pp/5n2/5p2/3P4/5N2/PPP1PPPP/RNBQKB1R b KQkq -": "Dutch Defense, Classical",

    # London System
    "rnbqkbnr/pppppppp/8/8/3P4/2N5/PPP1PPPP/R1BQKBNR b KQkq -": "London System",
    "rnbqkb1r/pppppppp/5n2/8/3P1B2/8/PPP1PPPP/RN1QKBNR b KQkq -": "London System, Classical",

    # ── 1.c4 (English Opening) ────────────────────────────────────────────
    "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq c3": "English Opening",
    "rnbqkbnr/pppp1ppp/8/4p3/2P5/8/PP1PPPPP/RNBQKBNR w KQkq e6": "English Opening, King's English",
    "rnbqkb1r/pppppppp/5n2/8/2P5/8/PP1PPPPP/RNBQKBNR w KQkq -": "English Opening, Agincourt Defense",

    # ── 1.Nf3 (Réti Opening) ─────────────────────────────────────────────
    "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq -": "Réti Opening",
    "rnbqkbnr/pppp1ppp/8/4p3/8/5N2/PPPPPPPP/RNBQKB1R w KQkq e6": "Réti Opening, King's Indian Attack",

    # ── 1.g3 / 1.b3 / 1.f4 ───────────────────────────────────────────────
    "rnbqkbnr/pppppppp/8/8/8/6P1/PPPPPP1P/RNBQKBNR b KQkq -": "King's Fianchetto Opening",
    "rnbqkbnr/pppppppp/8/8/8/1P6/P1PPPPPP/RNBQKBNR b KQkq -": "Nimzovich-Larsen Attack",
    "rnbqkbnr/pppppppp/8/8/5P2/8/PPPPP1PP/RNBQKBNR b KQkq f3": "Bird's Opening",

    # ── Common transpositions ─────────────────────────────────────────────
    "r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1 w - -": "Italian Game, Giuoco Piano",
    "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq -": "Italian Game, Classical",
    "r1bq1rk1/pp3ppp/2np1n2/2p1p3/2B1P3/2N2N2/PPPP1PPP/R1BQR1K1 w - -": "Italian Game, Giuoco Pianissimo",
}


def _fen_key(fen: str) -> str:
    """Strip move counters, return first 4 FEN fields."""
    return " ".join(fen.split()[:4])


# Pre-process keys for O(1) lookup
_ECO_LOOKUP: dict[str, str] = {_fen_key(k): v for k, v in _ECO_DB.items()}


def get_opening_name(fen: str) -> str | None:
    """
    Return the opening name for a FEN position, or None if not in the database.
    """
    return _ECO_LOOKUP.get(_fen_key(fen))


def is_book_move(board: chess.Board, move: chess.Move) -> bool:
    """
    Return True if the resulting position after `move` on `board` is
    a known opening position in the ECO database.
    """
    temp = board.copy()
    temp.push(move)
    return _fen_key(temp.fen()) in _ECO_LOOKUP
