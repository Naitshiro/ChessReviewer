/**
 * app.js — Main application state machine for ChessReviewer
 *
 * Manages two operating modes:
 *   REVIEW   — Navigate through a batch-analyzed PGN game
 *   ANALYSIS — Live On-Demand mode with WebSocket engine streaming
 *
 * Imports:
 *   Chess from chess.js (move validation + FEN management)
 *   BoardManager from board.js (cm-chessboard wrapper)
 *   Rendering helpers from analysis.js
 */

import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';
import { BoardManager } from './board.js?v=6';
import {
  renderEvalBar, renderEvalChart, highlightChartMove,
  renderMoveList, setActiveMoveInList,
  renderScorecard, showToast, setEvalText,
  CLASS_META, getMateMoves
} from './analysis.js?v=7';

// ── Constants ───────────────────────────────────────────────────────────

const API_BASE = '';   // Same origin
const WS_URL = `ws://${location.host}/ws/analyze`;

const MODE = { IDLE: 'idle', REVIEW: 'review', ANALYSIS: 'analysis' };

/** Normalize FEN to first 4 fields (strips halfmove/fullmove counters) */
const normFen = fen => (fen || '').split(' ').slice(0, 4).join(' ');

// ── Application State ───────────────────────────────────────────────────

const state = {
  mode: MODE.IDLE,
  liveEngineEnabled: false,

  /** Populated after batch analysis (Review Mode) */
  game: {
    metadata: null,
    moves: [],           // Array of move records from backend
    accuracy: null,
    initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  },

  review: {
    currentIndex: -1,   // -1 = at initial position, 0 = after first move
  },

  analysis: {
    ws: null,             // Active WebSocket
    forkFen: null,        // FEN from which the user forked
    forkIndex: null,      // Move index in game[] at fork point
    chess: null,          // Chess instance for the analysis scratchpad
    latestLines: [],      // Latest MultiPV results [{multipv, from_sq, to_sq, ...}]
    branchMoves: [],      // Moves played in analysis mode
    currentBranchIndex: -1, // Currently viewed move in branch
  },
  boardOrientation: 'white', // tracks the visual orientation to render player cards correctly
  autoplay: {
    intervalId: null,
    isPlaying: false,
  },
};

// ── DOM References ──────────────────────────────────────────────────────

const el = {
  modeBadge: document.getElementById('mode-badge'),
  badgeDot: document.getElementById('badge-dot'),
  badgeText: document.getElementById('badge-text'),
  openingName: document.getElementById('opening-name'),
  pgnInput: document.getElementById('pgn-input'),
  analyzeBtn: document.getElementById('analyze-btn'),
  loadingSpinner: document.getElementById('loading-spinner'),
  analysisProgressContainer: document.getElementById('analysis-progress-container'),
  analysisProgressText: document.getElementById('analysis-progress-text'),
  analysisProgressPct: document.getElementById('analysis-progress-pct'),
  analysisProgressFill: document.getElementById('analysis-progress-fill'),
  depthSlider: document.getElementById('depth-slider'),
  depthValue: document.getElementById('depth-value'),
  btnFirst: document.getElementById('btn-first'),
  btnPrev: document.getElementById('btn-prev'),
  btnPlay: document.getElementById('btn-play'),
  playIcon: document.getElementById('play-icon'),
  pauseIcon: document.getElementById('pause-icon'),
  btnNext: document.getElementById('btn-next'),
  btnLast: document.getElementById('btn-last'),
  btnFlip: document.getElementById('btn-flip'),
  backToReviewBtn: document.getElementById('back-to-review-btn'),
  tabSummary: document.getElementById('tab-summary'),
  tabMoves: document.getElementById('tab-moves'),
  panelSummary: document.getElementById('panel-summary'),
  panelMoves: document.getElementById('panel-moves'),
  engineDepthBadge: document.getElementById('engine-depth-badge'),
  liveEngineToggle: document.getElementById('live-engine-toggle'),
  liveEngineDot: document.getElementById('live-engine-dot'),
  liveDepthInput: document.getElementById('live-depth'),
  liveTimeoutInput: document.getElementById('live-timeout'),
  engineLinesPanel: document.getElementById('live-engine-lines'),
  engineLinesContainer: document.getElementById('engine-lines-container'),
  engineSpinner: document.getElementById('engine-spinner'),

  // Player Cards
  topPlayerName: document.getElementById('top-player-name'),
  topPlayerElo: document.getElementById('top-player-elo'),
  topPlayerTitle: document.getElementById('top-player-title'),
  topPlayerAvatar: document.getElementById('top-player-avatar'),
  bottomPlayerName: document.getElementById('bottom-player-name'),
  bottomPlayerElo: document.getElementById('bottom-player-elo'),
  bottomPlayerTitle: document.getElementById('bottom-player-title'),
  bottomPlayerAvatar: document.getElementById('bottom-player-avatar'),
};

// ── Board ───────────────────────────────────────────────────────────────

const board = new BoardManager('board');

board.init((from, to, promotion) => {
  _handleBoardMove(from, to, promotion);
});

// ── Initialization ──────────────────────────────────────────────────────

async function init() {
  _setMode(MODE.IDLE);
  _bindControls();
  await _checkHealth();

  // Keyboard navigation
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { stopAutoplay(); navigateNext(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { stopAutoplay(); navigatePrev(); }
    if (e.key === 'Home') { stopAutoplay(); navigateFirst(); }
    if (e.key === 'End') { stopAutoplay(); navigateLast(); }
    if (e.key === ' ') {
      e.preventDefault();
      toggleAutoplay();
    }
  });

  // Enable interaction right away so user can play from blank board
  board.enableInteraction(() => true, _getLegalMoves);
}

// ── Health Check ────────────────────────────────────────────────────────

async function _checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const data = await res.json();
    const banner = document.getElementById('engine-setup-banner');
    if (!data.engine?.ready) {
      if (banner) banner.classList.remove('hidden');
      showToast(
        `Stockfish not found — set "stockfish_path" in config.json`,
        'error',
        8000
      );
    } else {
      if (banner) banner.classList.add('hidden');
      // Initialize depth slider value from backend config
      if (data.engine?.depth) {
        if (el.depthSlider) el.depthSlider.value = data.engine.depth;
        if (el.depthValue) el.depthValue.textContent = data.engine.depth;
      }
    }
  } catch (e) {
    showToast('Cannot reach backend server. Make sure start.bat is running.', 'error', 8000);
  }
}

// ── Control Binding ─────────────────────────────────────────────────────

function _bindControls() {
  // Analyze button
  el.analyzeBtn?.addEventListener('click', submitAnalysis);

  // PGN input — submit on Ctrl+Enter
  el.pgnInput?.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') submitAnalysis();
  });

  // Navigation buttons
  el.btnFirst?.addEventListener('click', () => { stopAutoplay(); navigateFirst(); });
  el.btnPrev?.addEventListener('click', () => { stopAutoplay(); navigatePrev(); });
  el.btnPlay?.addEventListener('click', toggleAutoplay);
  el.btnNext?.addEventListener('click', () => { stopAutoplay(); navigateNext(); });
  el.btnLast?.addEventListener('click', () => { stopAutoplay(); navigateLast(); });
  el.btnFlip?.addEventListener('click', () => {
    board.flipBoard();
    state.boardOrientation = state.boardOrientation === 'white' ? 'black' : 'white';
    _updatePlayerCards();
    _triggerEvalBarRender();
  });

  // Back to review (exits analysis mode)
  el.backToReviewBtn?.addEventListener('click', () => {
    stopAutoplay();
    exitAnalysisMode();
  });

  // Depth slider
  el.depthSlider?.addEventListener('input', () => {
    if (el.depthValue) el.depthValue.textContent = el.depthSlider.value;
  });

  // Tabs
  el.tabSummary?.addEventListener('click', () => _switchTab('summary'));
  el.tabMoves?.addEventListener('click', () => _switchTab('moves'));

  // Live Engine Toggle
  el.liveEngineToggle?.addEventListener('change', (e) => {
    state.liveEngineEnabled = e.target.checked;
    if (el.liveEngineDot) {
      el.liveEngineDot.style.background = state.liveEngineEnabled ? '#22c55e' : '';
    }
    _handleLiveEngineToggle();
  });

  // Live settings change — re-trigger analysis with new limits
  el.liveDepthInput?.addEventListener('change', () => {
    if (state.liveEngineEnabled) _restartCurrentAnalysis();
  });
  el.liveTimeoutInput?.addEventListener('change', () => {
    if (state.liveEngineEnabled) _restartCurrentAnalysis();
  });
}

function _handleLiveEngineToggle() {
  if (state.liveEngineEnabled) {
    const fen = _getCurrentFen();
    _startWebSocketAnalysis(fen);
  } else {
    _teardownWebSocket();
    board.clearArrows();
    if (el.engineDepthBadge) el.engineDepthBadge.classList.add('hidden');
    if (el.engineSpinner) el.engineSpinner.classList.add('hidden');
    if (el.engineLinesPanel) el.engineLinesPanel.classList.add('hidden');
    if (el.badgeDot) el.badgeDot.style.animation = 'none';

    _triggerEvalBarRender();
  }
}

/** Get the FEN for the currently displayed board position */
function _getCurrentFen() {
  if (state.mode === MODE.ANALYSIS) {
    const idx = state.analysis.currentBranchIndex;
    return idx < 0
      ? (state.analysis.forkFen || board.currentFen)
      : state.analysis.branchMoves[idx].fen_after;
  }
  if (state.mode === MODE.REVIEW) {
    const idx = state.review.currentIndex;
    return idx < 0 ? state.game.initialFen : state.game.moves[idx].fen_after;
  }
  // IDLE — use whatever is on the board
  return board.currentFen;
}

/** Restart analysis on the current position (used when depth/timeout changes) */
function _restartCurrentAnalysis() {
  const fen = _getCurrentFen();
  _startWebSocketAnalysis(fen);
}

// ── PGN Submission & Batch Analysis ────────────────────────────────────

async function submitAnalysis() {
  stopAutoplay();
  const pgn = el.pgnInput?.value?.trim();
  if (!pgn) {
    showToast('Please paste a PGN or list of moves.', 'error');
    return;
  }

  const depth = parseInt(el.depthSlider?.value || '18', 10);

  // Show loading state
  if (el.analyzeBtn) el.analyzeBtn.disabled = true;
  if (el.loadingSpinner) el.loadingSpinner.classList.remove('hidden');
  if (el.analysisProgressContainer) {
    el.analysisProgressContainer.classList.remove('hidden');
    if (el.analysisProgressFill) el.analysisProgressFill.style.width = '0%';
    if (el.analysisProgressPct) el.analysisProgressPct.textContent = '0%';
    if (el.analysisProgressText) el.analysisProgressText.textContent = 'Starting analysis...';
  }

  // Close any active WS session
  if (state.mode === MODE.ANALYSIS) _teardownWebSocket();

  try {
    const res = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pgn, depth }),
    });

    if (!res.ok) {
      let err;
      try {
        err = await res.json();
      } catch (e) {
        err = { detail: `Server error ${res.status}` };
      }
      throw new Error(err.detail || `Server error ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === "progress") {
          const pct = Math.round((msg.current / msg.total) * 100);
          if (el.analysisProgressFill) el.analysisProgressFill.style.width = `${pct}%`;
          if (el.analysisProgressPct) el.analysisProgressPct.textContent = `${pct}%`;
          if (el.analysisProgressText) el.analysisProgressText.textContent = `Analyzing move ${msg.current} of ${msg.total}...`;
        } else if (msg.type === "result") {
          _loadGameAnalysis(msg.data);
          showToast('Analysis complete!', 'success');
          _switchTab('moves');
        } else if (msg.type === "error") {
          throw new Error(msg.detail);
        }
      }
    }

  } catch (e) {
    showToast(`Analysis failed: ${e.message}`, 'error', 6000);
    console.error(e);
  } finally {
    if (el.analyzeBtn) el.analyzeBtn.disabled = false;
    if (el.loadingSpinner) el.loadingSpinner.classList.add('hidden');
    if (el.analysisProgressContainer) el.analysisProgressContainer.classList.add('hidden');
  }
}

// ── Load Game into Review Mode ──────────────────────────────────────────

function _loadGameAnalysis(data) {
  state.game.metadata = data.metadata;
  state.game.moves = data.moves;
  state.game.accuracy = data.accuracy;
  state.game.initialFen = data.initial_fen ||
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // Render UI
  renderMoveList(data.moves, _onMoveClick);
  renderScorecard(data.accuracy);
  renderEvalChart(data.moves);

  // Metadata display
  const metaEl = document.getElementById('game-metadata');
  if (metaEl && data.metadata) {
    metaEl.textContent =
      `${data.metadata.white} vs ${data.metadata.black}` +
      (data.metadata.event ? ` — ${data.metadata.event}` : '');
    metaEl.classList.remove('hidden');
  }

  // Populate player cards
  state.boardOrientation = 'white'; // Board defaults to white orientation on new game
  board.setOrientation('white');
  _updatePlayerCards();

  // Switch to review mode at initial position
  _setMode(MODE.REVIEW);
  navigateFirst();

  // Enable board interaction (for On-Demand forking)
  board.enableInteraction(_validateReviewMove, _getLegalMoves);
}

// ── Player Cards ────────────────────────────────────────────────────────

function _updatePlayerCards() {
  if (!state.game.metadata) return;
  const m = state.game.metadata;

  // Create safe values
  const whiteName = (m.white && m.white !== '?') ? m.white : 'White';
  const blackName = (m.black && m.black !== '?') ? m.black : 'Black';
  const whiteElo = m.white_elo ? `(${m.white_elo})` : '';
  const blackElo = m.black_elo ? `(${m.black_elo})` : '';
  const whiteTitle = m.white_title || '';
  const blackTitle = m.black_title || '';

  let top, bottom;
  if (state.boardOrientation === 'white') {
    top = { name: blackName, elo: blackElo, title: blackTitle, color: 'black' };
    bottom = { name: whiteName, elo: whiteElo, title: whiteTitle, color: 'white' };
  } else {
    top = { name: whiteName, elo: whiteElo, title: whiteTitle, color: 'white' };
    bottom = { name: blackName, elo: blackElo, title: blackTitle, color: 'black' };
  }

  const renderAvatar = (el, color) => {
    if (!el) return;
    if (color === 'white') {
      el.className = 'w-7 h-7 rounded bg-gray-200 flex items-center justify-center text-[18px] text-gray-900 border border-[var(--border)]';
    } else {
      el.className = 'w-7 h-7 rounded bg-gray-900 flex items-center justify-center text-[18px] text-gray-200 border border-[var(--border)]';
    }
  };

  renderAvatar(el.topPlayerAvatar, top.color);
  renderAvatar(el.bottomPlayerAvatar, bottom.color);

  if (el.topPlayerName) el.topPlayerName.textContent = top.name;
  if (el.topPlayerElo) el.topPlayerElo.textContent = top.elo;
  if (el.topPlayerTitle) {
    el.topPlayerTitle.textContent = top.title;
    top.title ? el.topPlayerTitle.classList.remove('hidden') : el.topPlayerTitle.classList.add('hidden');
  }

  if (el.bottomPlayerName) el.bottomPlayerName.textContent = bottom.name;
  if (el.bottomPlayerElo) el.bottomPlayerElo.textContent = bottom.elo;
  if (el.bottomPlayerTitle) {
    el.bottomPlayerTitle.textContent = bottom.title;
    bottom.title ? el.bottomPlayerTitle.classList.remove('hidden') : el.bottomPlayerTitle.classList.add('hidden');
  }
}

function _triggerEvalBarRender() {
  if (state.liveEngineEnabled && state.analysis.latestLines?.[0]) {
    const line = state.analysis.latestLines[0];
    renderEvalBar(line.white_cp, line.score_mate, line.game_over, line.winner, state.boardOrientation);
  } else if (state.mode === MODE.REVIEW) {
    const idx = state.review.currentIndex;
    if (idx >= 0) {
      const m = state.game.moves[idx];
      const c = new Chess(m.fen_after);
      let gameOver = c.isGameOver();
      let winner = null;
      if (c.isCheckmate()) {
        winner = c.turn() === 'w' ? 'black' : 'white';
      }
      renderEvalBar(m.white_cp || 0, m.score_mate, gameOver, winner, state.boardOrientation);
    } else {
      renderEvalBar(0, null, false, null, state.boardOrientation);
    }
  } else if (state.mode === MODE.ANALYSIS) {
    const activeBranch = state.analysis.branchMoves[state.analysis.currentBranchIndex];
    if (activeBranch) {
      renderEvalBar(activeBranch.white_cp || 0, activeBranch.mate_played, false, null, state.boardOrientation);
    } else {
      renderEvalBar(0, null, false, null, state.boardOrientation);
    }
  } else {
    renderEvalBar(0, null, false, null, state.boardOrientation);
  }
}

// ── Review Mode Navigation ──────────────────────────────────────────────

export function navigateFirst() {
  if (state.mode === MODE.REVIEW) navigateTo(-1);
  else if (state.mode === MODE.ANALYSIS) {
    _navigateToBranch(-1);
  }
}
export function navigateLast() {
  if (state.mode === MODE.REVIEW) navigateTo(state.game.moves.length - 1);
  else if (state.mode === MODE.ANALYSIS && state.analysis.branchMoves.length > 0) {
    _navigateToBranch(state.analysis.branchMoves.length - 1);
  }
}
export function navigateNext() {
  if (state.mode === MODE.REVIEW) navigateTo(state.review.currentIndex + 1);
  else if (state.mode === MODE.ANALYSIS) {
    _navigateToBranch(state.analysis.currentBranchIndex + 1);
  }
}
export function navigatePrev() {
  if (state.mode === MODE.REVIEW) navigateTo(state.review.currentIndex - 1);
  else if (state.mode === MODE.ANALYSIS) {
    _navigateToBranch(state.analysis.currentBranchIndex - 1);
  }
}

function _navigateToBranch(idx) {
  if (idx < -1 || idx >= state.analysis.branchMoves.length) return;
  state.analysis.currentBranchIndex = idx;
  const fen = idx === -1 ? state.analysis.forkFen : state.analysis.branchMoves[idx].fen_after;
  state.analysis.chess = new Chess(fen);
  board.setPosition(fen, true);

  if (idx === -1) {
    const forkIdx = state.analysis.forkIndex;
    if (forkIdx >= 0 && state.game.moves[forkIdx]) {
      const m = state.game.moves[forkIdx];
      const from = m.uci.slice(0, 2);
      const to = m.uci.slice(2, 4);
      board.addLastMoveMarkers(from, to, m.classification);
    } else {
      board.clearMarkers();
    }
  } else {
    const m = state.analysis.branchMoves[idx];
    const from = m.uci.slice(0, 2);
    const to = m.uci.slice(2, 4);
    board.addLastMoveMarkers(from, to, m.classification);
  }

  setActiveMoveInList('branch', idx);
  _updatePgnInput();

  if (state.liveEngineEnabled) {
    board.clearArrows();
    _startWebSocketAnalysis(fen);
  }
}

export function navigateTo(index) {
  if (state.mode !== MODE.REVIEW) return;

  const moves = state.game.moves;
  const clampedIndex = Math.max(-1, Math.min(moves.length - 1, index));

  state.review.currentIndex = clampedIndex;

  const fen = clampedIndex < 0
    ? state.game.initialFen
    : moves[clampedIndex].fen_after;

  // Update board
  board.setPosition(fen, true);

  if (clampedIndex >= 0) {
    const m = moves[clampedIndex];
    const from = m.uci.slice(0, 2);
    const to = m.uci.slice(2, 4);
    board.addLastMoveMarkers(from, to, m.classification);

    // Eval bar (from White's perspective)
    if (!state.liveEngineEnabled) {
      const c = new Chess(fen);
      let gameOver = c.isGameOver();
      let winner = null;
      if (c.isCheckmate()) {
        winner = c.turn() === 'w' ? 'black' : 'white';
      }
      renderEvalBar(m.white_cp || 0, m.score_mate, gameOver, winner, state.boardOrientation);
    }

    // Opening name
    if (el.openingName) {
      el.openingName.textContent = m.opening || '';
    }

    // Chart highlight
    highlightChartMove(clampedIndex);
  } else {
    board.clearMarkers();
    if (!state.liveEngineEnabled) {
      board.clearArrows();
      renderEvalBar(0, null, false, null, state.boardOrientation);
    }
    if (el.openingName) el.openingName.textContent = 'Starting Position';
    highlightChartMove(-1);
  }

  // Move list highlight
  setActiveMoveInList('main', clampedIndex);

  // Nav button states
  _updateNavButtons();

  // Update live engine if enabled
  if (state.liveEngineEnabled && state.mode === MODE.REVIEW) {
    board.clearArrows();
    _startWebSocketAnalysis(fen);
  }
}

function _onMoveClick(type, index) {
  stopAutoplay();
  if (type === 'main') {
    if (state.mode === MODE.ANALYSIS) {
      exitAnalysisMode();
    }
    navigateTo(index);
  } else if (type === 'branch') {
    if (state.mode !== MODE.ANALYSIS) return;
    state.analysis.currentBranchIndex = index;
    const m = state.analysis.branchMoves[index];
    state.analysis.chess = new Chess(m.fen_after);
    board.setPosition(m.fen_after, true);

    // Add marker for the branch move
    board.clearMarkers();
    const from = m.uci.slice(0, 2);
    const to = m.uci.slice(2, 4);
    board.addLastMoveMarkers(from, to, m.classification);

    _startWebSocketAnalysis(m.fen_after);
    setActiveMoveInList('branch', index);
  }
}

function _updateNavButtons() {
  const idx = state.review.currentIndex;
  const max = state.game.moves.length - 1;
  if (el.btnFirst) el.btnFirst.disabled = idx < 0;
  if (el.btnPrev) el.btnPrev.disabled = idx < 0;
  if (el.btnNext) el.btnNext.disabled = idx >= max;
  if (el.btnLast) el.btnLast.disabled = idx >= max;
}

// ── Autoplay ────────────────────────────────────────────────────────────

export function startAutoplay() {
  if (state.autoplay.isPlaying) return;

  if (state.mode === MODE.REVIEW) {
    if (state.review.currentIndex >= state.game.moves.length - 1) return;
  } else if (state.mode === MODE.ANALYSIS) {
    if (state.analysis.currentBranchIndex >= state.analysis.branchMoves.length - 1) return;
  } else {
    return;
  }

  state.autoplay.isPlaying = true;
  if (el.playIcon) el.playIcon.classList.add('hidden');
  if (el.pauseIcon) el.pauseIcon.classList.remove('hidden');

  state.autoplay.intervalId = setInterval(_autoplayTick, 1000);
}

export function stopAutoplay() {
  if (!state.autoplay.isPlaying) return;

  state.autoplay.isPlaying = false;
  if (el.playIcon) el.playIcon.classList.remove('hidden');
  if (el.pauseIcon) el.pauseIcon.classList.add('hidden');

  if (state.autoplay.intervalId) {
    clearInterval(state.autoplay.intervalId);
    state.autoplay.intervalId = null;
  }
}

export function toggleAutoplay() {
  if (state.autoplay.isPlaying) {
    stopAutoplay();
  } else {
    startAutoplay();
  }
}

function _autoplayTick() {
  if (state.mode === MODE.REVIEW) {
    if (state.review.currentIndex >= state.game.moves.length - 1) {
      stopAutoplay();
      return;
    }
    navigateNext();
  } else if (state.mode === MODE.ANALYSIS) {
    if (state.analysis.currentBranchIndex >= state.analysis.branchMoves.length - 1) {
      stopAutoplay();
      return;
    }
    navigateNext();
  } else {
    stopAutoplay();
  }
}

// ── Board Move Handler (detects deviation → forks to Analysis Mode) ─────

function _validateReviewMove(from, to) {
  const legalMoves = _getLegalMoves(from);
  return legalMoves.includes(to);
}

function _handleBoardMove(from, to, promotion) {
  stopAutoplay();
  if (state.mode === MODE.IDLE) {
    state.game.initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    state.game.moves = [];
    state.review.currentIndex = -1;
    _setMode(MODE.REVIEW);
    // Let it fall through to REVIEW mode logic to fork immediately
  }

  const idx = state.review.currentIndex;

  if (state.mode === MODE.REVIEW) {
    // Build a chess instance for the current position
    const fen = idx < 0
      ? state.game.initialFen
      : state.game.moves[idx]?.fen_after;

    const chess = new Chess(fen);
    let moveResult;
    try {
      moveResult = chess.move({
        from, to,
        promotion: promotion || 'q',
      });
    } catch (err) {
      // Illegal move — restore position
      board.setPosition(fen, false);
      return;
    }

    const newFen = chess.fen();

    // Check if this matches the game's next move (compare normalized FENs)
    if (idx + 1 < state.game.moves.length) {
      const nextGameMove = state.game.moves[idx + 1];
      if (normFen(nextGameMove.fen_after) === normFen(newFen)) {
        // It matches — advance in review mode
        navigateTo(idx + 1);
        return;
      }
    }

    // Deviation detected → fork into On-Demand analysis mode
    const cpBest = (state.liveEngineEnabled && state.analysis.latestLines?.[0])
      ? (state.analysis.latestLines[0].score_cp || 0)
      : (idx + 1 < state.game.moves.length ? state.game.moves[idx + 1].cp_best : 0);
    const cpSecond = (state.liveEngineEnabled && state.analysis.latestLines?.[1])
      ? (state.analysis.latestLines[1].score_cp || cpBest)
      : cpBest;

    _enterAnalysisMode(fen, idx);
    state.analysis.chess.move(moveResult.san);
    board.setPosition(newFen, true);

    const mateBestPlies = (state.liveEngineEnabled && state.analysis.latestLines?.[0])
      ? state.analysis.latestLines[0].score_mate
      : (idx + 1 < state.game.moves.length ? state.game.moves[idx + 1].score_mate : null);

    const mateBestMoves = getMateMoves(mateBestPlies, moveResult.color === 'w' ? 'white' : 'black');

    state.analysis.branchMoves = [{
      move_number: parseInt(fen.split(' ')[5], 10) || 1,
      color: moveResult.color === 'w' ? 'white' : 'black',
      san: moveResult.san,
      uci: moveResult.from + moveResult.to,
      fen_before: fen,
      fen_after: newFen,
      cp_best: cpBest,
      cp_second: cpSecond,
      cp_played: null,
      white_cp: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].white_cp || 0) : 0,
      best_uci: (state.liveEngineEnabled && state.analysis.latestLines?.[0] && state.analysis.latestLines[0].pv?.length > 0)
                ? state.analysis.latestLines[0].pv[0] 
                : null,
      mate_best: mateBestMoves,
      mate_played: null,
      classification: null,
      moveResult: moveResult
    }];
    state.analysis.currentBranchIndex = 0;

    renderMoveList(state.game.moves, _onMoveClick, state.analysis.branchMoves, state.analysis.forkIndex);
    setActiveMoveInList('branch', 0);
    _updatePgnInput();
    board.addLastMoveMarkers(from, to, null); // Clear old badge, show new move squares
    _checkTheory(0);

    if (state.liveEngineEnabled) {
      _startWebSocketAnalysis(newFen);
    }
  } else if (state.mode === MODE.ANALYSIS) {
    // Already in analysis mode — user is exploring further
    const chess = state.analysis.chess;
    if (!chess) return;

    const fenBefore = chess.fen();
    let moveResult;
    try {
      moveResult = chess.move({
        from, to,
        promotion: promotion || 'q',
      });
    } catch (err) {
      // Illegal — restore
      board.setPosition(fenBefore, false);
      return;
    }

    const newFen = chess.fen();
    board.setPosition(newFen, true);

    const cpBest = state.analysis.latestLines?.[0]?.score_cp || 0;
    const cpSecond = state.analysis.latestLines?.[1]?.score_cp || cpBest;

    const bIdx = state.analysis.currentBranchIndex;
    state.analysis.branchMoves = state.analysis.branchMoves.slice(0, bIdx + 1);

    const mateBestPlies = state.analysis.latestLines?.[0]?.score_mate ?? null;
    const mateBestMoves = getMateMoves(mateBestPlies, moveResult.color === 'w' ? 'white' : 'black');

    state.analysis.branchMoves.push({
      move_number: parseInt(fenBefore.split(' ')[5], 10) || 1,
      color: moveResult.color === 'w' ? 'white' : 'black',
      san: moveResult.san,
      uci: moveResult.from + moveResult.to,
      fen_before: fenBefore,
      fen_after: newFen,
      cp_best: cpBest,
      cp_second: cpSecond,
      cp_played: null,
      white_cp: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].white_cp || 0) : 0,
      best_uci: (state.liveEngineEnabled && state.analysis.latestLines?.[0] && state.analysis.latestLines[0].pv?.length > 0)
                ? state.analysis.latestLines[0].pv[0] 
                : null,
      mate_best: mateBestMoves,
      mate_played: null,
      classification: null,
      moveResult: moveResult
    });
    state.analysis.currentBranchIndex = state.analysis.branchMoves.length - 1;

    renderMoveList(state.game.moves, _onMoveClick, state.analysis.branchMoves, state.analysis.forkIndex);
    setActiveMoveInList('branch', state.analysis.currentBranchIndex);
    _updatePgnInput();
    board.addLastMoveMarkers(from, to, null); // Clear old badge, show new move squares
    _checkTheory(state.analysis.currentBranchIndex);

    if (state.liveEngineEnabled) {
      _startWebSocketAnalysis(newFen);
    }
  }
}

// ── Analysis (On-Demand) Mode ───────────────────────────────────────────

function _enterAnalysisMode(fen, gameIndex) {
  state.mode = MODE.ANALYSIS;
  state.analysis.forkFen = fen;
  state.analysis.forkIndex = gameIndex;
  state.analysis.chess = new Chess(fen);
  state.analysis.latestLines = [];

  _setMode(MODE.ANALYSIS);

  board.setPosition(fen, true);
  board.clearMarrows();
  board.enableInteraction(() => true, _getLegalMoves);

  showToast('Analysis mode — exploring deviation', 'info', 3000);

  _startWebSocketAnalysis(fen);
}

function exitAnalysisMode() {
  if (state.mode !== MODE.ANALYSIS) return;

  if (!state.liveEngineEnabled) {
    _teardownWebSocket();
  }

  state.mode = MODE.REVIEW;
  state.analysis.chess = null;
  state.analysis.forkFen = null;
  state.analysis.latestLines = [];
  state.analysis.branchMoves = [];
  state.analysis.currentBranchIndex = -1;

  board.clearArrows();
  _setMode(MODE.REVIEW);

  // Restore review position
  navigateTo(state.review.currentIndex);
  board.enableInteraction(_validateReviewMove, _getLegalMoves);
}

// ── WebSocket Management ────────────────────────────────────────────────

function _startWebSocketAnalysis(fen) {
  if (!state.liveEngineEnabled) return;

  // Clear previous arrows and analysis lines when analyzing a new position
  state.analysis.latestLines = [];
  board.clearArrows();
  if (el.engineSpinner) el.engineSpinner.classList.remove('hidden');
  if (el.badgeDot) el.badgeDot.style.animation = 'blink-dot 1s ease-in-out infinite';

  const depth = parseInt(el.liveDepthInput?.value || '18', 10);
  const timeout = parseInt(el.liveTimeoutInput?.value || '0', 10);

  // If we already have a WS, just send the new FEN (the backend handles cancellation)
  if (state.analysis.ws && state.analysis.ws.readyState === WebSocket.OPEN) {
    state.analysis.ws.send(JSON.stringify({ type: 'set_fen', fen, depth, timeout }));
    return;
  }

  // Create a new WebSocket connection
  const ws = new WebSocket(WS_URL);
  state.analysis.ws = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'set_fen', fen, depth, timeout }));
  });

  ws.addEventListener('message', e => {
    try {
      const msg = JSON.parse(e.data);
      _handleEngineMessage(msg);
    } catch (err) {
      console.error('WS message parse error:', err);
    }
  });

  ws.addEventListener('close', () => {
    if (state.mode === MODE.ANALYSIS && state.analysis.ws === ws) {
      state.analysis.ws = null;
    }
  });

  ws.addEventListener('error', err => {
    console.error('WebSocket error:', err);
    showToast('Engine connection error.', 'error');
  });

  // Keepalive ping every 20s
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    } else {
      clearInterval(pingInterval);
    }
  }, 20000);
}

function _teardownWebSocket() {
  if (state.analysis.ws) {
    state.analysis.ws.close();
    state.analysis.ws = null;
  }
  if (el.engineLinesPanel) el.engineLinesPanel.classList.add('hidden');
}

function _handleEngineMessage(msg) {
  if (state.mode !== MODE.ANALYSIS && !state.liveEngineEnabled) return;

  if (msg.type === 'done') {
    if (el.engineSpinner) el.engineSpinner.classList.add('hidden');
    if (el.badgeDot) el.badgeDot.style.animation = 'none';

    // Fallback: classify if engine finishes before target depth
    if (state.analysis.branchMoves && state.analysis.branchMoves.length > 0) {
      const activeBranch = state.analysis.branchMoves[state.analysis.currentBranchIndex];
      if (activeBranch && (!activeBranch.classification || activeBranch.classification === 'theory') && state.analysis.latestLines?.[0]) {
        _classifyLiveMove(state.analysis.latestLines[0]);
      }
    }
    return;
  }

  switch (msg.type) {
    case 'info': {
      const pvIdx = (msg.multipv || 1) - 1;

      // Update our latestLines array
      state.analysis.latestLines[pvIdx] = msg;

      // Draw arrows for all known lines
      board.drawEngineArrows(state.analysis.latestLines.filter(Boolean));

      // Update Engine Lines panel
      _updateEngineLinesPanel();

      // Update eval bar with MultiPV 1 (best line)
      if (msg.multipv === 1) {
        renderEvalBar(msg.white_cp, msg.score_mate, msg.game_over, msg.winner, state.boardOrientation);
        if (el.engineDepthBadge) {
          el.engineDepthBadge.classList.remove('hidden');
          el.engineDepthBadge.textContent = `depth ${msg.depth}`;
        }

        // Classify branch move if pending or holding temporary theory badge
        if (state.analysis.branchMoves && state.analysis.branchMoves.length > 0) {
          const activeBranch = state.analysis.branchMoves[state.analysis.currentBranchIndex];
          const targetDepth = parseInt(el.liveDepthInput.value, 10) || 18;
          if (activeBranch && (!activeBranch.classification || activeBranch.classification === 'theory') && msg.depth >= targetDepth) {
            _classifyLiveMove(msg);
          }
        }
      }
      break;
    }

    case 'error':
      showToast(`Engine error: ${msg.message}`, 'error');
      break;

    case 'pong':
      // Keepalive received, nothing to do
      break;

    default:
      break;
  }
}

async function _checkTheory(branchIndex) {
  const mainSans = state.game.moves.slice(0, state.analysis.forkIndex + 1).map(m => m.san);
  const branchSans = state.analysis.branchMoves.slice(0, branchIndex + 1).map(m => m.san);
  const allSans = [...mainSans, ...branchSans];

  try {
    const res = await fetch(`${API_BASE}/api/theory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sans: allSans })
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.is_theory) {
      const activeBranch = state.analysis.branchMoves[branchIndex];
      if (activeBranch) {

        let brilliantTheoryFound = false;
        for (const m of state.game.moves.slice(0, state.analysis.forkIndex + 1)) {
          if (m.classification === 'brilliant') {
            brilliantTheoryFound = true;
            break;
          }
        }
        for (let i = 0; i < branchIndex; i++) {
          const m = state.analysis.branchMoves[i];
          if (m.classification === 'brilliant' && m.is_theory) {
            brilliantTheoryFound = true;
            break;
          }
        }

        if (!brilliantTheoryFound) {
          activeBranch.is_theory = true;
          if (activeBranch.classification && activeBranch.classification !== 'brilliant' && activeBranch.classification !== 'theory') {
            activeBranch.classification = 'theory';
            renderMoveList(state.game.moves, _onMoveClick, state.analysis.branchMoves, state.analysis.forkIndex);

            const from = activeBranch.uci.slice(0, 2);
            const to = activeBranch.uci.slice(2, 4);
            board.addLastMoveMarkers(from, to, 'theory');
          }
        }
      }
    }
  } catch (err) {
    console.error("Theory check failed", err);
  }
}

async function _classifyLiveMove(msg) {
  if (!state.analysis.branchMoves || state.analysis.branchMoves.length === 0) return;
  const activeBranch = state.analysis.branchMoves[state.analysis.currentBranchIndex];

  if (!activeBranch) return;
  // Only classify if not yet classified OR if it was just holding a temporary 'theory' badge
  if (activeBranch.classification && activeBranch.classification !== 'theory') return;

  try {
    const cpPlayed = -msg.score_cp;
    activeBranch.cp_played = cpPlayed;
    activeBranch.white_cp = msg.white_cp;

    const matePlayedMoves = getMateMoves(msg.score_mate, activeBranch.color);
    activeBranch.mate_played = matePlayedMoves;

    const res = await fetch(`${API_BASE}/api/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fen_before: activeBranch.fen_before,
        move_uci: activeBranch.uci,
        cp_best: activeBranch.cp_best,
        cp_second: activeBranch.cp_second,
        best_move_uci: activeBranch.best_uci,
        mate_best: activeBranch.mate_best,
        cp_played: cpPlayed,
        mate_played: matePlayedMoves,
        is_book: activeBranch.is_theory || false
      })
    });
    if (!res.ok) throw new Error("Classification API failed");
    const data = await res.json();
    activeBranch.classification = data.classification;
  } catch (err) {
    console.error("Classification error:", err);
    activeBranch.classification = "good";
  }

  renderMoveList(state.game.moves, _onMoveClick, state.analysis.branchMoves, state.analysis.forkIndex);
  setActiveMoveInList('branch', state.analysis.currentBranchIndex);

  const from = activeBranch.uci.slice(0, 2);
  const to = activeBranch.uci.slice(2, 4);
  board.addLastMoveMarkers(from, to, activeBranch.classification);
}

// ── Mode UI Updates ─────────────────────────────────────────────────────

function _setMode(mode) {
  state.mode = mode;

  // Mode badge
  if (el.modeBadge) {
    el.modeBadge.className = `mode-badge ${mode}`;
  }
  if (el.badgeText) {
    const labels = {
      [MODE.IDLE]: '● Idle',
      [MODE.REVIEW]: '● Review',
      [MODE.ANALYSIS]: '● Live Analysis',
    };
    el.badgeText.textContent = labels[mode] || mode;
  }

  // Back to review button
  if (el.backToReviewBtn) {
    el.backToReviewBtn.classList.toggle('hidden', mode !== MODE.ANALYSIS);
  }

  // Engine depth badge
  if (el.engineDepthBadge) {
    el.engineDepthBadge.classList.toggle('hidden', mode !== MODE.ANALYSIS && !state.liveEngineEnabled);
  }

  // Nav buttons — enabled in REVIEW and ANALYSIS
  const navEnabled = mode === MODE.REVIEW || mode === MODE.ANALYSIS;
  [el.btnFirst, el.btnPrev, el.btnPlay, el.btnNext, el.btnLast].forEach(btn => {
    if (btn) btn.disabled = !navEnabled;
  });
  if (!navEnabled) {
    stopAutoplay();
  }
}

// ── Tabs ────────────────────────────────────────────────────────────────

function _switchTab(tab) {
  const isSummary = tab === 'summary';
  el.tabSummary?.classList.toggle('active', isSummary);
  el.tabMoves?.classList.toggle('active', !isSummary);
  el.panelSummary?.classList.toggle('hidden', !isSummary);
  el.panelMoves?.classList.toggle('hidden', isSummary);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function _getLegalMoves(square) {
  let fen;
  if (state.mode === MODE.IDLE) {
    fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  } else if (state.mode === MODE.REVIEW) {
    const idx = state.review.currentIndex;
    fen = idx < 0 ? state.game.initialFen : state.game.moves[idx].fen_after;
  } else {
    if (!state.analysis.chess) return [];
    fen = state.analysis.chess.fen();
  }
  try {
    const c = new Chess(fen);
    return c.moves({ square, verbose: true }).map(m => m.to);
  } catch (err) {
    return [];
  }
}

function _updatePgnInput() {
  if (!el.pgnInput) return;
  const clone = new Chess(state.game.initialFen);
  let pgnStr = '';

  let isVariation = state.analysis.forkIndex < state.game.moves.length - 1;
  let mainLineEndIndex = isVariation ? state.analysis.forkIndex + 1 : state.analysis.forkIndex;

  // 1. Play main line up to the replaced move (inclusive)
  for (let i = 0; i <= mainLineEndIndex; i++) {
    const m = state.game.moves[i];
    if (clone.turn() === 'w') pgnStr += `${clone.moveNumber()}. `;
    pgnStr += `${m.san} `;
    clone.move(m.uci);
  }

  // 2. Play branch
  let branchStr = isVariation ? '(' : '';

  // Branch starts from forkIndex
  const branchClone = new Chess(state.game.initialFen);
  for (let i = 0; i <= state.analysis.forkIndex; i++) {
    branchClone.move(state.game.moves[i].uci);
  }

  for (let i = 0; i < state.analysis.branchMoves.length; i++) {
    const m = state.analysis.branchMoves[i];
    if (branchClone.turn() === 'w') branchStr += `${branchClone.moveNumber()}. `;
    else if (i === 0) branchStr += `${branchClone.moveNumber()}... `;
    branchStr += `${m.san} `;
    branchClone.move(m.uci);
  }
  branchStr = branchStr.trim();
  if (isVariation) branchStr += ') ';
  else branchStr += ' ';

  pgnStr += branchStr;

  // 3. Play rest of main line
  if (isVariation) {
    for (let i = state.analysis.forkIndex + 2; i < state.game.moves.length; i++) {
      const m = state.game.moves[i];
      if (clone.turn() === 'w') pgnStr += `${clone.moveNumber()}. `;
      else if (i === state.analysis.forkIndex + 2) pgnStr += `${clone.moveNumber()}... `;
      pgnStr += `${m.san} `;
      clone.move(m.uci);
    }
  }

  el.pgnInput.value = pgnStr.trim();
}
function _updateEngineLinesPanel() {
  if (!el.engineLinesPanel || !el.engineLinesContainer) return;

  if (!state.liveEngineEnabled && state.mode !== MODE.ANALYSIS) {
    el.engineLinesPanel.classList.add('hidden');
    return;
  }

  el.engineLinesPanel.classList.remove('hidden');
  const lines = state.analysis.latestLines.filter(Boolean);

  if (lines.length === 0) {
    el.engineLinesContainer.innerHTML = '<div class="text-[var(--text-muted)] italic">Thinking...</div>';
    return;
  }

  // Get current FEN to convert PV from UCI to SAN
  const currentFen = _getCurrentFen();

  let html = '';
  lines.forEach(line => {
    let scoreStr = '';
    if (line.score_mate !== undefined && line.score_mate !== null) {
      if (line.score_mate === 1) scoreStr = '1-0';
      else if (line.score_mate === -1) scoreStr = '0-1';
      else if (line.score_mate === 0) {
        const c = new Chess(currentFen);
        scoreStr = c.turn() === 'w' ? '0-1' : '1-0';
      } else {
        scoreStr = line.score_mate > 0 ? `M${line.score_mate}` : `-M${Math.abs(line.score_mate)}`;
      }
    } else {
      const cp = (line.white_cp / 100).toFixed(2);
      scoreStr = cp;
    }

    // White advantage → white bg, black text. Black advantage → dark bg, white text.
    const whiteAdv = (line.score_mate !== undefined && line.score_mate !== null)
      ? line.score_mate > 0
      : line.white_cp >= 0;
    const scoreBg = whiteAdv ? 'background:#fff;color:#111;' : 'background:#222;color:#fff;';

    // Convert UCI PV to SAN
    const pvSan = _uciPvToSan(currentFen, line.pv || []);

    html += `
      <div style="display:flex;gap:6px;align-items:center;">
        <span style="${scoreBg}min-width:50px;text-align:center;padding:2px 6px;border-radius:4px;font-weight:700;font-size:11px;flex-shrink:0;">${scoreStr}</span>
        <span style="color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;">${pvSan}</span>
      </div>
    `;
  });

  el.engineLinesContainer.innerHTML = html;
}

/** Convert a UCI PV array to SAN notation using chess.js */
function _uciPvToSan(fen, uciMoves) {
  try {
    const c = new Chess(fen);
    const sanMoves = [];
    for (const uci of uciMoves) {
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      const result = c.move({ from, to, promotion });
      if (!result) break;
      sanMoves.push(result.san);
    }
    return sanMoves.join(' ');
  } catch (e) {
    return uciMoves.join(' ');
  }
}

// ── Boot ────────────────────────────────────────────────────

init().catch(console.error);
