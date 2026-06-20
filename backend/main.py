"""
backend/main.py

FastAPI application for ChessReviewer.

Routes:
  GET  /api/health          → Engine status check
  POST /api/analyze         → Batch PGN analysis (Review Mode)
  WS   /ws/analyze          → Live streaming analysis (On-Demand Mode)

Static files (frontend/) are mounted at "/" after all API routes.
"""

import asyncio
import json
import logging
import sys
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
from .config import ANALYSIS_DEPTH
from .openings import is_book_sequence
from .analysis import classify_move, is_sacrifice, win_prob

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
