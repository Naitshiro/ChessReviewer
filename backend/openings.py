"""
backend/openings.py

Loads ECO opening database for "Theory" move classification
using the eco_interpolated.json file.
Maps the first 4 FEN fields (position + color + castling + en_passant)
to an opening name. This avoids move-counter mismatches.
"""

import json
import chess
import re
from pathlib import Path

def _fen_key(fen: str) -> str:
    """Strip move counters and en-passant, return first 3 FEN fields."""
    return " ".join(fen.split()[:3])

def _parse_san_sequence(moves_str: str) -> tuple[str, ...]:
    tokens = moves_str.split()
    san_moves = []
    for t in tokens:
        if re.match(r'^\d+\.+', t):
            continue
        san_moves.append(t)
    return tuple(san_moves)

# Load ECO database from root
_ECO_LOOKUP: dict[str, str] = {}
_ECO_PREFIXES: set[tuple[str, ...]] = set()
_ECO_FILE = Path(__file__).parent / "eco_interpolated.json"
if not _ECO_FILE.exists():
    _ECO_FILE = Path(__file__).parent.parent / "eco_interpolated.json"

if _ECO_FILE.exists():
    with open(_ECO_FILE, "r", encoding="utf-8") as f:
        _data = json.load(f)
        for fen_str, info in _data.items():
            name = info.get("name", "Unknown Opening")
            _ECO_LOOKUP[_fen_key(fen_str)] = name
            
            seq = _parse_san_sequence(info.get("moves", ""))
            for i in range(1, len(seq) + 1):
                _ECO_PREFIXES.add(seq[:i])

def get_opening_name(fen: str) -> str | None:
    """
    Return the opening name for a FEN position, or None if not in the database.
    """
    return _ECO_LOOKUP.get(_fen_key(fen))

def is_book_sequence(san_history: list[str]) -> bool:
    """
    Return True if the exact sequence of SAN moves so far is a prefix
    of any known opening line in the ECO database.
    """
    return tuple(san_history) in _ECO_PREFIXES

# Predefined openings to practice
PRACTICE_OPENINGS = [
    {
        "id": "ruy_lopez",
        "name": "Ruy Lopez (Spanish Opening)",
        "desc": "One of the oldest and most classical openings. Targets the e5 pawn and fights for the center.",
        "moves": ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"],
        "sans": ["1. e4 e5", "2. Nf3 Nc6", "3. Bb5"],
        "startFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    },
    {
        "id": "sicilian_najdorf",
        "name": "Sicilian Defense (Najdorf)",
        "desc": "The Najdorf is a sharp, double-edged variation of the Sicilian. Extremely popular among world champions.",
        "moves": ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "a7a6"],
        "sans": ["1. e4 c5", "2. Nf3 d6", "3. d4 cxd4", "4. Nxd4 Nf6", "5. Nc3 a6"],
        "startFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    },
    {
        "id": "queens_gambit",
        "name": "Queen's Gambit Accepted",
        "desc": "White sacrifices a wing pawn temporarily to gain central control. Black accepts the gambit.",
        "moves": ["d2d4", "d5", "c2c4", "d5c4"],
        "sans": ["1. d4 d5", "2. c4 dxc4"],
        "startFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    },
    {
        "id": "caro_kann",
        "name": "Caro-Kann Defense",
        "desc": "A solid and resilient defensive system for Black, aiming for a favorable pawn structure.",
        "moves": ["e2e4", "c7c6", "d2d4", "d5"],
        "sans": ["1. e4 c6", "2. d4 d5"],
        "startFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    },
    {
        "id": "french_defense",
        "name": "French Defense",
        "desc": "A counter-attacking opening for Black, creating a strong pawn chain but temporarily blocking the c8 bishop.",
        "moves": ["e2e4", "e7e6", "d2d4", "d5"],
        "sans": ["1. e4 e6", "2. d4 d5"],
        "startFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    },
    {
        "id": "italian_game",
        "name": "Italian Game (Giuoco Piano)",
        "desc": "Focuses on rapid development, control of the center, and attacking Black's vulnerable f7 square.",
        "moves": ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5"],
        "sans": ["1. e4 e5", "2. Nf3 Nc6", "3. Bc4 Bc5"],
        "startFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    },
    {
        "id": "kings_indian",
        "name": "King's Indian Defense",
        "desc": "A hypermodern opening where Black allows White to build a large pawn center, planning to strike back later.",
        "moves": ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "f8g7"],
        "sans": ["1. d4 Nf6", "2. c4 g6", "3. Nc3 Bg7"],
        "startFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    },
    {
        "id": "scandinavian",
        "name": "Scandinavian Defense",
        "desc": "Black immediately challenges White's center pawn, leading to an open game and rapid queen activity.",
        "moves": ["e2e4", "d7d5", "e4d5", "d8d5"],
        "sans": ["1. e4 d5", "2. exd5 Qxd5"],
        "startFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    }
]

def fetch_lichess_explorer(fen: str) -> dict:
    """
    Fetch move stats from Lichess Opening Explorer.
    Falls back to local legal moves list if network fails or rates are exhausted.
    """
    import urllib.request
    import urllib.parse
    import urllib.error
    
    board = chess.Board(fen)
    turn = "white" if board.turn == chess.WHITE else "black"
    
    url = f"https://explorer.lichess.ovh/masters?fen={urllib.parse.quote(fen)}"
    
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "ChessReviewer/1.0.0"}
        )
        with urllib.request.urlopen(req, timeout=3.0) as response:
            data = json.loads(response.read().decode())
            
            root_white = data.get("white", 0)
            root_draws = data.get("draws", 0)
            root_black = data.get("black", 0)
            root_total = root_white + root_draws + root_black
            if root_total == 0:
                root_total = 1
                
            raw_moves = data.get("moves", [])
            output_moves = []
            
            for m in raw_moves[:5]:  # Get top 5 moves
                m_white = m.get("white", 0)
                m_draws = m.get("draws", 0)
                m_black = m.get("black", 0)
                m_total = m_white + m_draws + m_black
                if m_total == 0:
                    continue
                
                # Check theoretical name if we make this move
                san = m.get("san")
                uci = m.get("uci")
                try:
                    next_board = board.copy()
                    next_board.push_san(san)
                    opening_name = get_opening_name(next_board.fen())
                except Exception:
                    opening_name = None
                
                output_moves.append({
                    "san": san,
                    "uci": uci,
                    "play_count": m_total,
                    "popularity": round((m_total / root_total) * 100, 1),
                    "white_win_ratio": round((m_white / m_total) * 100, 1),
                    "black_win_ratio": round((m_black / m_total) * 100, 1),
                    "draw_ratio": round((m_draws / m_total) * 100, 1),
                    "opening_name": opening_name
                })
                
            return {
                "source": "lichess",
                "total_games": root_total,
                "moves": output_moves
            }
            
    except Exception as e:
        # Fallback to local legal moves list
        output_moves = []
        legal_moves = list(board.legal_moves)
        for move in legal_moves:
            san = board.san(move)
            uci = move.uci()
            try:
                next_board = board.copy()
                next_board.push(move)
                opening_name = get_opening_name(next_board.fen())
            except Exception:
                opening_name = None
            
            output_moves.append({
                "san": san,
                "uci": uci,
                "play_count": 0,
                "popularity": 0.0,
                "white_win_ratio": 33.3,
                "black_win_ratio": 33.3,
                "draw_ratio": 33.3,
                "opening_name": opening_name
            })
            
        # Put moves that result in a known opening first
        output_moves.sort(key=lambda x: (x["opening_name"] is None, x["san"]))
        
        return {
            "source": "local_fallback",
            "total_games": 0,
            "moves": output_moves[:5]
        }

