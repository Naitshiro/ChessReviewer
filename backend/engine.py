"""
backend/engine.py

Async Stockfish wrapper using python-chess chess.engine API.

EngineManager is a singleton that holds a persistent UCI subprocess.
Provides two analysis modes:
  - batch_analyze(): Iterate all game positions, fixed depth, returns full analysis list
  - stream_analysis(): Continuous MultiPV=3 loop for live On-Demand mode, cancellable
"""

import asyncio
import logging
from typing import Callable, Optional, AsyncGenerator

import chess
import chess.engine
import chess.pgn
import io

from .config import STOCKFISH_PATH, ENGINE_THREADS, ENGINE_HASH_MB, ANALYSIS_DEPTH
from .analysis import (
    win_prob, classify_move, is_sacrifice,
    build_accuracy_report, cp_from_score, get_mate_moves
)
from .openings import is_book_sequence, get_opening_name

logger = logging.getLogger(__name__)

def get_non_pawn_material(board: chess.Board) -> int:
    total = 0
    for piece_type, val in [(chess.KNIGHT, 3), (chess.BISHOP, 3), (chess.ROOK, 5), (chess.QUEEN, 9)]:
        total += len(board.pieces(piece_type, chess.WHITE)) * val
        total += len(board.pieces(piece_type, chess.BLACK)) * val
    return total


class EngineManager:
    """
    Singleton managing a persistent Stockfish process.
    Must be initialized via `await EngineManager.get_instance()` before use.
    """

    _instance: Optional["EngineManager"] = None

    def __init__(self):
        self._transport: Optional[chess.engine.BaseTransport] = None
        self._engine: Optional[chess.engine.Protocol] = None
        self._lock = asyncio.Lock()
        self._ready = False
        self._error: Optional[str] = None

    @classmethod
    async def get_instance(cls) -> "EngineManager":
        if cls._instance is None:
            cls._instance = cls()
            await cls._instance._initialize()
        return cls._instance

    async def _initialize(self) -> None:
        """Start the Stockfish process and configure it."""
        try:
            logger.info(f"Starting Stockfish from: {STOCKFISH_PATH}")
            self._transport, self._engine = await chess.engine.popen_uci(STOCKFISH_PATH)
            await self._engine.configure({
                "Threads": ENGINE_THREADS,
                "Hash": ENGINE_HASH_MB,
            })
            self._ready = True
            self._error = None
            logger.info("Stockfish ready.")
        except Exception as e:
            self._ready = False
            self._error = str(e)
            logger.exception("Failed to start Stockfish")

    async def ensure_ready(self) -> None:
        """Re-initialize if the engine crashed."""
        if not self._ready:
            await self._initialize()
        if not self._ready:
            raise RuntimeError(
                f"Stockfish engine not available. "
                f"Error: {self._error}. "
                f"Path tried: {STOCKFISH_PATH}. "
                f"Please set 'stockfish_path' in config.json."
            )

    @property
    def status(self) -> dict:
        return {
            "ready": self._ready,
            "error": self._error,
            "path": STOCKFISH_PATH,
            "threads": ENGINE_THREADS,
            "hash_mb": ENGINE_HASH_MB,
            "depth": ANALYSIS_DEPTH,
        }

    async def shutdown(self) -> None:
        """Gracefully quit the engine subprocess."""
        if self._engine and self._ready:
            try:
                await self._engine.quit()
            except Exception:
                pass
        self._ready = False
        self._engine = None
        self._transport = None

    # -----------------------------------------------------------------------
    # Batch Analysis (Review Mode)
    # -----------------------------------------------------------------------

    async def batch_analyze(
        self,
        pgn_text: str,
        depth: int = ANALYSIS_DEPTH,
    ) -> AsyncGenerator[dict, None]:
        """
        Parse a PGN string and analyse every position at the given depth.
        Returns a complete game analysis object ready to be sent to the frontend.
        
        Steps:
          1. Parse PGN → collect (board_before_move, move) pairs + FENs
          2. Analyze each FEN with MultiPV=3
          3. For each move: compute delta, classify, flag book/sacrifice
          4. Compute per-side accuracy and classification counts
        """
        await self.ensure_ready()

        # --- Parse PGN ---
        pgn = chess.pgn.read_game(io.StringIO(pgn_text))
        if pgn is None:
            raise ValueError("Could not parse PGN. Please check the input format.")
            
        if pgn.errors:
            err_msg = str(pgn.errors[0])
            raise ValueError(f"Invalid PGN: {err_msg}")

        # Collect all positions
        board = pgn.board()
        positions: list[dict] = []  # {fen, board_copy, move, san, color}

        # Record the starting position
        initial_board = board.copy()
        fens: list[str] = [board.fen()]
        boards_before: list[chess.Board] = []
        moves_played: list[chess.Move] = []
        move_sans: list[str] = []
        move_colors: list[chess.Color] = []
        move_numbers: list[int] = []

        for node in pgn.mainline():
            boards_before.append(board.copy())  # board state BEFORE the move
            
            move = node.move
            san = node.san()
            color = board.turn
            move_num = board.fullmove_number

            moves_played.append(move)
            move_sans.append(san)
            move_colors.append(color)
            move_numbers.append(move_num)

            board.push(move)
            fens.append(board.fen())

        if not moves_played:
            raise ValueError("The PGN contains no moves.")

        # --- Analyze all positions (fens[0] through fens[N]) ---
        # fens[i] is the position BEFORE move i was played (for i < N)
        # fens[N] is the final position
        engine_scores: list[dict] = []  # indexed same as fens

        async with self._lock:
            for i, fen in enumerate(fens):
                yield {"type": "progress", "current": i + 1, "total": len(fens)}
                
                b = chess.Board(fen)
                if b.is_game_over():
                    outcome = b.outcome()
                    if outcome and outcome.winner is not None:
                        # Winner from absolute perspective, so player who just got mated has turn.
                        # His relative score is -10000.
                        rel_cp = 10000 if outcome.winner == b.turn else -10000
                    else:
                        rel_cp = 0.0

                    engine_scores.append({
                        "fen": fen,
                        "relative_cp": rel_cp,
                        "pv1": None, "pv2": None, "pv3": None,
                        "cp1": rel_cp, "cp2": rel_cp, "cp3": rel_cp,
                    })
                    continue

                try:
                    info_list = await self._engine.analyse(
                        b,
                        chess.engine.Limit(depth=depth, time=5.0),
                        multipv=3,
                    )
                    # info_list is a list of InfoDict for each PV
                    scores_entry = {
                        "fen": fen,
                        "relative_cp": None,
                        "pv1": None, "pv2": None, "pv3": None,
                        "cp1": None, "cp2": None, "cp3": None,
                    }
                    for pv_idx, info in enumerate(info_list[:3]):
                        score = info.get("score")
                        cp = cp_from_score(score.relative if score else None)
                        
                        mate_val = None
                        if score and score.relative and score.relative.is_mate():
                            mate_val = score.relative.mate()
                            if b.turn == chess.BLACK:
                                mate_val = -mate_val
                            
                        pv = info.get("pv", [])
                        best_move = pv[0].uci() if pv else None
                        key = f"pv{pv_idx+1}"
                        scores_entry[f"cp{pv_idx+1}"] = cp
                        scores_entry[f"mate{pv_idx+1}"] = mate_val
                        scores_entry[key] = best_move
                    # relative CP of the top move
                    scores_entry["relative_cp"] = scores_entry["cp1"]
                    scores_entry["score_mate"] = scores_entry["mate1"]
                    engine_scores.append(scores_entry)
                except Exception as e:
                    logger.warning(f"Engine analysis failed for FEN {fen}: {e}")
                    engine_scores.append({
                        "fen": fen,
                        "relative_cp": 0.0,
                        "pv1": None, "pv2": None, "pv3": None,
                        "cp1": 0.0, "cp2": -0.01, "cp3": -0.02,
                    })

        # --- Compute move records ---
        move_records: list[dict] = []
        brilliant_theory_found = False

        for i, move in enumerate(moves_played):
            board_before = boards_before[i]
            color = move_colors[i]
            san = move_sans[i]
            move_num = move_numbers[i]

            # Scores from the position BEFORE the move
            es_before = engine_scores[i]
            cp_best = es_before["cp1"] if es_before["cp1"] is not None else 0.0
            cp_second = es_before["cp2"] if es_before["cp2"] is not None else cp_best
            cp_third = es_before["cp3"] if es_before["cp3"] is not None else cp_second

            # Score from position AFTER the move (opponent's turn)
            # Negate because it's now from opponent's perspective
            es_after = engine_scores[i + 1]
            cp_after_relative = es_after["relative_cp"] if es_after["relative_cp"] is not None else 0.0
            # Convert to current player's perspective (negate)
            cp_played = -cp_after_relative

            # Win probabilities (always from the CURRENT PLAYER's perspective)
            P_best = win_prob(cp_best)
            P_second = win_prob(cp_second)
            P_third = win_prob(cp_third)
            P_played = win_prob(cp_played)

            # Absolute delta (always ≥ 0)
            delta = max(0.0, P_best - P_played)

            # Book check
            if brilliant_theory_found:
                book = False
            else:
                book = is_book_sequence(move_sans[:i + 1])

            # Sacrifice check (always needed now because a book move could be brilliant)
            sacrificed = False
            try:
                sacrificed = is_sacrifice(board_before, move)
            except Exception:
                sacrificed = False

            # Extract mate information in moves
            mate_best = get_mate_moves(es_before.get("score_mate"), color)
            mate_played = get_mate_moves(es_after.get("score_mate"), color)

            classification = classify_move(
                delta=delta,
                p_best=P_best,
                p_second_best=P_second,
                p_played=P_played,
                sacrificed=sacrificed,
                is_book=book,
                cp_best=cp_best,
                cp_second=cp_second,
                cp_played=cp_played,
                mate_best=mate_best,
                mate_played=mate_played,
                is_engine_top_choice=(move.uci() == es_before.get("pv1")),
            )

            # If it was a book move and it was classified as brilliant,
            # we found a brilliant theory move. Stop flagging subsequent theory.
            if classification == "brilliant" and book:
                brilliant_theory_found = True

            # Compute White's absolute centipawn score for the eval bar/graph
            # post_relative is from the opponent's perspective in FEN_after
            # Negate when Black is to move, keeping White's perspective consistent
            post_relative = es_after["relative_cp"] or 0.0
            board_after_turn = chess.Board(fens[i + 1]).turn
            if board_after_turn == chess.WHITE:
                white_cp = post_relative
            else:
                white_cp = -post_relative
            white_win_prob = win_prob(white_cp)

            # Best engine move
            best_move_uci = es_before["pv1"]
            
            # Determine game phase
            if move_num <= 12:
                phase = "opening"
            elif get_non_pawn_material(board_before) <= 16:
                phase = "endgame"
            else:
                phase = "middlegame"

            move_records.append({
                "index": i,
                "move_number": move_num,
                "color": "white" if color == chess.WHITE else "black",
                "san": san,
                "uci": move.uci(),
                "fen_before": fens[i],
                "fen_after": fens[i + 1],
                "cp_best": round(cp_best, 2),
                "cp_played": round(cp_played, 2),
                "score_mate": es_after.get("score_mate"),
                "white_cp": round(white_cp, 2),   # White-perspective cp (for eval bar)
                "white_win_prob": round(white_win_prob, 4),
                "p_best": round(P_best, 4),
                "p_played": round(P_played, 4),
                "delta": round(delta, 4),
                "classification": classification,
                "best_move": best_move_uci,
                "top_moves": [m for m in [es_before["pv1"], es_before["pv2"], es_before["pv3"]] if m],
                "is_book": book,
                "is_sacrifice": sacrificed,
                "opening": get_opening_name(fens[i]),
                "phase": phase,
            })

        # --- Build accuracy report ---
        accuracy = build_accuracy_report(
            [{"color": (r["color"] == "white"), "delta": r["delta"], "classification": r["classification"], "phase": r["phase"]}
             for r in move_records]
        )

        # Game metadata
        headers = dict(pgn.headers)

        final_result = {
            "metadata": {
                "white": headers.get("White", "White"),
                "black": headers.get("Black", "Black"),
                "white_elo": headers.get("WhiteElo", ""),
                "black_elo": headers.get("BlackElo", ""),
                "white_title": headers.get("WhiteTitle", ""),
                "black_title": headers.get("BlackTitle", ""),
                "event": headers.get("Event", ""),
                "date": headers.get("Date", ""),
                "result": headers.get("Result", "*"),
                "time_control": headers.get("TimeControl", ""),
                "termination": headers.get("Termination", ""),
                "depth_used": depth,
            },
            "initial_fen": fens[0],
            "moves": move_records,
            "accuracy": accuracy,
        }
        
        yield {"type": "result", "data": final_result}

    # -----------------------------------------------------------------------
    # Streaming Analysis (On-Demand / Analysis Board mode)
    # -----------------------------------------------------------------------

    async def stream_analysis(
        self,
        fen: str,
        callback: Callable,
        cancel_event: asyncio.Event,
        depth: int = ANALYSIS_DEPTH,
        timeout: int = 0
    ) -> None:
        """
        Start a continuous engine analysis stream for the given FEN.
        Calls `callback(info_dict)` for every engine info line.
        Stops when `cancel_event` is set.

        Uses MultiPV=3 for up to 3 candidate move arrows.
        The callback receives:
            {
                "multipv": int (1-3),
                "depth": int,
                "score_cp": int,
                "score_mate": int | None,
                "pv": [uci_move_str, ...],
                "from_sq": str,
                "to_sq": str,
                "white_win_prob": float,
            }
        """
        await self.ensure_ready()

        board = chess.Board(fen)
        if board.is_game_over():
            outcome = board.outcome()
            if outcome and outcome.winner is not None:
                winner_color = "white" if outcome.winner == chess.WHITE else "black"
                white_cp = 10000 if outcome.winner == chess.WHITE else -10000
                score_cp = white_cp if board.turn == chess.WHITE else -white_cp
            else:
                winner_color = "draw"
                white_cp = 0
                score_cp = 0

            payload = {
                "multipv": 1,
                "depth": 100,
                "score_cp": score_cp,
                "score_mate": 0,
                "white_cp": white_cp,
                "white_win_prob": win_prob(white_cp),
                "pv": [],
                "from_sq": None,
                "to_sq": None,
                "game_over": True,
                "winner": winner_color
            }
            await callback(payload)
            return

        try:
            async with self._lock:
                limit = chess.engine.Limit(depth=depth)
                if timeout > 0:
                    limit = chess.engine.Limit(depth=depth, time=timeout)

                with await self._engine.analysis(
                    board,
                    limit,
                    multipv=3,
                ) as analysis:
                    async for info in analysis:
                        if cancel_event.is_set():
                            break

                        multipv = info.get("multipv", 1)
                        score_obj = info.get("score")
                        pv = info.get("pv", [])
                        depth = info.get("depth", 0)

                        if not pv or depth < 1:
                            continue

                        score_cp: int = 0
                        score_mate: Optional[int] = None

                        if score_obj:
                            rel = score_obj.relative
                            if rel.is_mate():
                                mate_moves = rel.mate()
                                score_mate = mate_moves if board.turn == chess.WHITE else -mate_moves
                                score_cp = 10000 if mate_moves > 0 else -10000
                            else:
                                score_cp = rel.score() or 0

                        # Determine from/to squares for arrow drawing
                        first_move = pv[0]
                        from_sq = chess.square_name(first_move.from_square)
                        to_sq = chess.square_name(first_move.to_square)

                        # Win probability from the current side's perspective
                        # Convert to white-absolute for eval bar
                        if board.turn == chess.WHITE:
                            white_cp = score_cp
                        else:
                            white_cp = -score_cp
                        white_win_prob = win_prob(white_cp)

                        payload = {
                            "multipv": multipv,
                            "depth": depth,
                            "score_cp": score_cp,
                            "score_mate": score_mate,
                            "white_cp": white_cp,
                            "white_win_prob": round(white_win_prob, 4),
                            "pv": [m.uci() for m in pv[:5]],
                            "from_sq": from_sq,
                            "to_sq": to_sq,
                            "game_over": False,
                            "winner": None
                        }

                        await callback(payload)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"Stream analysis error for FEN {fen}: {e}")
            raise
