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
  renderScorecard, renderAnnotationsScorecard, showToast, setEvalText,
  CLASS_META, getMateMoves, COMPREHENSIVE_NAG_MAP,
  registerChartClickCallback
} from './analysis.js?v=8';
import { TrainingModule } from './training.js';

// ── Constants ───────────────────────────────────────────────────────────

let API_BASE = '';   // Same origin
let WS_URL = `ws://${location.host}/ws/analyze`;

const MODE = { IDLE: 'idle', REVIEW: 'review', ANALYSIS: 'analysis', TRAINING: 'training' };

/** Normalize FEN to first 4 fields (strips halfmove/fullmove counters) */
const normFen = fen => (fen || '').split(' ').slice(0, 4).join(' ');

const DEPTH_VALUES = [
  8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30,
  40, 50, 60, 70, 80, 90, 100
];

function getClosestDepthIndex(val) {
  let closestIdx = 0;
  let minDiff = Infinity;
  for (let i = 0; i < DEPTH_VALUES.length; i++) {
    const diff = Math.abs(DEPTH_VALUES[i] - val);
    if (diff < minDiff) {
      minDiff = diff;
      closestIdx = i;
    }
  }
  return closestIdx;
}


// ── Application State ───────────────────────────────────────────────────

const state = {
  mode: MODE.IDLE,
  liveEngineEnabled: false,
  liveReviewEnabled: false,
  bestMovesEnabled: false,
  threatsEnabled: false,
  latestThreats: [],
  savedBestMovesEnabled: true,
  savedLiveReviewEnabled: false,
  savedThreatsEnabled: false,

  /** Populated after batch analysis (Review Mode) */
  game: {
    metadata: null,
    moves: [],           // Array of move records from backend
    accuracy: null,
    initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  },

  overlayPriority: 'classification', // 'classification' or 'annotation'
  avatarCache: {},                   // username -> avatarUrl

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
    expandedLines: {},    // Map of line index -> boolean for expanded state
  },
  boardOrientation: 'white', // tracks the visual orientation to render player cards correctly
  autoplay: {
    intervalId: null,
    isPlaying: false,
  },
  chesscomGames: [],
};

// ── DOM References ──────────────────────────────────────────────────────

const el = {
  modeBadge: document.getElementById('mode-badge'),
  badgeDot: document.getElementById('badge-dot'),
  badgeText: document.getElementById('badge-text'),
  openingName: document.getElementById('opening-name'),
  pgnInput: document.getElementById('pgn-input'),
  importBtn: document.getElementById('import-btn'),
  importSpinner: document.getElementById('import-spinner'),
  analyzeBtn: document.getElementById('analyze-btn'),
  analyzeBtnText: document.getElementById('analyze-btn-text'),
  analyzeBtnIcon: document.getElementById('analyze-btn-icon'),
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
  btnSound: document.getElementById('btn-sound'),
  soundOnIcon: document.getElementById('sound-on-icon'),
  soundOffIcon: document.getElementById('sound-off-icon'),
  btnFlip: document.getElementById('btn-flip'),
  btnToggleOverlay: document.getElementById('btn-toggle-overlay'),
  backToReviewBtn: document.getElementById('back-to-review-btn'),
  tabImport: document.getElementById('tab-import'),
  tabSummary: document.getElementById('tab-summary'),
  tabMoves: document.getElementById('tab-moves'),
  panelImport: document.getElementById('panel-import'),
  panelSummary: document.getElementById('panel-summary'),
  panelMoves: document.getElementById('panel-moves'),
  engineDepthBadge: document.getElementById('engine-depth-badge'),
  liveEngineToggle: document.getElementById('live-engine-toggle'),
  liveEngineDot: document.getElementById('live-engine-dot'),
  liveReviewToggle: document.getElementById('live-review-toggle'),
  liveReviewDot: document.getElementById('live-review-dot'),
  liveReviewLabel: document.getElementById('live-review-label'),
  bestMovesToggle: document.getElementById('best-moves-toggle'),
  bestMovesDot: document.getElementById('best-moves-dot'),
  bestMovesLabel: document.getElementById('best-moves-label'),
  threatToggle: document.getElementById('threat-toggle'),
  threatDot: document.getElementById('threat-dot'),
  threatLabel: document.getElementById('threat-label'),
  liveDepthInput: document.getElementById('live-depth'),
  liveTimeoutInput: document.getElementById('live-timeout'),
  engineLinesPanel: document.getElementById('live-engine-lines'),
  engineLinesContainer: document.getElementById('engine-lines-container'),
  engineSpinner: document.getElementById('engine-spinner'),

  // Modals & Sidebar Nav
  sidebarNavAnalysis: document.getElementById('sidebar-nav-analysis'),
  sidebarNavImport: document.getElementById('sidebar-nav-import'),
  sidebarNavSettings: document.getElementById('sidebar-nav-settings'),
  sidebarNavAbout: document.getElementById('sidebar-nav-about'),
  sidebarNavTraining: document.getElementById('sidebar-nav-training'),
  settingsModal: document.getElementById('settings-modal'),
  aboutModal: document.getElementById('about-modal'),
  closeSettings: document.getElementById('close-settings'),
  closeAbout: document.getElementById('close-about'),
  settingsDepth: document.getElementById('settings-depth'),
  settingsTimeout: document.getElementById('settings-timeout'),
  settingsSyzygyContainer: document.getElementById('syzygy-paths-container'),

  // Player Cards
  topPlayerName: document.getElementById('top-player-name'),
  topPlayerElo: document.getElementById('top-player-elo'),
  topPlayerTitle: document.getElementById('top-player-title'),
  topPlayerAvatar: document.getElementById('top-player-avatar'),
  topPlayerCaptured: document.getElementById('top-player-captured'),
  topPlayerClock: document.getElementById('top-player-clock'),
  topPlayerFlag: document.getElementById('top-player-flag'),
  bottomPlayerName: document.getElementById('bottom-player-name'),
  bottomPlayerElo: document.getElementById('bottom-player-elo'),
  bottomPlayerTitle: document.getElementById('bottom-player-title'),
  bottomPlayerAvatar: document.getElementById('bottom-player-avatar'),
  bottomPlayerCaptured: document.getElementById('bottom-player-captured'),
  bottomPlayerClock: document.getElementById('bottom-player-clock'),
  bottomPlayerFlag: document.getElementById('bottom-player-flag'),

  // Chess.com elements
  chesscomUsername: document.getElementById('chesscom-username'),
  chesscomFetchBtn: document.getElementById('chesscom-fetch-btn'),
  chesscomSpinner: document.getElementById('chesscom-spinner'),
  chesscomArchiveContainer: document.getElementById('chesscom-archive-container'),
  chesscomArchiveSelect: document.getElementById('chesscom-archive-select'),
  chesscomGamesList: document.getElementById('chesscom-games-list'),

  // FEN elements
  fenInput: document.getElementById('fen-input'),
  fenLoadBtn: document.getElementById('fen-load-btn'),
  fenSpinner: document.getElementById('fen-spinner'),
  fenResetBtn: document.getElementById('fen-reset-btn'),
};

// ── Board ───────────────────────────────────────────────────────────────

const board = new BoardManager('board');

board.init((from, to, promotion) => {
  _handleBoardMove(from, to, promotion);
});

// ── Initialization ──────────────────────────────────────────────────────

async function init() {
  // Detect and configure for Tauri context
  if (window.__TAURI__) {
    try {
      const port = await window.__TAURI__.invoke('get_server_port');
      API_BASE = `http://127.0.0.1:${port}`;
      WS_URL = `ws://127.0.0.1:${port}/ws/analyze`;
      console.log(`[Tauri] Configured API_BASE to ${API_BASE}`);
    } catch (err) {
      console.error('[Tauri] Failed to get server port from Tauri, falling back to 8000:', err);
      API_BASE = 'http://127.0.0.1:8000';
      WS_URL = 'ws://127.0.0.1:8000/ws/analyze';
    }
  } else if (location.protocol === 'tauri:' || location.origin.startsWith('tauri://') || location.origin.startsWith('https://tauri.localhost')) {
    API_BASE = 'http://127.0.0.1:8000';
    WS_URL = 'ws://127.0.0.1:8000/ws/analyze';
  }
  window.API_BASE = API_BASE;

  _setMode(MODE.IDLE);
  _bindControls();
  registerChartClickCallback(index => {
    stopAutoplay();
    navigateTo(index);
  });
  _updateSoundButtonUI();
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
  _triggerEvalBarRender();

  setTimeout(() => {
    board.enableInteraction(() => true, _getLegalMoves);
    _triggerEvalBarRender();
  }, 50);

  _switchTab('import');

  // Initialize training module
  TrainingModule.init(board, _setMode, _triggerEvalBarRender, (pgn) => {
    if (el.pgnInput) {
      el.pgnInput.value = pgn;
    }
    _switchTab('import');
    if (el.analyzeBtn) {
      el.analyzeBtn.disabled = false;
    }
    submitAnalysis();
  });

  // Load and apply saved chessboard theme
  const savedTheme = localStorage.getItem('chess_theme') || 'green';
  const boardEl = document.getElementById('board');
  if (boardEl) {
    boardEl.className = 'theme-' + savedTheme;
  }
  document.querySelectorAll('.theme-select-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === savedTheme);
  });

  // Load saved Syzygy paths
  _renderSyzygyPaths();

  // Send initial paths to backend if present
  const startupPaths = _getSyzygyPathsFromUI();
  const nonMptyPaths = startupPaths.map(p => p.trim()).filter(p => p.length > 0);
  const combined = nonMptyPaths.join(';');
  if (combined) {
    _sendSyzygyPathsToBackend(combined);
  }
}

function _renderSyzygyPaths() {
  const container = document.getElementById('syzygy-paths-container');
  if (!container) return;

  let paths = [];
  try {
    paths = JSON.parse(localStorage.getItem('chess_syzygy_paths')) || [];
  } catch (e) {
    paths = [];
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    paths = [""];
  }

  container.innerHTML = '';
  paths.forEach((path, idx) => {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-1.5 syzygy-path-row';
    row.innerHTML = `
      <input type="text" value="${path.replace(/"/g, '&quot;')}" placeholder="e.g. C:\\chess\\syzygy"
        class="flex-1 bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2.5 py-1.5 text-[var(--text-primary)] outline-none text-xs focus:border-[var(--accent-green)] placeholder-[var(--text-muted)] transition-all" />
      <button class="add-path-btn p-1.5 text-[var(--accent-green)] hover:bg-[var(--accent-green)]/10 rounded transition-colors text-sm font-bold" title="Add path">
        +
      </button>
      <button class="remove-path-btn p-1.5 text-[var(--accent-red)] hover:bg-[var(--accent-red)]/10 rounded transition-colors text-sm font-bold" title="Remove path">
        −
      </button>
    `;

    const input = row.querySelector('input');
    const addBtn = row.querySelector('.add-path-btn');
    const removeBtn = row.querySelector('.remove-path-btn');

    input.addEventListener('change', () => {
      _saveAndSyncSyzygyPaths();
    });

    addBtn.addEventListener('click', () => {
      let currentPaths = _getSyzygyPathsFromUI();
      currentPaths.splice(idx + 1, 0, '');
      localStorage.setItem('chess_syzygy_paths', JSON.stringify(currentPaths));
      _renderSyzygyPaths();
    });

    removeBtn.addEventListener('click', () => {
      let currentPaths = _getSyzygyPathsFromUI();
      currentPaths.splice(idx, 1);
      if (currentPaths.length === 0) {
        currentPaths = [''];
      }
      localStorage.setItem('chess_syzygy_paths', JSON.stringify(currentPaths));
      _renderSyzygyPaths();
      _saveAndSyncSyzygyPaths();
    });

    container.appendChild(row);
  });
}

function _getSyzygyPathsFromUI() {
  const container = document.getElementById('syzygy-paths-container');
  if (!container) return [];
  const inputs = container.querySelectorAll('input');
  return Array.from(inputs).map(inp => inp.value);
}

function _saveAndSyncSyzygyPaths() {
  const paths = _getSyzygyPathsFromUI();
  localStorage.setItem('chess_syzygy_paths', JSON.stringify(paths));

  const nonMptyPaths = paths.map(p => p.trim()).filter(p => p.length > 0);
  const combined = nonMptyPaths.join(';');

  _sendSyzygyPathsToBackend(combined);

  if (state.liveEngineEnabled || state.liveReviewEnabled) _restartCurrentAnalysis();
}

async function _sendSyzygyPathsToBackend(combinedPath) {
  try {
    const res = await fetch(`${API_BASE}/api/settings/syzygy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syzygy_path: combinedPath })
    });
    if (!res.ok) {
      console.error('Failed to update Syzygy paths on backend:', res.statusText);
    }
  } catch (err) {
    console.error('Error sending Syzygy settings:', err);
  }
}

// ── Health Check ────────────────────────────────────────────────────────

async function _checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const data = await res.json();
    const banner = document.getElementById('engine-setup-banner');
    if (!data.engine?.ready) {
      if (banner) banner.classList.remove('hidden');
      const errorMsg = data.engine?.error || `Stockfish not found — set "stockfish_path" in config.json`;
      showToast(
        errorMsg,
        'error',
        8000
      );
    } else {
      if (banner) banner.classList.add('hidden');
      // Initialize depth slider value from backend config
      if (data.engine?.depth) {
        if (el.depthSlider) {
          const idx = getClosestDepthIndex(data.engine.depth);
          el.depthSlider.value = idx;
          if (el.depthValue) el.depthValue.textContent = DEPTH_VALUES[idx];
        }
      }
    }
  } catch (e) {
    showToast('Cannot reach backend server. Make sure start.bat is running.', 'error', 8000);
  }
}

// ── Control Binding ─────────────────────────────────────────────────────

function _bindControls() {
  // Import and Analyze buttons
  el.importBtn?.addEventListener('click', importPgn);
  el.analyzeBtn?.addEventListener('click', submitAnalysis);

  // PGN input — submit on Ctrl+Enter, dynamic analysis button state
  el.pgnInput?.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') importPgn();
  });
  el.pgnInput?.addEventListener('input', () => {
    const val = el.pgnInput.value.trim();
    if (el.analyzeBtn) {
      el.analyzeBtn.disabled = !val || isValidFen(val);
    }
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
    const idx = parseInt(el.depthSlider.value, 10);
    const depthVal = DEPTH_VALUES[idx] || 16;
    if (el.depthValue) el.depthValue.textContent = depthVal;
  });

  // Overlay Toggle
  el.btnToggleOverlay?.addEventListener('click', () => {
    state.overlayPriority = state.overlayPriority === 'classification' ? 'annotation' : 'classification';
    el.btnToggleOverlay.textContent = state.overlayPriority === 'classification' ? 'Class' : 'Annot';
    _redrawCurrentMoveOverlay();
    _triggerMoveListRender();
    if (state.mode === MODE.ANALYSIS) {
      setActiveMoveInList('branch', state.analysis.currentBranchIndex);
    } else {
      setActiveMoveInList('main', state.review.currentIndex);
    }
  });

  // Tabs
  el.tabImport?.addEventListener('click', () => _switchTab('import'));
  el.tabSummary?.addEventListener('click', () => _switchTab('summary'));
  el.tabMoves?.addEventListener('click', () => _switchTab('moves'));

  // Live Engine Toggle
  el.liveEngineToggle?.addEventListener('change', (e) => {
    state.liveEngineEnabled = e.target.checked;
    if (el.liveEngineDot) {
      el.liveEngineDot.style.background = state.liveEngineEnabled ? '#81b64c' : '';
    }
    _handleLiveEngineToggle();
  });

  // Live Review Toggle
  el.liveReviewToggle?.addEventListener('change', (e) => {
    state.liveReviewEnabled = e.target.checked;
    if (el.liveReviewDot) {
      el.liveReviewDot.style.background = state.liveReviewEnabled ? '#f7c631' : '';
    }
    _handleLiveReviewToggle();
  });

  // Best Moves Toggle
  el.bestMovesToggle?.addEventListener('change', (e) => {
    state.bestMovesEnabled = e.target.checked;
    if (el.bestMovesDot) {
      el.bestMovesDot.style.background = state.bestMovesEnabled ? '#98bc49' : '';
    }
    _redrawBoardArrows();
  });

  // Threat Assessment Toggle
  el.threatToggle?.addEventListener('change', (e) => {
    state.threatsEnabled = e.target.checked;
    if (el.threatDot) {
      el.threatDot.style.background = state.threatsEnabled ? '#ca3431' : '';
    }
    if (state.threatsEnabled) {
      _fetchAndDrawThreats();
    } else {
      _redrawBoardArrows();
    }
  });

  // Live settings change — re-trigger analysis with new limits
  el.liveDepthInput?.addEventListener('change', () => {
    if (state.liveEngineEnabled || state.liveReviewEnabled) _restartCurrentAnalysis();
  });
  el.liveTimeoutInput?.addEventListener('change', () => {
    if (state.liveEngineEnabled || state.liveReviewEnabled) _restartCurrentAnalysis();
  });

  // Sidebar navigation and Modals
  el.sidebarNavAnalysis?.addEventListener('click', () => {
    _switchTab('moves');
  });

  el.sidebarNavImport?.addEventListener('click', () => {
    _switchTab('import');
  });

  el.sidebarNavSettings?.addEventListener('click', () => {
    // Sync depth and timeout from current live settings inputs
    if (el.settingsDepth && el.liveDepthInput) el.settingsDepth.value = el.liveDepthInput.value;
    if (el.settingsTimeout && el.liveTimeoutInput) el.settingsTimeout.value = el.liveTimeoutInput.value;

    el.settingsModal?.classList.remove('hidden');
  });

  el.sidebarNavAbout?.addEventListener('click', () => {
    el.aboutModal?.classList.remove('hidden');
  });

  el.sidebarNavTraining?.addEventListener('click', () => {
    _switchTab('training');
  });

  // Modal close buttons
  el.closeSettings?.addEventListener('click', () => {
    el.settingsModal?.classList.add('hidden');
  });

  el.closeAbout?.addEventListener('click', () => {
    el.aboutModal?.classList.add('hidden');
  });

  // Click outside to close modals
  el.settingsModal?.addEventListener('click', (e) => {
    if (e.target === el.settingsModal) el.settingsModal.classList.add('hidden');
  });

  el.aboutModal?.addEventListener('click', (e) => {
    if (e.target === el.aboutModal) el.aboutModal.classList.add('hidden');
  });

  // Settings inputs sync
  el.settingsDepth?.addEventListener('change', () => {
    if (el.liveDepthInput) {
      el.liveDepthInput.value = el.settingsDepth.value;
      if (state.liveEngineEnabled || state.liveReviewEnabled) _restartCurrentAnalysis();
    }
  });

  // Sync back to settings from bottom bar inputs
  el.liveDepthInput?.addEventListener('change', () => {
    if (el.settingsDepth) el.settingsDepth.value = el.liveDepthInput.value;
  });

  el.liveTimeoutInput?.addEventListener('change', () => {
    if (el.settingsTimeout) el.settingsTimeout.value = el.liveTimeoutInput.value;
  });

  el.settingsTimeout?.addEventListener('change', () => {
    if (el.liveTimeoutInput) {
      el.liveTimeoutInput.value = el.settingsTimeout.value;
      if (state.liveEngineEnabled || state.liveReviewEnabled) _restartCurrentAnalysis();
    }
  });

  // Dynamic Syzygy path inputs handle their own change listeners

  // Chessboard theme buttons click
  document.querySelectorAll('.theme-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-select-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const theme = btn.dataset.theme;
      const boardEl = document.getElementById('board');
      if (boardEl) {
        boardEl.className = '';
        boardEl.classList.add('theme-' + theme);
      }
      localStorage.setItem('chess_theme', theme);
      showToast(`Chessboard theme changed to ${theme}`, 'success');
    });
  });

  // Chess.com Loader bindings
  el.chesscomFetchBtn?.addEventListener('click', () => fetchChesscomGames());
  el.chesscomUsername?.addEventListener('keydown', e => {
    if (e.key === 'Enter') fetchChesscomGames();
  });
  el.chesscomArchiveSelect?.addEventListener('change', e => {
    const selectedArchive = e.target.value;
    if (selectedArchive) {
      fetchChesscomGames(selectedArchive);
    }
  });
  el.chesscomGamesList?.addEventListener('click', e => {
    const card = e.target.closest('.chesscom-game-card');
    if (!card) return;
    const index = parseInt(card.dataset.index, 10);
    selectChesscomGame(index);
  });

  // FEN Loader bindings
  el.fenLoadBtn?.addEventListener('click', loadFen);
  el.fenResetBtn?.addEventListener('click', resetFen);
  el.fenInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') loadFen();
  });

  // Sound toggle button binding
  el.btnSound?.addEventListener('click', () => {
    board.soundEnabled = !board.soundEnabled;
    localStorage.setItem('chess_sound_enabled', board.soundEnabled);
    _updateSoundButtonUI();
  });
}

function _updateSoundButtonUI() {
  if (!el.soundOnIcon || !el.soundOffIcon) return;
  if (board.soundEnabled) {
    el.soundOnIcon.classList.remove('hidden');
    el.soundOffIcon.classList.add('hidden');
  } else {
    el.soundOnIcon.classList.add('hidden');
    el.soundOffIcon.classList.remove('hidden');
  }
}

function _setToggleDisabled(toggleEl, dotEl, labelEl, disabled, colorCode) {
  if (!toggleEl) return;
  toggleEl.disabled = disabled;
  if (disabled) {
    if (labelEl) labelEl.classList.add('opacity-40', 'pointer-events-none');
    if (dotEl) dotEl.style.background = '';
    toggleEl.checked = false;
  } else {
    if (labelEl) labelEl.classList.remove('opacity-40', 'pointer-events-none');
    if (dotEl) dotEl.style.background = toggleEl.checked ? colorCode : '';
  }
}

function _handleLiveEngineToggle() {
  if (state.liveEngineEnabled) {
    // 1. Enable dependent toggles
    _setToggleDisabled(el.bestMovesToggle, el.bestMovesDot, el.bestMovesLabel, false, '#98bc49');
    _setToggleDisabled(el.liveReviewToggle, el.liveReviewDot, el.liveReviewLabel, false, '#f7c631');
    _setToggleDisabled(el.threatToggle, el.threatDot, el.threatLabel, false, '#ca3431');

    // 2. Restore state variables
    state.bestMovesEnabled = state.savedBestMovesEnabled;
    state.liveReviewEnabled = state.savedLiveReviewEnabled;
    state.threatsEnabled = state.savedThreatsEnabled;

    // 3. Restore checked states in DOM
    if (el.bestMovesToggle) el.bestMovesToggle.checked = state.bestMovesEnabled;
    if (el.liveReviewToggle) el.liveReviewToggle.checked = state.liveReviewEnabled;
    if (el.threatToggle) el.threatToggle.checked = state.threatsEnabled;

    // 4. Update dot backgrounds based on restored checkbox states
    if (el.bestMovesDot) el.bestMovesDot.style.background = state.bestMovesEnabled ? '#98bc49' : '';
    if (el.liveReviewDot) el.liveReviewDot.style.background = state.liveReviewEnabled ? '#f7c631' : '';
    if (el.threatDot) el.threatDot.style.background = state.threatsEnabled ? '#ca3431' : '';

    // 5. Start WebSocket analysis and fetch threats/reviews as needed
    const fen = _getCurrentFen();
    _startWebSocketAnalysis(fen);
    if (state.threatsEnabled) {
      _fetchAndDrawThreats();
    }
    _triggerMoveListRender();
  } else {
    // 1. Save current states
    state.savedBestMovesEnabled = state.bestMovesEnabled;
    state.savedLiveReviewEnabled = state.liveReviewEnabled;
    state.savedThreatsEnabled = state.threatsEnabled;

    // 2. Clear state variables
    state.bestMovesEnabled = false;
    state.liveReviewEnabled = false;
    state.threatsEnabled = false;

    // 3. Disable all dependent toggles visually and functionally
    _setToggleDisabled(el.bestMovesToggle, el.bestMovesDot, el.bestMovesLabel, true, '#98bc49');
    _setToggleDisabled(el.liveReviewToggle, el.liveReviewDot, el.liveReviewLabel, true, '#f7c631');
    _setToggleDisabled(el.threatToggle, el.threatDot, el.threatLabel, true, '#ca3431');

    // 4. Teardown websocket and clean up engine indicators
    _teardownWebSocket();
    if (el.engineSpinner) el.engineSpinner.classList.add('hidden');
    if (el.badgeDot) el.badgeDot.style.animation = 'none';

    state.analysis.latestLines = [];
    _redrawBoardArrows();
    if (el.engineDepthBadge) el.engineDepthBadge.classList.add('hidden');
    if (el.engineLinesPanel) el.engineLinesPanel.classList.add('hidden');

    _triggerEvalBarRender();
    _triggerMoveListRender();
  }
}

function _handleLiveReviewToggle() {
  if (state.liveReviewEnabled) {
    const fen = _getCurrentFen();
    if (!state.analysis.ws) {
      _startWebSocketAnalysis(fen);
    } else {
      if (state.mode === MODE.ANALYSIS && state.analysis.branchMoves.length > 0) {
        const activeBranch = state.analysis.branchMoves[state.analysis.currentBranchIndex];
        if (activeBranch && (!activeBranch.classification || activeBranch.classification === 'theory') && state.analysis.latestLines?.[0]) {
          _classifyLiveMove(state.analysis.latestLines[0]);
        }
      }
    }
    _triggerMoveListRender();
  } else {
    if (!state.liveEngineEnabled) {
      _teardownWebSocket();
      if (el.engineSpinner) el.engineSpinner.classList.add('hidden');
      if (el.badgeDot) el.badgeDot.style.animation = 'none';
    }
    _triggerMoveListRender();
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

let currentAnalysisController = null;

function destroyApp() {
  if (state.mode === MODE.ANALYSIS) _teardownWebSocket();
  if (currentAnalysisController) currentAnalysisController.abort();
  board.destroy();
}

function _drawMarkersForMove(from, to, m) {
  let classification = m.classification;
  let annotationObj = _getAnnotationSymbol(m);

  if (state.overlayPriority === 'annotation' && annotationObj) {
    classification = null; // Suppress classification
  } else if (state.overlayPriority === 'classification' && classification) {
    annotationObj = null; // Suppress annotation
  }

  board.addLastMoveMarkers(from, to, classification, annotationObj, m.color);
}

function _redrawCurrentMoveOverlay() {
  if (state.mode === MODE.REVIEW) {
    if (state.review.currentIndex >= 0) {
      const m = state.game.moves[state.review.currentIndex];
      _drawMarkersForMove(m.uci.slice(0, 2), m.uci.slice(2, 4), m);
    }
  } else if (state.mode === MODE.ANALYSIS) {
    const idx = state.analysis.currentBranchIndex;
    const m = idx === -1
      ? state.game.moves[state.analysis.forkIndex]
      : state.analysis.branchMoves[idx];
    if (m) {
      _drawMarkersForMove(m.uci.slice(0, 2), m.uci.slice(2, 4), m);
    }
  }
}

function _triggerMoveListRender() {
  if (state.mode === MODE.ANALYSIS) {
    renderMoveList(
      state.game.moves,
      _onMoveClick,
      state.analysis.branchMoves,
      state.analysis.forkIndex,
      state.overlayPriority,
      state.liveReviewEnabled,
      state.game.metadata?.result
    );
  } else {
    renderMoveList(
      state.game.moves,
      _onMoveClick,
      [],
      null,
      state.overlayPriority,
      state.liveReviewEnabled,
      state.game.metadata?.result
    );
  }
}

function isValidFen(fen) {
  if (!fen) return false;
  try {
    new Chess(fen);
    return true;
  } catch (e) {
    return false;
  }
}

async function loadFen() {
  stopAutoplay();
  const fen = el.fenInput?.value?.trim();
  if (!fen) {
    showToast('Please enter a FEN string.', 'error');
    return;
  }

  if (!isValidFen(fen)) {
    showToast('Invalid FEN string.', 'error');
    return;
  }

  if (el.fenLoadBtn) el.fenLoadBtn.disabled = true;
  if (el.fenSpinner) el.fenSpinner.classList.remove('hidden');

  try {
    const data = {
      metadata: {
        event: 'Custom Position',
        site: 'Local',
        date: new Date().toISOString().split('T')[0],
        round: '?',
        white: 'White',
        black: 'Black',
        result: '*',
        white_elo: '',
        black_elo: '',
        white_title: '',
        black_title: '',
        depth_used: 0
      },
      moves: [],
      accuracy: {
        white: 100,
        black: 100
      },
      initial_fen: fen
    };
    _loadGameAnalysis(data);
    showToast('FEN Position Loaded!', 'success');

    if (state.liveEngineEnabled) {
      _startWebSocketAnalysis(fen);
    }
  } catch (e) {
    showToast(`Failed to load FEN: ${e.message}`, 'error');
    console.error(e);
  } finally {
    if (el.fenLoadBtn) el.fenLoadBtn.disabled = false;
    if (el.fenSpinner) el.fenSpinner.classList.add('hidden');
  }
}

async function resetFen() {
  if (el.fenInput) {
    el.fenInput.value = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  }
  await loadFen();
  if (el.fenInput) {
    el.fenInput.value = '';
  }
}

async function importPgn() {
  stopAutoplay();
  const pgnText = el.pgnInput?.value?.trim();
  if (!pgnText) {
    showToast('Please paste a PGN or list of moves.', 'error');
    return;
  }

  if (isValidFen(pgnText)) {
    showToast('This is a FEN string. Please use the FEN Position field below to load custom positions.', 'warning', 6000);
    return;
  }

  let pgn = pgnText;
  if (state.game.initialFen && state.game.initialFen !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' && !pgnText.includes('[FEN') && !pgnText.includes('/')) {
    pgn = `[FEN "${state.game.initialFen}"]\n[SetUp "1"]\n\n${pgnText}`;
  }

  if (el.importBtn) el.importBtn.disabled = true;
  if (el.importSpinner) el.importSpinner.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pgn, depth: 18 }), // depth ignored by import
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `Server error ${res.status}` }));
      throw new Error(err.detail);
    }

    const data = await res.json();
    _loadGameAnalysis(data);
    showToast('PGN Imported!', 'success');
    _switchTab('moves');

    if (el.analyzeBtn) el.analyzeBtn.disabled = false;
  } catch (e) {
    showToast(`Import failed: ${e.message}`, 'error', 6000);
    console.error(e);
  } finally {
    if (el.importBtn) el.importBtn.disabled = false;
    if (el.importSpinner) el.importSpinner.classList.add('hidden');
  }
}

async function submitAnalysis() {
  if (currentAnalysisController) {
    // Stop Analysis clicked
    currentAnalysisController.abort();
    currentAnalysisController = null;
    return;
  }

  stopAutoplay();
  const pgnText = el.pgnInput?.value?.trim();
  if (!pgnText) {
    showToast('Please paste a PGN or list of moves.', 'error');
    return;
  }

  if (isValidFen(pgnText)) {
    showToast('Batch analysis is not supported for static FEN positions. Use the FEN field to load the position, and then use the Live Engine.', 'warning', 6000);
    return;
  }

  let pgn = pgnText;
  if (state.game.initialFen && state.game.initialFen !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' && !pgnText.includes('[FEN') && !pgnText.includes('/')) {
    pgn = `[FEN "${state.game.initialFen}"]\n[SetUp "1"]\n\n${pgnText}`;
  }

  const sliderIdx = parseInt(el.depthSlider?.value || '4', 10);
  const depth = DEPTH_VALUES[sliderIdx] || 16;

  // Setup abort controller
  currentAnalysisController = new AbortController();

  // Show loading state
  if (el.analyzeBtnText) el.analyzeBtnText.textContent = 'Stop Analysis';
  if (el.analyzeBtn) {
    el.analyzeBtn.classList.remove('btn-primary');
    el.analyzeBtn.classList.add('btn-danger');
  }
  if (el.analyzeBtnIcon) el.analyzeBtnIcon.classList.add('hidden');
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
      signal: currentAnalysisController.signal,
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

      let finished = false;
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
          finished = true;
          break;
        } else if (msg.type === "error") {
          throw new Error(msg.detail);
        }
      }
      if (finished) break;
    }

  } catch (e) {
    if (e.name === 'AbortError') {
      showToast('Analysis stopped.', 'info');
    } else {
      showToast(`Analysis failed: ${e.message}`, 'error', 6000);
      console.error(e);
    }
  } finally {
    currentAnalysisController = null;
    if (el.analyzeBtnText) el.analyzeBtnText.textContent = 'Analyze PGN';
    if (el.analyzeBtn) {
      el.analyzeBtn.classList.add('btn-primary');
      el.analyzeBtn.classList.remove('btn-danger');
    }
    if (el.analyzeBtnIcon) el.analyzeBtnIcon.classList.remove('hidden');
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
  state.game.initialEval = data.initial_eval || null;

  // Reset analysis branch state so stale ghost branches don't render
  state.analysis.branchMoves = [];
  state.analysis.forkIndex = null;
  state.analysis.currentBranchIndex = -1;
  state.analysis.forkFen = null;
  state.analysis.latestLines = [];
  state.analysis.expandedLines = {};

  // Render UI
  _triggerMoveListRender();
  renderScorecard(data.accuracy, data.metadata?.depth_used);
  renderAnnotationsScorecard(data.moves);
  renderEvalChart(data.moves, data.initial_eval);

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

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '';
  return countryCode.toLowerCase();
}

function _calculateCapturedPieces(fen) {
  const starting = {
    w: { p: 8, n: 2, b: 2, r: 2, q: 1 },
    b: { p: 8, n: 2, b: 2, r: 2, q: 1 }
  };

  const current = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0 }
  };

  const boardPart = (fen || '').split(' ')[0];
  for (const char of boardPart) {
    if (char === '/') continue;
    if (/[0-9]/.test(char)) continue;

    const isWhite = char === char.toUpperCase();
    const type = char.toLowerCase();
    const color = isWhite ? 'w' : 'b';

    if (current[color] && current[color][type] !== undefined) {
      current[color][type]++;
    }
  }

  const captured = {
    w: {}, // White pieces captured by Black
    b: {}  // Black pieces captured by White
  };

  for (const type of ['p', 'n', 'b', 'r', 'q']) {
    captured.w[type] = Math.max(0, starting.w[type] - current.w[type]);
    captured.b[type] = Math.max(0, starting.b[type] - current.b[type]);
  }

  const values = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  let whiteVal = 0;
  let blackVal = 0;
  for (const type of ['p', 'n', 'b', 'r', 'q']) {
    whiteVal += current.w[type] * values[type];
    blackVal += current.b[type] * values[type];
  }

  return { captured, whiteVal, blackVal };
}

function _getClockTimesForMove(idx) {
  let whiteClk = null;
  let blackClk = null;
  const reviewMoves = state.game.moves;

  if (!reviewMoves || reviewMoves.length === 0) {
    return { white: null, black: null };
  }

  const maxIdx = Math.min(idx, reviewMoves.length - 1);
  for (let k = 0; k <= maxIdx; k++) {
    const m = reviewMoves[k];
    if (m && m.clk) {
      if (m.color === 'white') {
        whiteClk = m.clk;
      } else {
        blackClk = m.clk;
      }
    }
  }

  if (!whiteClk || !blackClk) {
    for (let k = 0; k < reviewMoves.length; k++) {
      const m = reviewMoves[k];
      if (m && m.clk) {
        if (m.color === 'white' && !whiteClk) whiteClk = m.clk;
        if (m.color === 'black' && !blackClk) blackClk = m.clk;
      }
    }
  }

  return { white: whiteClk, black: blackClk };
}
function parseTimeStrToSeconds(str) {
  if (!str) return null;
  const parts = str.split(':');
  if (parts.length === 3) {
    // h:mm:ss.d or h:mm:ss
    const h = parseFloat(parts[0]) || 0;
    const m = parseFloat(parts[1]) || 0;
    const s = parseFloat(parts[2]) || 0;
    return h * 3600 + m * 60 + s;
  } else if (parts.length === 2) {
    // mm:ss.d or mm:ss
    const m = parseFloat(parts[0]) || 0;
    const s = parseFloat(parts[1]) || 0;
    return m * 60 + s;
  } else if (parts.length === 1) {
    // ss.d or ss
    return parseFloat(parts[0]) || 0;
  }
  return null;
}

function formatClockString(str) {
  if (!str) return '';
  const secondsVal = parseTimeStrToSeconds(str);
  if (secondsVal === null) return str; // fallback to original if parsing fails

  if (secondsVal < 10) {
    // When you go below 10 seconds (e.g. 9.1 seconds), display 9.1 (no minutes)
    return secondsVal.toFixed(1);
  }

  const h = Math.floor(secondsVal / 3600);
  const m = Math.floor((secondsVal % 3600) / 60);
  const s = Math.floor(secondsVal % 60);

  if (h > 0) {
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return `${h}:${mm}:${ss}`;
  } else {
    const ss = String(s).padStart(2, '0');
    return `${m}:${ss}`;
  }
}

function _updatePlayerClocksAndCaptured(idx) {
  let fen = state.game.initialFen;
  if (state.mode === MODE.REVIEW) {
    if (idx >= 0 && state.game.moves[idx]) {
      fen = state.game.moves[idx].fen_after;
    }
  } else if (state.mode === MODE.ANALYSIS) {
    const branchIdx = state.analysis.currentBranchIndex;
    if (branchIdx >= 0 && state.analysis.branchMoves[branchIdx]) {
      fen = state.analysis.branchMoves[branchIdx].fen_after;
    } else {
      fen = state.analysis.forkFen || state.game.initialFen;
    }
  }

  const { captured, whiteVal, blackVal } = _calculateCapturedPieces(fen);

  const getPiecesHtml = (pCount, color) => {
    let html = '';
    // Show in standard sorted order: Pawns, then Bishops, then Knights, then Rooks, then Queens
    const types = ['p', 'b', 'n', 'r', 'q'];
    for (const type of types) {
      const count = pCount[type] || 0;
      if (count > 0) {
        const prefix = color === 'white' ? 'w' : 'b';
        html += `<span class="captured-piece-group">`;
        for (let i = 0; i < count; i++) {
          const pieceId = `${prefix}${type}`;
          html += `<svg class="captured-piece" viewBox="0 0 40 40"><use href="assets/pieces/neo.svg#${pieceId}"></use></svg>`;
        }
        html += `</span>`;
      }
    }
    return html;
  };

  // White pieces captured by Black (displayed on Black's card)
  const whiteCapturedHtml = getPiecesHtml(captured.w, 'white');
  // Black pieces captured by White (displayed on White's card)
  const blackCapturedHtml = getPiecesHtml(captured.b, 'black');

  let whiteDiffHtml = '';
  let blackDiffHtml = '';
  if (whiteVal > blackVal) {
    whiteDiffHtml = `<span class="material-diff text-[10px] font-bold text-[var(--text-secondary)] ml-1 bg-white/10 px-1 py-0.5 rounded leading-none" style="vertical-align: middle;">+${whiteVal - blackVal}</span>`;
  } else if (blackVal > whiteVal) {
    blackDiffHtml = `<span class="material-diff text-[10px] font-bold text-[var(--text-secondary)] ml-1 bg-white/10 px-1 py-0.5 rounded leading-none" style="vertical-align: middle;">+${blackVal - whiteVal}</span>`;
  }

  if (state.boardOrientation === 'white') {
    if (el.topPlayerCaptured) el.topPlayerCaptured.innerHTML = whiteCapturedHtml + blackDiffHtml;
    if (el.bottomPlayerCaptured) el.bottomPlayerCaptured.innerHTML = blackCapturedHtml + whiteDiffHtml;
  } else {
    if (el.topPlayerCaptured) el.topPlayerCaptured.innerHTML = blackCapturedHtml + whiteDiffHtml;
    if (el.bottomPlayerCaptured) el.bottomPlayerCaptured.innerHTML = whiteCapturedHtml + blackDiffHtml;
  }

  const hasClocks = state.game.moves.some(m => m.clk != null);
  if (!hasClocks) {
    if (el.topPlayerClock) el.topPlayerClock.classList.add('hidden');
    if (el.bottomPlayerClock) el.bottomPlayerClock.classList.add('hidden');
  } else {
    if (el.topPlayerClock) el.topPlayerClock.classList.remove('hidden');
    if (el.bottomPlayerClock) el.bottomPlayerClock.classList.remove('hidden');

    const clkTimes = _getClockTimesForMove(idx);
    let topTime = '';
    let bottomTime = '';
    let topIsActive = false;
    let bottomIsActive = false;

    let activeSide = 'white';
    try {
      const c = new Chess(fen);
      if (c.isGameOver()) {
        activeSide = null;
      } else {
        activeSide = c.turn() === 'w' ? 'white' : 'black';
      }
    } catch (e) {
      activeSide = null;
    }

    if (state.boardOrientation === 'white') {
      topTime = formatClockString(clkTimes.black) || '5:00';
      bottomTime = formatClockString(clkTimes.white) || '5:00';
      topIsActive = (activeSide === 'black');
      bottomIsActive = (activeSide === 'white');
    } else {
      topTime = formatClockString(clkTimes.white) || '5:00';
      bottomTime = formatClockString(clkTimes.black) || '5:00';
      topIsActive = (activeSide === 'white');
      bottomIsActive = (activeSide === 'black');
    }

    const activeClockSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="w-3.5 h-3.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;

    if (el.topPlayerClock) {
      if (topIsActive) {
        el.topPlayerClock.innerHTML = `${activeClockSvg} <span>${topTime}</span>`;
        el.topPlayerClock.classList.add('active');
      } else {
        el.topPlayerClock.innerHTML = `<span>${topTime}</span>`;
        el.topPlayerClock.classList.remove('active');
      }
    }

    if (el.bottomPlayerClock) {
      if (bottomIsActive) {
        el.bottomPlayerClock.innerHTML = `${activeClockSvg} <span>${bottomTime}</span>`;
        el.bottomPlayerClock.classList.add('active');
      } else {
        el.bottomPlayerClock.innerHTML = `<span>${bottomTime}</span>`;
        el.bottomPlayerClock.classList.remove('active');
      }
    }
  }
}

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

  const renderAvatar = (avatarEl, flagEl, playerUsername, color) => {
    if (!avatarEl) return;
    avatarEl.style.backgroundImage = 'none';
    avatarEl.textContent = '♚';
    if (flagEl) flagEl.textContent = '';

    const rawUsername = (playerUsername || '').trim();
    if (!rawUsername || rawUsername === 'White' || rawUsername === 'Black' || rawUsername === '?' || rawUsername.includes(' ')) {
      return;
    }

    const cacheKey = rawUsername.toLowerCase();
    if (state.avatarCache[cacheKey] !== undefined) {
      const cached = state.avatarCache[cacheKey];
      if (cached) {
        if (cached.avatar) {
          avatarEl.style.backgroundImage = `url(${cached.avatar})`;
          avatarEl.textContent = '';
        }
        if (flagEl && cached.flag) {
          flagEl.innerHTML = `<img src="https://flagcdn.com/16x12/${cached.flag}.png" width="16" height="12" style="border-radius:2px; display:inline-block; vertical-align:middle;" alt="${cached.flag}">`;
        }
      }
      return;
    }

    state.avatarCache[cacheKey] = null; // Mark as pending

    fetch(`https://api.chess.com/pub/player/${encodeURIComponent(rawUsername)}`)
      .then(res => {
        if (!res.ok) throw new Error("Not found");
        return res.json();
      })
      .then(data => {
        let flag = '';
        if (data.country) {
          const parts = data.country.split('/');
          const countryCode = parts[parts.length - 1];
          if (countryCode && countryCode.length === 2) {
            flag = getFlagEmoji(countryCode);
          }
        }
        state.avatarCache[cacheKey] = {
          avatar: data.avatar || null,
          flag: flag || null
        };
        _updatePlayerCards(); // Refresh display
      })
      .catch(err => {
        console.warn(`Failed to fetch Chess.com avatar for ${rawUsername}:`, err);
      });
  };

  renderAvatar(el.topPlayerAvatar, el.topPlayerFlag, top.name, top.color);
  renderAvatar(el.bottomPlayerAvatar, el.bottomPlayerFlag, bottom.name, bottom.color);

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

  // Also trigger clocks and captured pieces rendering
  let activeIndex = state.review.currentIndex;
  if (state.mode === MODE.ANALYSIS) {
    activeIndex = state.analysis.currentBranchIndex;
  }
  _updatePlayerClocksAndCaptured(activeIndex);
}

function _triggerEvalBarRender() {
  if (state.liveEngineEnabled && state.analysis.latestLines?.[0]) {
    const line = state.analysis.latestLines[0];
    renderEvalBar(line.white_cp, line.score_mate, line.game_over, line.winner, state.boardOrientation, line.white_win_prob);
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
      renderEvalBar(m.white_cp || 0, m.score_mate, gameOver, winner, state.boardOrientation, m.white_win_prob);
    } else {
      // At the starting position — use the initial eval from analysis if available
      const initEval = state.game.initialEval;
      if (initEval) {
        renderEvalBar(initEval.white_cp || 0, initEval.score_mate || null, false, null, state.boardOrientation);
      } else {
        renderEvalBar(0, null, false, null, state.boardOrientation);
      }
    }
  } else if (state.mode === MODE.ANALYSIS) {
    if (state.liveEngineEnabled) {
      const activeBranch = state.analysis.branchMoves[state.analysis.currentBranchIndex];
      if (activeBranch) {
        const c = new Chess(activeBranch.fen_after);
        const gameOver = c.isGameOver();
        let winner = null;
        if (c.isCheckmate()) {
          winner = c.turn() === 'w' ? 'black' : 'white';
        }
        renderEvalBar(activeBranch.white_cp || 0, activeBranch.mate_played, gameOver, winner, state.boardOrientation, activeBranch.white_win_prob);
      } else {
        renderEvalBar(0, null, false, null, state.boardOrientation);
      }
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
      if (el.openingName) {
        el.openingName.textContent = m.opening || '';
      }
      const from = m.uci.slice(0, 2);
      const to = m.uci.slice(2, 4);
      _drawMarkersForMove(from, to, m);
    } else {
      if (el.openingName) {
        el.openingName.textContent = 'Starting Position';
      }
      board.clearMarkers();
    }
  } else {
    const m = state.analysis.branchMoves[idx];
    if (el.openingName) {
      el.openingName.textContent = m.opening || '';
    }
    const from = m.uci.slice(0, 2);
    const to = m.uci.slice(2, 4);
    _drawMarkersForMove(from, to, m);
  }

  setActiveMoveInList('branch', idx);
  _updatePgnInput();

  state.latestThreats = [];
  state.analysis.latestLines = [];
  _redrawBoardArrows();

  if (state.liveEngineEnabled || state.liveReviewEnabled) {
    _startWebSocketAnalysis(fen);
  }
  if (state.threatsEnabled) {
    _fetchAndDrawThreats();
  }
  _updatePlayerClocksAndCaptured(state.analysis.forkIndex);
}

function _getAnnotationSymbol(m) {
  if (m.nags && m.nags.length > 0) {
    for (const code of m.nags) {
      if (COMPREHENSIVE_NAG_MAP[code]) {
        return COMPREHENSIVE_NAG_MAP[code];
      }
    }
  }
  return null;
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
    _drawMarkersForMove(from, to, m);

    // Eval bar (from White's perspective)
    if (!state.liveEngineEnabled) {
      const c = new Chess(fen);
      let gameOver = c.isGameOver();
      let winner = null;
      if (c.isCheckmate()) {
        winner = c.turn() === 'w' ? 'black' : 'white';
      }
      renderEvalBar(m.white_cp || 0, m.score_mate, gameOver, winner, state.boardOrientation, m.white_win_prob);
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
      const initEval = state.game.initialEval;
      if (initEval) {
        renderEvalBar(initEval.white_cp || 0, initEval.score_mate || null, false, null, state.boardOrientation);
      } else {
        renderEvalBar(0, null, false, null, state.boardOrientation);
      }
    }
    if (el.openingName) el.openingName.textContent = 'Starting Position';
    highlightChartMove(-1);
  }

  // Move list highlight
  setActiveMoveInList('main', clampedIndex);

  // Nav button states
  _updateNavButtons();

  state.latestThreats = [];
  state.analysis.latestLines = [];
  _redrawBoardArrows();

  // Update live engine if enabled
  if (state.liveEngineEnabled && state.mode === MODE.REVIEW) {
    _startWebSocketAnalysis(fen);
  }
  if (state.threatsEnabled) {
    _fetchAndDrawThreats();
  }
  _updatePlayerClocksAndCaptured(clampedIndex);
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
    _drawMarkersForMove(from, to, m);

    _startWebSocketAnalysis(m.fen_after);
    setActiveMoveInList('branch', index);
    _updatePlayerClocksAndCaptured(state.analysis.forkIndex);
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
  if (state.mode === MODE.TRAINING) {
    TrainingModule.handleMove(from, to, promotion);
    return;
  }
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
    const mateBestPlies = (state.liveEngineEnabled && state.analysis.latestLines?.[0])
      ? state.analysis.latestLines[0].score_mate
      : (idx + 1 < state.game.moves.length ? state.game.moves[idx + 1].score_mate : null);
    const mateSecondPlies = (state.liveEngineEnabled && state.analysis.latestLines?.[1])
      ? state.analysis.latestLines[1].score_mate
      : null;

    _enterAnalysisMode(fen, idx, true);
    state.analysis.chess.move(moveResult.san);

    const mateBestMoves = getMateMoves(mateBestPlies, moveResult.color === 'w' ? 'white' : 'black');
    const mateSecondMoves = getMateMoves(mateSecondPlies, moveResult.color === 'w' ? 'white' : 'black');

    state.analysis.branchMoves = [{
      move_number: parseInt(fen.split(' ')[5], 10) || 1,
      color: moveResult.color === 'w' ? 'white' : 'black',
      san: moveResult.san,
      uci: moveResult.from + moveResult.to + (moveResult.promotion || ''),
      fen_before: fen,
      fen_after: newFen,
      cp_best: cpBest,
      cp_second: cpSecond,
      cp_played: null,
      white_cp: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].white_cp || 0) : 0,
      white_win_prob: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].white_win_prob || 0.5) : 0.5,
      white_win: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].white_win || 0.33) : 0.33,
      black_win: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].black_win || 0.33) : 0.33,
      draw_prob: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].draw_prob || 0.34) : 0.34,
      best_uci: (state.liveEngineEnabled && state.analysis.latestLines?.[0] && state.analysis.latestLines[0].pv?.length > 0)
        ? state.analysis.latestLines[0].pv[0]
        : null,
      mate_best: mateBestMoves,
      mate_second: mateSecondMoves,
      mate_played: null,
      wdl_best: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].wdl || null) : null,
      wdl_second: (state.liveEngineEnabled && state.analysis.latestLines?.[1]) ? (state.analysis.latestLines[1].wdl || null) : null,
      classification: null,
      moveResult: moveResult
    }];
    state.analysis.currentBranchIndex = 0;

    _triggerMoveListRender();
    setActiveMoveInList('branch', 0);
    _updatePgnInput();
    board.addLastMoveMarkers(from, to, null); // Clear old badge, show new move squares
    _checkTheory(0);

    if (state.liveEngineEnabled || state.liveReviewEnabled) {
      _startWebSocketAnalysis(newFen);
    }
    if (state.threatsEnabled) {
      _fetchAndDrawThreats();
    }
    _updatePlayerClocksAndCaptured(state.analysis.forkIndex);
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
    board.setPosition(newFen, false);

    const cpBest = state.analysis.latestLines?.[0]?.score_cp || 0;
    const cpSecond = state.analysis.latestLines?.[1]?.score_cp || cpBest;

    const bIdx = state.analysis.currentBranchIndex;
    state.analysis.branchMoves = state.analysis.branchMoves.slice(0, bIdx + 1);

    const mateBestPlies = state.analysis.latestLines?.[0]?.score_mate ?? null;
    const mateBestMoves = getMateMoves(mateBestPlies, moveResult.color === 'w' ? 'white' : 'black');
    const mateSecondPlies = state.analysis.latestLines?.[1]?.score_mate ?? null;
    const mateSecondMoves = getMateMoves(mateSecondPlies, moveResult.color === 'w' ? 'white' : 'black');

    state.analysis.branchMoves.push({
      move_number: parseInt(fenBefore.split(' ')[5], 10) || 1,
      color: moveResult.color === 'w' ? 'white' : 'black',
      san: moveResult.san,
      uci: moveResult.from + moveResult.to + (moveResult.promotion || ''),
      fen_before: fenBefore,
      fen_after: newFen,
      cp_best: cpBest,
      cp_second: cpSecond,
      cp_played: null,
      white_cp: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].white_cp || 0) : 0,
      white_win_prob: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].white_win_prob || 0.5) : 0.5,
      white_win: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].white_win || 0.33) : 0.33,
      black_win: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].black_win || 0.33) : 0.33,
      draw_prob: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].draw_prob || 0.34) : 0.34,
      best_uci: (state.liveEngineEnabled && state.analysis.latestLines?.[0] && state.analysis.latestLines[0].pv?.length > 0)
        ? state.analysis.latestLines[0].pv[0]
        : null,
      mate_best: mateBestMoves,
      mate_second: mateSecondMoves,
      mate_played: null,
      wdl_best: (state.liveEngineEnabled && state.analysis.latestLines?.[0]) ? (state.analysis.latestLines[0].wdl || null) : null,
      wdl_second: (state.liveEngineEnabled && state.analysis.latestLines?.[1]) ? (state.analysis.latestLines[1].wdl || null) : null,
      classification: null,
      moveResult: moveResult
    });
    state.analysis.currentBranchIndex = state.analysis.branchMoves.length - 1;

    _triggerMoveListRender();
    setActiveMoveInList('branch', state.analysis.currentBranchIndex);
    _updatePgnInput();
    board.addLastMoveMarkers(from, to, null); // Clear old badge, show new move squares
    _checkTheory(state.analysis.currentBranchIndex);

    if (state.liveEngineEnabled || state.liveReviewEnabled) {
      _startWebSocketAnalysis(newFen);
    }
    if (state.threatsEnabled) {
      _fetchAndDrawThreats();
    }
    _updatePlayerClocksAndCaptured(state.analysis.forkIndex);
  }
}

// ── Analysis (On-Demand) Mode ───────────────────────────────────────────

function _enterAnalysisMode(fen, gameIndex, skipRedraw = false) {
  state.mode = MODE.ANALYSIS;
  state.analysis.forkFen = fen;
  state.analysis.forkIndex = gameIndex;
  state.analysis.chess = new Chess(fen);
  state.analysis.latestLines = [];

  _setMode(MODE.ANALYSIS);

  if (!skipRedraw) {
    board.setPosition(fen, false);
  }

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

// ── Threat Assessment ───────────────────────────────────────────────────

let lastThreatFen = null;

async function _fetchAndDrawThreats() {
  if (!state.threatsEnabled) return;

  const fen = _getCurrentFen();
  lastThreatFen = fen;

  // Retrieve current evaluation score (white_cp)
  let whiteCp = 0;
  if (state.liveEngineEnabled && state.analysis.latestLines?.[0]) {
    whiteCp = state.analysis.latestLines[0].white_cp || 0;
  } else if (state.mode === MODE.REVIEW) {
    const idx = state.review.currentIndex;
    whiteCp = idx >= 0 ? (state.game.moves[idx].white_cp || 0) : 0;
  } else if (state.mode === MODE.ANALYSIS) {
    const idx = state.analysis.currentBranchIndex;
    whiteCp = idx >= 0 ? (state.analysis.branchMoves[idx].white_cp || 0) : 0;
  }

  try {
    const res = await fetch(`${API_BASE}/api/threats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen, current_eval_cp: whiteCp })
    });
    if (!res.ok) return;
    const data = await res.json();

    // Verify the FEN hasn't changed since the request was initiated
    if (lastThreatFen === fen && state.threatsEnabled) {
      state.latestThreats = data.threats;
      _redrawBoardArrows();
    }
  } catch (err) {
    console.error('Failed to fetch threats:', err);
  }
}

function _redrawBoardArrows() {
  const engineLines = (state.liveEngineEnabled && state.bestMovesEnabled) ? state.analysis.latestLines.filter(Boolean) : [];
  const threats = state.threatsEnabled ? state.latestThreats : [];
  board.drawAllArrows(engineLines, threats);
}

// ── WebSocket Management ────────────────────────────────────────────────

function _startWebSocketAnalysis(fen) {
  const needsAnalysis = state.liveEngineEnabled || (state.mode === MODE.ANALYSIS && state.liveReviewEnabled);
  if (!needsAnalysis) return;

  // Clear previous arrows and analysis lines when analyzing a new position
  state.analysis.latestLines = [];
  state.analysis.expandedLines = {};
  _redrawBoardArrows();
  if (el.engineSpinner) el.engineSpinner.classList.remove('hidden');
  if (el.badgeDot) el.badgeDot.style.animation = 'blink-dot 1s ease-in-out infinite';

  const depth = parseInt(el.liveDepthInput?.value || '18', 10);
  const timeout = parseInt(el.liveTimeoutInput?.value || '0', 10);

  // If we already have a WS, just send the new FEN (the backend handles cancellation)
  if (state.analysis.ws && state.analysis.ws.readyState === WebSocket.OPEN) {
    state.analysis.ws.send(JSON.stringify({ type: 'set_fen', fen, depth, timeout }));
    return;
  }

  if (state.analysis.ws && state.analysis.ws.readyState === WebSocket.CONNECTING) {
    _teardownWebSocket();
  }

  // Create a new WebSocket connection
  const ws = new WebSocket(WS_URL);
  state.analysis.ws = ws;

  ws.addEventListener('open', () => {
    if (state.analysis.ws === ws) {
      ws.send(JSON.stringify({ type: 'set_fen', fen, depth, timeout }));
    }
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
  const needsEngine = state.liveEngineEnabled || (state.mode === MODE.ANALYSIS && state.liveReviewEnabled);
  if (!needsEngine) return;

  if (msg.type === 'info' && msg.fen && normFen(msg.fen) !== normFen(_getCurrentFen())) {
    console.log('[live engine] Discarding stale info message for FEN:', msg.fen);
    return;
  }

  if (msg.type === 'done') {
    if (el.engineSpinner) el.engineSpinner.classList.add('hidden');
    if (el.badgeDot) el.badgeDot.style.animation = 'none';
    if (state.threatsEnabled) {
      _fetchAndDrawThreats();
    }

    // Fallback: classify if engine finishes before target depth
    if (state.liveReviewEnabled && state.analysis.branchMoves && state.analysis.branchMoves.length > 0) {
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

      if (state.liveEngineEnabled) {
        // Draw arrows for all known lines
        _redrawBoardArrows();

        // Update Engine Lines panel
        _updateEngineLinesPanel();
      }

      // Update eval bar with MultiPV 1 (best line)
      if (msg.multipv === 1) {
        if (state.liveEngineEnabled) {
          renderEvalBar(msg.white_cp, msg.score_mate, msg.game_over, msg.winner, state.boardOrientation, msg.white_win_prob);
          if (el.engineDepthBadge) {
            el.engineDepthBadge.classList.remove('hidden');
            el.engineDepthBadge.textContent = `depth ${msg.depth}`;
          }
        }

        // Classify branch move if pending or holding temporary theory badge
        if (state.liveReviewEnabled && state.analysis.branchMoves && state.analysis.branchMoves.length > 0) {
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
    const data = await res.json();
    const activeBranch = state.analysis.branchMoves[branchIndex];
    if (activeBranch) {
      activeBranch.opening = data.opening || '';
    }
    if (el.openingName) {
      el.openingName.textContent = data.opening || '';
    }

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
            _triggerMoveListRender();

            const from = activeBranch.uci.slice(0, 2);
            const to = activeBranch.uci.slice(2, 4);
            _drawMarkersForMove(from, to, activeBranch);
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
    activeBranch.white_win_prob = msg.white_win_prob;
    activeBranch.white_win = msg.white_win;
    activeBranch.black_win = msg.black_win;
    activeBranch.draw_prob = msg.draw_prob;

    const matePlayedMoves = getMateMoves(msg.score_mate, activeBranch.color);
    activeBranch.mate_played = matePlayedMoves;

    let wdlPlayed = null;
    if (msg.wdl) {
      wdlPlayed = {
        win: msg.wdl.loss,
        draw: msg.wdl.draw,
        loss: msg.wdl.win
      };
    }

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
        mate_second: activeBranch.mate_second || null,
        cp_played: cpPlayed,
        mate_played: matePlayedMoves,
        is_book: activeBranch.is_theory || false,
        wdl_best: activeBranch.wdl_best || null,
        wdl_second: activeBranch.wdl_second || null,
        wdl_played: wdlPlayed
      })
    });
    if (!res.ok) throw new Error("Classification API failed");
    const data = await res.json();
    activeBranch.classification = data.classification;
  } catch (err) {
    console.error("Classification error:", err);
    activeBranch.classification = "good";
  }

  _triggerMoveListRender();
  setActiveMoveInList('branch', state.analysis.currentBranchIndex);

  const from = activeBranch.uci.slice(0, 2);
  const to = activeBranch.uci.slice(2, 4);
  _drawMarkersForMove(from, to, activeBranch);
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
  if (tab === 'training') {
    if (state.mode === MODE.ANALYSIS) {
      exitAnalysisMode();
    }
    document.getElementById('review-dashboard')?.classList.add('hidden');
    document.getElementById('training-dashboard')?.classList.remove('hidden');
    _setMode(MODE.TRAINING);
    TrainingModule.switchMode('hub');

    el.sidebarNavTraining?.classList.add('active');
    el.sidebarNavAnalysis?.classList.remove('active');
    el.sidebarNavImport?.classList.remove('active');
    el.sidebarNavSettings?.classList.remove('active');
    el.sidebarNavAbout?.classList.remove('active');
    return;
  }

  document.getElementById('training-dashboard')?.classList.add('hidden');
  document.getElementById('review-dashboard')?.classList.remove('hidden');

  if (state.mode === MODE.TRAINING) {
    _setMode(state.game.moves.length > 0 ? MODE.REVIEW : MODE.IDLE);
    if (state.mode === MODE.REVIEW) {
      navigateTo(state.review.currentIndex);
    } else {
      board.setPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      board.disableInteraction();
    }
  }

  const tabs = ['import', 'summary', 'moves'];
  tabs.forEach(t => {
    const tabBtn = el[`tab${t.charAt(0).toUpperCase() + t.slice(1)}`] || document.getElementById(`tab-${t}`);
    const panelEl = el[`panel${t.charAt(0).toUpperCase() + t.slice(1)}`] || document.getElementById(`panel-${t}`);
    if (tabBtn) tabBtn.classList.toggle('active', t === tab);
    if (panelEl) panelEl.classList.toggle('hidden', t !== tab);
  });

  // Sync sidebar active state
  if (el.sidebarNavAnalysis && el.sidebarNavImport) {
    if (tab === 'import') {
      el.sidebarNavImport.classList.add('active');
      el.sidebarNavAnalysis.classList.remove('active');
    } else {
      el.sidebarNavAnalysis.classList.add('active');
      el.sidebarNavImport.classList.remove('active');
    }
    el.sidebarNavTraining?.classList.remove('active');
    el.sidebarNavSettings?.classList.remove('active');
    el.sidebarNavAbout?.classList.remove('active');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function _getLegalMoves(square) {
  let fen;
  if (state.mode === MODE.TRAINING) {
    fen = TrainingModule.getFenForLegalMoves();
  } else if (state.mode === MODE.IDLE) {
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

  const val = pgnStr.trim();
  el.pgnInput.value = val;
  if (el.analyzeBtn) {
    el.analyzeBtn.disabled = !val || isValidFen(val);
  }
}
function playEngineLineSequence(pvMoves, targetIndex) {
  const wasEngineEnabled = state.liveEngineEnabled;
  state.liveEngineEnabled = false;

  const movesToPlay = pvMoves.slice(0, targetIndex + 1);
  for (let i = 0; i < movesToPlay.length; i++) {
    const uci = movesToPlay[i];
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;

    if (i === movesToPlay.length - 1) {
      state.liveEngineEnabled = wasEngineEnabled;
    }

    _handleBoardMove(from, to, promotion);
  }
}

window.toggleEngineLine = function (idx) {
  state.analysis.expandedLines[idx] = !state.analysis.expandedLines[idx];
  _updateEngineLinesPanel();
};

window.playEngineLine = function (lineIndex, moveIndex) {
  let pv = null;
  if (lineIndex === -1) {
    const activeIndex = state.review.currentIndex;
    if (activeIndex >= 0) {
      pv = state.analysis.latestLines[0]?.pv;
      if (!pv && state.game.moves[activeIndex + 1]) {
        pv = state.game.moves[activeIndex + 1].pv1_full;
      }
    }
  } else if (lineIndex === -2) {
    const activeIndex = state.review.currentIndex;
    if (activeIndex >= 0 && state.game.moves[activeIndex]) {
      pv = state.game.moves[activeIndex].pv1_full;
    }
  } else {
    const line = state.analysis.latestLines.filter(Boolean)[lineIndex];
    pv = line?.pv;
  }
  if (!pv) return;
  playEngineLineSequence(pv, moveIndex);
};

function formatSanWithPieceIcon(san, isWhite) {
  const pieceChar = san[0];
  if (['N', 'B', 'R', 'Q', 'K'].includes(pieceChar)) {
    const pieceMap = { 'N': 'n', 'B': 'b', 'R': 'r', 'Q': 'q', 'K': 'k' };
    const colorCode = isWhite ? 'w' : 'b';
    const pieceId = `${colorCode}${pieceMap[pieceChar]}`;
    const rest = san.slice(1);
    return `<span style="display:inline-flex; align-items:center; vertical-align:middle;"><svg style="width:12px; height:12px; margin-right:1px;" viewBox="0 0 40 40"><use href="#${pieceId}"></use></svg>${rest}</span>`;
  }
  const promoIndex = san.indexOf('=');
  if (promoIndex !== -1 && promoIndex < san.length - 1) {
    const promoChar = san[promoIndex + 1];
    if (['N', 'B', 'R', 'Q'].includes(promoChar)) {
      const pieceMap = { 'N': 'n', 'B': 'b', 'R': 'r', 'Q': 'q' };
      const colorCode = isWhite ? 'w' : 'b';
      const pieceId = `${colorCode}${pieceMap[promoChar]}`;
      const prefix = san.slice(0, promoIndex + 1);
      const rest = san.slice(promoIndex + 2);
      return `<span style="display:inline-flex; align-items:center; vertical-align:middle;">${prefix}<svg style="width:12px; height:12px; margin-left:1px; margin-right:1px;" viewBox="0 0 40 40"><use href="#${pieceId}"></use></svg>${rest}</span>`;
    }
  }
  return san;
}

function formatPvMovesHtml(currentFen, uciMoves, lineIndex) {
  try {
    const c = new Chess(currentFen);
    const pvMoves = [];
    const isFirstBlack = (c.turn() === 'b');

    let html = '';
    for (let i = 0; i < uciMoves.length; i++) {
      const uci = uciMoves[i];
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;

      const turn = c.turn();
      const fullmove = c.moveNumber();

      const result = c.move({ from, to, promotion });
      if (!result) break;

      let prefix = '';
      if (turn === 'w') {
        prefix = `${fullmove}. `;
      } else if (i === 0 && isFirstBlack) {
        prefix = `${fullmove}... `;
      } else if (i > 0 && pvMoves[i - 1]?.turn === 'b') {
        prefix = `${fullmove}... `;
      }

      pvMoves.push({
        san: result.san,
        uci: uci,
        turn: turn,
        fullmove: fullmove
      });

      html += `${prefix}<span class="pv-move-btn" onclick="playEngineLine(${lineIndex}, ${i})">${formatSanWithPieceIcon(result.san, turn === 'w')}</span> `;
    }
    return html.trim();
  } catch (e) {
    console.error("Error formatting PV moves:", e);
    return uciMoves.join(' ');
  }
}

const CLASS_LABELS = {
  brilliant: "Brilliant",
  great: "Great Move",
  best: "Best",
  excellent: "Excellent",
  good: "Good",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder"
};

const CLASS_COLORS = {
  brilliant: "#26c6da",
  great: "#1e88e5",
  best: "#81b64c",
  excellent: "#81b64c",
  good: "#97af8b",
  inaccuracy: "#f7c631",
  mistake: "#e6912c",
  blunder: "#fa412d"
};

function formatMoveEval(m) {
  if (m.score_mate !== undefined && m.score_mate !== null) {
    if (m.score_mate === 1) return '1-0';
    if (m.score_mate === -1) return '0-1';
    if (m.score_mate === 0) {
      return (m.color === 'white' || m.color === 'w') ? '1-0' : '0-1';
    }
    return m.score_mate > 0 ? `M${m.score_mate}` : `-M${Math.abs(m.score_mate)}`;
  }
  return ((m.white_cp || 0) / 100).toFixed(2);
}

function formatBestMoveEval(m) {
  const isBlackTurn = (m.color === 'black');

  if (m.mate_best !== undefined && m.mate_best !== null) {
    let mateVal = 0;
    if (Array.isArray(m.mate_best)) {
      mateVal = m.mate_best.length;
    } else if (typeof m.mate_best === 'number') {
      mateVal = Math.abs(m.mate_best);
    }
    if (mateVal > 0) {
      let displayMate = typeof m.mate_best === 'number' ? m.mate_best : mateVal;
      if (isBlackTurn && typeof m.mate_best === 'number') {
        displayMate = -displayMate;
      }
      return displayMate > 0 ? `M${displayMate}` : `-M${Math.abs(displayMate)}`;
    }
  }

  let cp = (m.cp_best || 0) / 100;
  if (isBlackTurn) {
    cp = -cp;
  }
  return cp.toFixed(2);
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

  const currentFen = _getCurrentFen();
  const activeIndex = state.review.currentIndex;
  const isReviewMode = (state.mode === MODE.REVIEW);

  let comparisonHtml = '';
  if (isReviewMode && activeIndex >= 0 && state.game.moves[activeIndex]) {
    const m = state.game.moves[activeIndex];
    const singleRowClasses = ['theory', 'best', 'great', 'brilliant', 'book', 'excellent'];

    const hasBestMove = m.best_move && m.best_move !== '';
    const playedDifferent = hasBestMove && m.best_move !== m.uci;

    if (m.classification) {
      const showSingleRow = singleRowClasses.includes(m.classification) || !playedDifferent;

      if (showSingleRow) {
        // 1. Played Move Row only
        const playedEval = formatMoveEval(m);
        let playedAdv;
        if (m.score_mate !== undefined && m.score_mate !== null) {
          if (m.score_mate === 0) {
            playedAdv = (m.color === 'white' || m.color === 'w');
          } else {
            playedAdv = m.score_mate > 0;
          }
        } else {
          playedAdv = m.white_cp >= 0;
        }
        const playedScoreBg = playedAdv ? 'background:#fff;color:#111;' : 'background:#222;color:#fff;';

        const label = CLASS_LABELS[m.classification] || m.classification;
        let labelText = `${m.san} is a ${label}`;
        if (m.classification === 'inaccuracy' || m.classification === 'excellent') {
          labelText = `${m.san} is an ${label}`;
        } else if (m.classification === 'best') {
          labelText = `${m.san} is best`;
        }

        let playedPv = state.analysis.latestLines[0]?.pv;
        if (!playedPv && state.game.moves[activeIndex + 1]) {
          playedPv = state.game.moves[activeIndex + 1].pv1_full;
        }
        const playedPvHtml = playedPv ? formatPvMovesHtml(m.fen_after, playedPv, -1) : 'No line available';

        const isPlayedExpanded = !!state.analysis.expandedLines['played'];

        comparisonHtml = `
          <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:8px; padding-bottom:8px; border-bottom: 2px solid rgba(255,255,255,0.1);">
            <!-- Played Move Row -->
            <div style="display:flex; gap:8px; align-items:center; min-width:0; width:100%; padding: 2px 0;">
              <span style="${playedScoreBg}min-width:45px; text-align:center; padding:2px 6px; border-radius:4px; font-weight:700; font-size:11px; flex-shrink:0;">${playedEval}</span>
              <div class="engine-line-moves ${isPlayedExpanded ? 'expanded' : 'collapsed'}" style="flex-grow:1; min-width:0; font-size:11px; color:var(--text-secondary); ${isPlayedExpanded ? 'white-space:normal;' : 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'}">
                <span style="color:${CLASS_COLORS[m.classification] || 'var(--text-primary)'}; font-weight:700; display:inline-flex; align-items:center; gap:3px; margin-right:6px;">
                  <img src="assets/markers/${m.classification}.svg" style="width:12px; height:12px; vertical-align:middle; display:inline-block;" />
                  <span>${labelText}</span>
                </span>
                ${playedPvHtml}
              </div>
              <button class="engine-line-toggle-btn" onclick="toggleEngineLine('played')" style="background:none; border:none; color:var(--text-muted); cursor:pointer; padding: 2px 4px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform: rotate(${isPlayedExpanded ? '180deg' : '0deg'}); transition: transform 0.2s;">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </div>
          </div>
        `;
      } else {
        // 2. Both Played Move and Best Move Rows
        const playedEval = formatMoveEval(m);
        let playedAdv;
        if (m.score_mate !== undefined && m.score_mate !== null) {
          if (m.score_mate === 0) {
            playedAdv = (m.color === 'white' || m.color === 'w');
          } else {
            playedAdv = m.score_mate > 0;
          }
        } else {
          playedAdv = m.white_cp >= 0;
        }
        const playedScoreBg = playedAdv ? 'background:#fff;color:#111;' : 'background:#222;color:#fff;';

        const label = CLASS_LABELS[m.classification] || m.classification;
        let labelText = `${m.san} is a ${label}`;
        if (m.classification === 'inaccuracy' || m.classification === 'excellent') {
          labelText = `${m.san} is an ${label}`;
        }

        let playedPv = state.analysis.latestLines[0]?.pv;
        if (!playedPv && state.game.moves[activeIndex + 1]) {
          playedPv = state.game.moves[activeIndex + 1].pv1_full;
        }
        const playedPvHtml = playedPv ? formatPvMovesHtml(m.fen_after, playedPv, -1) : 'No line available';

        // Best Move Row
        const bestEval = formatBestMoveEval(m);
        const isBlackTurn = (m.color === 'black');
        let cpBestCorrected = (m.cp_best || 0) / 100;
        if (isBlackTurn) {
          cpBestCorrected = -cpBestCorrected;
        }
        let isMateBestWhite = false;
        if (m.mate_best !== undefined && m.mate_best !== null) {
          let displayMate = typeof m.mate_best === 'number' ? m.mate_best : m.mate_best.length;
          if (isBlackTurn && typeof m.mate_best === 'number') {
            displayMate = -displayMate;
          }
          isMateBestWhite = displayMate > 0;
        }
        const bestAdv = (m.mate_best !== undefined && m.mate_best !== null) ? isMateBestWhite : cpBestCorrected >= 0;
        const bestScoreBg = bestAdv ? 'background:#fff;color:#111;' : 'background:#222;color:#fff;';

        const bestSan = _uciPvToSan(m.fen_before, [m.best_move]);
        const bestLabelText = `${bestSan} is best`;

        const bestPv = m.pv1_full;
        const bestPvHtml = bestPv ? formatPvMovesHtml(m.fen_before, bestPv, -2) : 'No line available';

        const isPlayedExpanded = !!state.analysis.expandedLines['played'];
        const isBestExpanded = !!state.analysis.expandedLines['best'];

        comparisonHtml = `
          <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:8px; padding-bottom:8px; border-bottom: 2px solid rgba(255,255,255,0.1);">
            <!-- Played Move Row -->
            <div style="display:flex; gap:8px; align-items:center; min-width:0; width:100%; padding: 2px 0;">
              <span style="${playedScoreBg}min-width:45px; text-align:center; padding:2px 6px; border-radius:4px; font-weight:700; font-size:11px; flex-shrink:0;">${playedEval}</span>
              <div class="engine-line-moves ${isPlayedExpanded ? 'expanded' : 'collapsed'}" style="flex-grow:1; min-width:0; font-size:11px; color:var(--text-secondary); ${isPlayedExpanded ? 'white-space:normal;' : 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'}">
                <span style="color:${CLASS_COLORS[m.classification] || 'var(--text-primary)'}; font-weight:700; display:inline-flex; align-items:center; gap:3px; margin-right:6px;">
                  <img src="assets/markers/${m.classification}.svg" style="width:12px; height:12px; vertical-align:middle; display:inline-block;" />
                  <span>${labelText}</span>
                </span>
                ${playedPvHtml}
              </div>
              <button class="engine-line-toggle-btn" onclick="toggleEngineLine('played')" style="background:none; border:none; color:var(--text-muted); cursor:pointer; padding: 2px 4px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform: rotate(${isPlayedExpanded ? '180deg' : '0deg'}); transition: transform 0.2s;">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </div>
            
            <!-- Best Move Row -->
            <div style="display:flex; gap:8px; align-items:center; min-width:0; width:100%; padding: 2px 0;">
              <span style="${bestScoreBg}min-width:45px; text-align:center; padding:2px 6px; border-radius:4px; font-weight:700; font-size:11px; flex-shrink:0;">${bestEval}</span>
              <div class="engine-line-moves ${isBestExpanded ? 'expanded' : 'collapsed'}" style="flex-grow:1; min-width:0; font-size:11px; color:var(--text-secondary); ${isBestExpanded ? 'white-space:normal;' : 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'}">
                <span style="color:${CLASS_COLORS.best}; font-weight:700; display:inline-flex; align-items:center; gap:3px; margin-right:6px;">
                  <img src="assets/markers/best.svg" style="width:12px; height:12px; vertical-align:middle; display:inline-block;" />
                  <span>${bestLabelText}</span>
                </span>
                ${bestPvHtml}
              </div>
              <button class="engine-line-toggle-btn" onclick="toggleEngineLine('best')" style="background:none; border:none; color:var(--text-muted); cursor:pointer; padding: 2px 4px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform: rotate(${isBestExpanded ? '180deg' : '0deg'}); transition: transform 0.2s;">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </div>
          </div>
        `;
      }
    }
  }

  let html = '';
  lines.forEach((line, idx) => {
    let scoreStr = '';
    if (line.score_mate !== undefined && line.score_mate !== null) {
      if (line.score_mate === 1) scoreStr = '1-0';
      else if (line.score_mate === -1) scoreStr = '0-1';
      else if (line.score_mate === 0) {
        const c = new Chess(currentFen);
        if (c.isGameOver() && !c.isCheckmate()) {
          scoreStr = '1/2-1/2';
        } else {
          scoreStr = c.turn() === 'w' ? '0-1' : '1-0';
        }
      } else {
        scoreStr = line.score_mate > 0 ? `M${line.score_mate}` : `-M${Math.abs(line.score_mate)}`;
      }
    } else {
      const cp = (line.white_cp / 100).toFixed(2);
      scoreStr = cp;
    }

    let whiteAdv;
    if (line.score_mate !== undefined && line.score_mate !== null) {
      if (line.score_mate === 0) {
        const c = new Chess(currentFen);
        whiteAdv = (c.turn() === 'b');
      } else {
        whiteAdv = line.score_mate > 0;
      }
    } else {
      whiteAdv = line.white_cp >= 0;
    }
    const scoreBg = whiteAdv ? 'background:#fff;color:#111;' : 'background:#222;color:#fff;';

    const isExpanded = !!state.analysis.expandedLines[idx];
    const pvMovesHtml = formatPvMovesHtml(currentFen, line.pv || [], idx);

    html += `
      <div style="display:flex; gap:8px; align-items:flex-start; min-width:0; width:100%; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
        <span style="${scoreBg}min-width:45px; text-align:center; padding:2px 6px; border-radius:4px; font-weight:700; font-size:11px; flex-shrink:0; margin-top:2px;">${scoreStr}</span>
        <div class="engine-line-moves ${isExpanded ? 'expanded' : 'collapsed'}" style="flex-grow:1; min-width:0; font-size:11px; line-height:1.6; color:var(--text-secondary);">
          ${pvMovesHtml}
        </div>
        <button class="engine-line-toggle-btn" onclick="toggleEngineLine(${idx})" style="background:none; border:none; color:var(--text-muted); cursor:pointer; padding: 2px 4px; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:2px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform: rotate(${isExpanded ? '180deg' : '0deg'}); transition: transform 0.2s;">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
    `;
  });

  el.engineLinesContainer.innerHTML = comparisonHtml + html;
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

// ── Chess.com Game Loading ──────────────────────────────────

async function fetchChesscomGames(archiveUrl = null) {
  const username = el.chesscomUsername?.value?.trim();
  if (!username) {
    showToast('Please enter a Chess.com username.', 'error');
    return;
  }

  // Show spinner, disable buttons
  if (el.chesscomFetchBtn) el.chesscomFetchBtn.disabled = true;
  if (el.chesscomSpinner) el.chesscomSpinner.classList.remove('hidden');

  try {
    let url = `${API_BASE}/api/chesscom/games?username=${encodeURIComponent(username)}`;
    if (archiveUrl) {
      url += `&archive=${encodeURIComponent(archiveUrl)}`;
    }
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      throw new Error(err.detail || 'Failed to fetch games.');
    }
    const data = await res.json();
    if (data.status !== 'ok' || !data.games) {
      throw new Error('Invalid response format.');
    }
    state.chesscomGames = data.games;
    renderChesscomGames(data.games, username);

    // Populate archives dropdown if available
    if (data.archives && data.archives.length > 0) {
      if (el.chesscomArchiveSelect) {
        // Build option HTML
        let optionsHtml = '';
        data.archives.forEach(arc => {
          const selectedAttr = arc.url === data.selected_archive ? 'selected' : '';
          optionsHtml += `<option value="${arc.url}" ${selectedAttr}>${arc.label}</option>`;
        });
        el.chesscomArchiveSelect.innerHTML = optionsHtml;
      }
      if (el.chesscomArchiveContainer) {
        el.chesscomArchiveContainer.classList.remove('hidden');
      }
    } else {
      if (el.chesscomArchiveContainer) {
        el.chesscomArchiveContainer.classList.add('hidden');
      }
    }

    if (data.games.length === 0) {
      showToast('No games found for this user in the selected month.', 'info');
    } else {
      showToast(`Loaded ${data.games.length} games.`, 'success');
    }
  } catch (e) {
    showToast(`Failed to fetch Chess.com games: ${e.message}`, 'error', 6000);
    console.error(e);
  } finally {
    if (el.chesscomFetchBtn) el.chesscomFetchBtn.disabled = false;
    if (el.chesscomSpinner) el.chesscomSpinner.classList.add('hidden');
  }
}

function renderChesscomGames(games, username) {
  if (!el.chesscomGamesList) return;

  if (games.length === 0) {
    el.chesscomGamesList.innerHTML = '<div class="text-[11px] text-[var(--text-muted)] italic text-center py-2">No games found.</div>';
    el.chesscomGamesList.classList.remove('hidden');
    return;
  }

  const getGameOutcome = (game, user) => {
    const isWhite = game.white.username.toLowerCase() === user.toLowerCase();
    const player = isWhite ? game.white : game.black;
    const opponent = isWhite ? game.black : game.white;
    const drawResults = ['draw', 'stalemate', 'repetition', 'insufficient', 'agreed', '50moves', 'time-vs-insufficient'];
    if (player.result === 'win') return 'W';
    if (drawResults.includes(player.result) || drawResults.includes(opponent.result)) return 'D';
    return 'L';
  };

  const outcomeClasses = {
    'W': 'bg-[var(--accent-green)] text-white',
    'L': 'bg-[var(--accent-red)] text-white',
    'D': 'bg-[#6b6966] text-white'
  };

  let html = '';
  games.forEach((game, index) => {
    const isWhite = game.white.username.toLowerCase() === username.toLowerCase();
    const userColor = isWhite ? 'White' : 'Black';
    const opponent = isWhite ? game.black : game.white;
    const outcome = getGameOutcome(game, username);
    const outcomeClass = outcomeClasses[outcome] || 'bg-neutral-600 text-white';

    const dateObj = new Date(game.end_time * 1000);
    const formattedDate = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const ratedText = game.rated ? '<span class="text-[var(--text-muted)]">•</span><span class="text-[var(--accent-theory)] font-semibold">Rated</span>' : '';
    const timeControlText = game.time_class || 'Blitz';

    html += `
      <div class="chesscom-game-card p-2.5 rounded bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--bg-card-hover)] hover:border-[var(--border-light)] transition-all cursor-pointer flex items-center justify-between gap-3 text-xs" data-index="${index}">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="w-6 h-6 flex items-center justify-center font-bold rounded text-[11px] shrink-0 ${outcomeClass}">
            ${outcome}
          </span>
          <div class="flex flex-col min-w-0">
            <div class="font-medium text-[var(--text-primary)] truncate">
              vs <span class="font-bold text-[var(--accent-green-hover)]">${opponent.username}</span> <span class="text-[var(--text-muted)]">(${opponent.rating})</span>
            </div>
            <div class="text-[10px] text-[var(--text-secondary)] flex items-center gap-1.5 mt-0.5">
              <span class="capitalize">${timeControlText}</span>
              <span class="text-[var(--text-muted)]">•</span>
              <span>as ${userColor}</span>
              ${ratedText}
            </div>
          </div>
        </div>
        <div class="text-[10px] text-[var(--text-muted)] font-mono shrink-0">
          ${formattedDate}
        </div>
      </div>
    `;
  });

  el.chesscomGamesList.innerHTML = html;
  el.chesscomGamesList.classList.remove('hidden');
}

function selectChesscomGame(index) {
  const game = state.chesscomGames[index];
  if (!game) return;
  if (el.pgnInput) {
    el.pgnInput.value = game.pgn;
    if (el.analyzeBtn) el.analyzeBtn.disabled = false;
    showToast('Chess.com game PGN loaded into input!', 'success');
  }
}

// ── Boot ────────────────────────────────────────────────────

init().catch(console.error);
