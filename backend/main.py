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

from .engine import EngineManager
from .config import ANALYSIS_DEPTH

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
