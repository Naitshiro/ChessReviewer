"""
backend/main.py

FastAPI application for ChessReviewer.

Routes:
  GET  /api/health          → Engine status check
  POST /api/analyze         → Batch PGN analysis (Review Mode)
  WS   /ws/analyze          → Live streaming analysis (On-Demand Mode)

Static files (frontend/) are mounted at "/" after all API routes.
"""

# Trigger reload comment
import asyncio
import json
import logging
import sys
import urllib.request
import random
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

# Enforce Proactor Event Loop on Windows to support subprocesses under Uvicorn/WatchFiles
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
import chess

from .engine import EngineManager, parse_pgn_game
from .config import STOCKFISH_PATH, ANALYSIS_DEPTH
from .openings import is_book_sequence
from .analysis import classify_move, is_sacrifice, win_prob
from .chesscom import fetch_chesscom_games

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


# ---------------------------------------------------------------------------
# Lifespan: initialize/shutdown engine on server start/stop
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize Stockfish on startup, shut it down on shutdown."""
    logger.info("ChessReviewer starting up...")
    
    # Auto-generate white versions of annotation SVGs if they don't exist
    try:
        import glob
        from pathlib import Path
        markers_dir = Path(__file__).parent.parent / "frontend" / "assets" / "markers"
        if markers_dir.exists():
            for filepath in markers_dir.glob("annotation_*.svg"):
                if filepath.name.endswith("_white.svg"):
                    continue
                white_path = filepath.parent / f"{filepath.stem}_white.svg"
                if not white_path.exists():
                    content = filepath.read_text(encoding="utf-8")
                    content_white = content
                    content_white = content_white.replace('class="icon-background" fill="#000000"', 'class="icon-background" fill="#ffffff"')
                    content_white = content_white.replace('class="icon-background" fill="#000"', 'class="icon-background" fill="#ffffff"')
                    content_white = content_white.replace('fill="#fff"', 'fill="#000000"')
                    content_white = content_white.replace('fill="#ffffff"', 'fill="#000000"')
                    content_white = content_white.replace('stroke="#fff"', 'stroke="#000000"')
                    content_white = content_white.replace('stroke="#ffffff"', 'stroke="#000000"')
                    content_white = content_white.replace(f'id="{filepath.stem}"', f'id="{filepath.stem}_white"')
                    white_path.write_text(content_white, encoding="utf-8")
                    logger.info(f"Auto-generated white SVG: {white_path.name}")
    except Exception as e:
        logger.error(f"Failed to auto-generate white SVGs: {e}")

    try:
        await EngineManager.get_instance()
    except Exception as e:
        logger.error(f"Engine init failed on startup: {e}")
    yield
    logger.info("ChessReviewer shutting down...")
    if EngineManager._instance:
        await EngineManager._instance.shutdown()


app = FastAPI(
    title="ChessReviewer API",
    description="Local chess game review and real-time analysis backend.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class AnalyzeRequest(BaseModel):
    pgn: str
    depth: Optional[int] = ANALYSIS_DEPTH

    @field_validator("depth")
    @classmethod
    def clamp_depth(cls, v):
        if v is None:
            return ANALYSIS_DEPTH
        return max(8, min(30, v))

    @field_validator("pgn")
    @classmethod
    def validate_pgn(cls, v):
        if not v or not v.strip():
            raise ValueError("PGN cannot be empty")
        return v.strip()

class TheoryRequest(BaseModel):
    sans: list[str]

class ClassifyRequest(BaseModel):
    fen_before: str
    move_uci: str
    cp_best: float
    cp_second: float
    best_move_uci: Optional[str] = None
    mate_best: Optional[int] = None
    cp_played: float
    mate_played: Optional[int] = None
    is_book: Optional[bool] = False

class ThreatRequest(BaseModel):
    fen: str
    current_eval_cp: float


class EngineMoveRequest(BaseModel):
    fen: str
    elo: int


# ---------------------------------------------------------------------------
# HTTP Routes
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    """Return engine status and configuration."""
    try:
        manager = await EngineManager.get_instance()
        return {"status": "ok", "engine": manager.status}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/theory")
async def check_theory(req: TheoryRequest):
    """Check if a sequence of SANs is a known opening theory."""
    is_theory = is_book_sequence(req.sans)
    return {"is_theory": is_theory}

@app.post("/api/classify")
async def classify_live_move(req: ClassifyRequest):
    """Classify a move played during live analysis."""
    try:
        board = chess.Board(req.fen_before)
        try:
            move = chess.Move.from_uci(req.move_uci)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid move UCI")
            
        sacrificed = is_sacrifice(board, move)
        is_engine_top_choice = (req.best_move_uci is not None) and (req.move_uci == req.best_move_uci)
        
        p_best = win_prob(req.cp_best)
        p_played = win_prob(req.cp_played)
        delta = max(0.0, p_best - p_played)
        p_second = win_prob(req.cp_second)
        
        classification = classify_move(
            delta=delta,
            p_best=p_best,
            p_second_best=p_second,
            p_played=p_played,
            sacrificed=sacrificed,
            is_book=req.is_book,
            cp_best=req.cp_best,
            cp_second=req.cp_second,
            cp_played=req.cp_played,
            mate_best=req.mate_best,
            mate_played=req.mate_played,
            is_engine_top_choice=is_engine_top_choice,
        )
        return {"classification": classification}
    except Exception as e:
        logger.exception("Error in /api/classify")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/threats")
async def get_threats(req: ThreatRequest):
    """Calculate and return a list of threat moves for the given position."""
    try:
        manager = await EngineManager.get_instance()
        threats = await manager.calculate_threats(req.fen, req.current_eval_cp)
        return {"threats": threats}
    except Exception as e:
        logger.exception("Error in /api/threats")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/import")
async def import_pgn(req: AnalyzeRequest):
    """
    Parse a PGN game without running Stockfish analysis.
    Returns the parsed game data.
    """
    try:
        data = parse_pgn_game(req.pgn)
        return data
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Error in /api/import")
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")

from fastapi.responses import StreamingResponse

@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest):
    """
    Batch-analyze a PGN game using Stockfish.
    
    Streams progress updates followed by the full GameAnalysis object.
    """
    async def stream():
        try:
            manager = await EngineManager.get_instance()
            async for chunk in manager.batch_analyze(req.pgn, depth=req.depth):
                yield json.dumps(chunk) + "\n"
        except ValueError as e:
            yield json.dumps({"type": "error", "detail": str(e)}) + "\n"
        except RuntimeError as e:
            yield json.dumps({"type": "error", "detail": str(e)}) + "\n"
        except Exception as e:
            logger.exception("Unexpected error in /api/analyze")
            yield json.dumps({"type": "error", "detail": f"Analysis failed: {str(e)}"}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.get("/api/chesscom/games")
async def get_chesscom_games(username: str):
    """Fetch the latest 15 games for a Chess.com user."""
    try:
        games = await asyncio.to_thread(fetch_chesscom_games, username.strip())
        return {"status": "ok", "games": games}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Error in /api/chesscom/games")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Training / Learning Routes
# ---------------------------------------------------------------------------

@app.get("/api/training/curated-puzzles")
async def get_curated_puzzles():
    """Retrieve the curated list of offline chess puzzles."""
    try:
        puzzles_file = Path(__file__).parent / "puzzles.json"
        if puzzles_file.exists():
            return json.loads(puzzles_file.read_text(encoding="utf-8"))
        return []
    except Exception as e:
        logger.exception("Error reading curated puzzles")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/training/daily-puzzle")
async def get_daily_puzzle():
    """Fetch daily puzzle from Lichess with fallback to curated puzzles."""
    try:
        req = urllib.request.Request(
            "https://lichess.org/api/puzzle/daily",
            headers={"User-Agent": "ChessReviewer/1.0.0"}
        )
        with urllib.request.urlopen(req, timeout=2.0) as response:
            data = json.loads(response.read().decode())
            
            puzzle_data = data.get("puzzle", {})
            initial_fen = puzzle_data.get("initialFen")
            solution = puzzle_data.get("solution", [])
            rating = puzzle_data.get("rating", 1500)
            theme = data.get("game", {}).get("perf", {}).get("name", "Tactics")
            puzzle_id = puzzle_data.get("id", "daily")
            
            # Determine player color (turn in initialFen indicates who plays the blunder)
            board = chess.Board(initial_fen)
            player_color = "black" if board.turn == chess.WHITE else "white"
            
            return {
                "id": f"lichess_{puzzle_id}",
                "title": f"Lichess Daily Puzzle ({puzzle_id})",
                "description": f"Find the winning line. Play as {player_color.capitalize()}.",
                "rating": rating,
                "theme": theme,
                "initialFen": initial_fen,
                "solution": solution,
                "player_color": player_color
            }
    except Exception as e:
        logger.warning(f"Failed to fetch Lichess daily puzzle: {e}. Falling back to curated list.")
        try:
            puzzles_file = Path(__file__).parent / "puzzles.json"
            if puzzles_file.exists():
                puzzles = json.loads(puzzles_file.read_text(encoding="utf-8"))
                if puzzles:
                    return random.choice(puzzles)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to fetch puzzle: {str(e)}")


@app.post("/api/training/engine-move")
async def training_engine_move(req: EngineMoveRequest):
    """Play a move vs Stockfish configured with specific ELO."""
    try:
        board = chess.Board(req.fen)
        if board.is_game_over():
            return {
                "best_move": None,
                "san": None,
                "fen_after": req.fen,
                "game_over": True
            }

        # Keep ELO in supported range for UCI engine limits
        elo = max(800, min(3200, req.elo))

        # Spin up temporary Stockfish instance for this move
        transport, engine = await chess.engine.popen_uci(STOCKFISH_PATH)
        try:
            config = {}
            limit = chess.engine.Limit(time=0.1)

            # Disable strength limiting at max level (3200)
            if elo >= 3200:
                if "UCI_LimitStrength" in engine.options:
                    config["UCI_LimitStrength"] = False
            else:
                if "UCI_LimitStrength" in engine.options:
                    config["UCI_LimitStrength"] = True

                if "UCI_Elo" in engine.options:
                    uci_elo_option = engine.options["UCI_Elo"]
                    engine_min = getattr(uci_elo_option, "min", 1320)
                    engine_max = getattr(uci_elo_option, "max", 2400)
                    
                    if engine_min is None:
                        engine_min = 1320
                    if engine_max is None:
                        engine_max = 2800

                    if elo < engine_min:
                        config["UCI_Elo"] = engine_min
                        # We requested a weaker engine than supported by ELO.
                        # Simulate lower ELO by playing with a very small depth or search limit.
                        diff = engine_min - elo
                        if diff >= 400: # e.g. requested 800-900 when min is 1320
                            limit = chess.engine.Limit(depth=1, time=0.01)
                        elif diff >= 200: # e.g. requested 1000-1100 when min is 1320
                            limit = chess.engine.Limit(depth=2, time=0.02)
                        else:
                            limit = chess.engine.Limit(depth=3, time=0.05)
                    else:
                        config["UCI_Elo"] = min(elo, engine_max)

            await engine.configure(config)
            result = await engine.play(board, limit)
            
            move = result.move
            san = board.san(move)
            uci = move.uci()
            
            board.push(move)
            new_fen = board.fen()
            
            return {
                "best_move": uci,
                "san": san,
                "fen_after": new_fen,
                "game_over": board.is_game_over()
            }
        finally:
            await engine.quit()
            
    except Exception as e:
        logger.exception("Error in play vs engine move endpoint")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# WebSocket Route — Live / On-Demand Analysis
# ---------------------------------------------------------------------------

@app.websocket("/ws/analyze")
async def ws_analyze(websocket: WebSocket):
    """
    WebSocket endpoint for the On-Demand Analysis Board mode.
    
    Client → Server messages (JSON):
      { "type": "set_fen", "fen": "<FEN string>" }  — start/restart engine on FEN
      { "type": "ping" }                             — keepalive
    
    Server → Client messages (JSON):
      { "type": "info",     "multipv": 1-3, "depth": int, "score_cp": int,
        "score_mate": int|null, "white_win_prob": float,
        "pv": [uci...], "from_sq": str, "to_sq": str }
      { "type": "bestmove", "move": str }
      { "type": "error",    "message": str }
      { "type": "pong" }
    """
    await websocket.accept()
    logger.info("WebSocket client connected.")

    manager: Optional[EngineManager] = None
    cancel_event = asyncio.Event()
    stream_task: Optional[asyncio.Task] = None

    try:
        manager = await EngineManager.get_instance()
    except Exception as e:
        await websocket.send_json({"type": "error", "message": str(e)})
        await websocket.close()
        return

    async def _send_info(info: dict) -> None:
        """Callback that forwards engine info lines to the WebSocket client."""
        try:
            await websocket.send_json({"type": "info", **info})
        except Exception:
            pass  # Client disconnected

    async def _start_stream(fen: str, depth: int, timeout: int) -> None:
        """Cancel any previous stream gracefully and start a new one."""
        nonlocal stream_task
        ev = getattr(_start_stream, "_current_cancel", None)
        if ev:
            ev.set()
        if stream_task and not stream_task.done():
            try:
                await stream_task
            except Exception:
                pass

        new_cancel = asyncio.Event()

        async def _run():
            try:
                await manager.stream_analysis(fen, _send_info, new_cancel, depth=depth, timeout=timeout)
                if not new_cancel.is_set():
                    try:
                        await websocket.send_json({"type": "done"})
                    except Exception:
                        pass
            except asyncio.CancelledError:
                pass
            except Exception as e:
                try:
                    await websocket.send_json({"type": "error", "message": str(e)})
                except Exception:
                    pass

        stream_task = asyncio.create_task(_run())
        _start_stream._current_cancel = new_cancel

    _start_stream._current_cancel = None

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid JSON"})
                continue

            msg_type = msg.get("type", "")

            if msg_type == "set_fen":
                fen = msg.get("fen", "").strip()
                depth = int(msg.get("depth", 18))
                timeout = int(msg.get("timeout", 0))
                if not fen:
                    await websocket.send_json({"type": "error", "message": "Missing FEN"})
                    continue
                await _start_stream(fen, depth, timeout)

            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})

            else:
                await websocket.send_json({
                    "type": "error",
                    "message": f"Unknown message type: {msg_type}"
                })

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected.")
    except Exception as e:
        logger.exception(f"WebSocket error: {e}")
    finally:
        ev = getattr(_start_stream, "_current_cancel", None)
        if ev:
            ev.set()
        if stream_task and not stream_task.done():
            try:
                await stream_task
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Static files — mount LAST so API routes take priority
# ---------------------------------------------------------------------------

if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    logger.warning(f"Frontend directory not found: {FRONTEND_DIR}")
