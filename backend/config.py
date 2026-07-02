"""
backend/config.py

Configuration loader for ChessReviewer.
Resolution priority for Stockfish path:
  1. config.json `stockfish_path` field (if non-empty)
  2. STOCKFISH_PATH environment variable
  3. Relative fallback: <project_root>/stockfish/stockfish.exe
"""

import json
import os
import sys
from pathlib import Path

# Project root is one level above this file (or current dir of executable if frozen)
if getattr(sys, 'frozen', False):
    PROJECT_ROOT = Path(sys.executable).parent
else:
    PROJECT_ROOT = Path(__file__).parent.parent

_CONFIG_FILE = PROJECT_ROOT / "config.json"

def _load_config() -> dict:
    if _CONFIG_FILE.exists():
        try:
            with open(_CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

_cfg = _load_config()

def _resolve_stockfish_path() -> str:
    """Return the first valid Stockfish executable path found."""
    candidates = [
        _cfg.get("stockfish_path", "").strip(),
        os.environ.get("STOCKFISH_PATH", "").strip(),
        str(PROJECT_ROOT / "stockfish" / "stockfish.exe"),
        str(PROJECT_ROOT / "stockfish" / "stockfish"),
        "stockfish",   # hope it's on PATH
    ]
    for path in candidates:
        if not path:
            continue
        p = Path(path)
        if p.is_file():
            return str(p)
    # Return the config value anyway so the error message is useful
    return _cfg.get("stockfish_path", "").strip() or "stockfish"

STOCKFISH_PATH: str = _resolve_stockfish_path()
ENGINE_THREADS: int = int(_cfg.get("engine_threads", 2))
ENGINE_HASH_MB: int = int(_cfg.get("engine_hash_mb", 128))
ANALYSIS_DEPTH: int = int(_cfg.get("analysis_depth", 18))
SERVER_HOST: str = _cfg.get("server_host", "127.0.0.1")
SERVER_PORT: int = int(_cfg.get("server_port", 8000))
