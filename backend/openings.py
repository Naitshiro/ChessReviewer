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
