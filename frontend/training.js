/**
 * training.js — Training Hub Module for ChessReviewer
 *
 * Implements:
 *   1. Tactics Training (Curated Offline + Lichess Daily)
 *   2. Opening Trainer (8 variations, White/Black side play)
 *   3. Play vs Engine (ELO levels 800 - 2400, custom backend moves)
 *   4. Coordinate Trainer (30-second square click game)
 */

import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';

// ── Openings Data ────────────────────────────────────────────────────────
const OPENINGS = [
  {
    id: 'ruy_lopez',
    name: 'Ruy Lopez (Spanish Opening)',
    desc: 'One of the oldest and most classical openings. Targets the e5 pawn and fights for the center.',
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'],
    sans: ['1. e4 e5', '2. Nf3 Nc6', '3. Bb5'],
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  },
  {
    id: 'sicilian_najdorf',
    name: 'Sicilian Defense (Najdorf)',
    desc: 'The Najdorf is a sharp, double-edged variation of the Sicilian. Extremely popular among world champions.',
    moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'],
    sans: ['1. e4 c5', '2. Nf3 d6', '3. d4 cxd4', '4. Nxd4 Nf6', '5. Nc3 a6'],
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  },
  {
    id: 'queens_gambit',
    name: "Queen's Gambit Accepted",
    desc: 'White sacrifices a wing pawn temporarily to gain central control. Black accepts the gambit.',
    moves: ['d2d4', 'd5', 'c2c4', 'd5c4'],
    sans: ["1. d4 d5", "2. c4 dxc4"],
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  },
  {
    id: 'caro_kann',
    name: 'Caro-Kann Defense',
    desc: 'A solid and resilient defensive system for Black, aiming for a favorable pawn structure.',
    moves: ['e2e4', 'c7c6', 'd2d4', 'd5'],
    sans: ['1. e4 c6', '2. d4 d5'],
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  },
  {
    id: 'french_defense',
    name: 'French Defense',
    desc: 'A counter-attacking opening for Black, creating a strong pawn chain but temporarily blocking the c8 bishop.',
    moves: ['e2e4', 'e7e6', 'd2d4', 'd5'],
    sans: ['1. e4 e6', '2. d4 d5'],
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  },
  {
    id: 'italian_game',
    name: 'Italian Game (Giuoco Piano)',
    desc: 'Focuses on rapid development, control of the center, and attacking Black\'s vulnerable f7 square.',
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'],
    sans: ['1. e4 e5', '2. Nf3 Nc6', '3. Bc4 Bc5'],
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  },
  {
    id: 'kings_indian',
    name: "King's Indian Defense",
    desc: 'A hypermodern opening where Black allows White to build a large pawn center, planning to strike back later.',
    moves: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'f8g7'],
    sans: ["1. d4 Nf6", "2. c4 g6", "3. Nc3 Bg7"],
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  },
  {
    id: 'scandinavian',
    name: 'Scandinavian Defense',
    desc: 'Black immediately challenges White\'s center pawn, leading to an open game and rapid queen activity.',
    moves: ['e2e4', 'd7d5', 'e4d5', 'd8d5'],
    sans: ['1. e4 d5', '2. exd5 Qxd5'],
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  }
];

export const TrainingModule = {
  // Shared state
  board: null,
  setMode: null,
  triggerEvalBarRender: null,
  activeSubmode: 'hub', // hub, puzzles, openings, engine, coordinates

  // Submode States
  puzzles: {
    curated: [],
    active: null,        // current puzzle object
    chess: null,         // chess.js instance
    currentIndex: 0,     // current step index in solution
    activeStatus: 'idle', // idle, playing, solved, failed
  },

  openings: {
    active: null,
    chess: null,
    playerColor: 'white',
    currentIndex: 0,
    activeStatus: 'idle', // idle, playing, completed
    list: [],
    ws: null,
    currentExplorerMoves: [],
  },

  engine: {
    chess: null,
    elo: 1400,
    playerColor: 'white',
    activeStatus: 'idle', // idle, playing, over
    moves: [],           // [{moveNum, whiteMove, blackMove}]
  },

  coordinates: {
    target: '',
    score: 0,
    attempts: 0,
    timeLeft: 30,
    timerId: null,
    orientation: 'white',
    activeStatus: 'idle', // idle, playing, ended
  },

  init(boardManager, setModeFn, triggerEvalBarRenderFn, onReviewGameFn) {
    this.board = boardManager;
    this.setMode = setModeFn;
    this.triggerEvalBarRender = triggerEvalBarRenderFn;
    this.onReviewGame = onReviewGameFn;

    this._bindDOM();
    this._loadCuratedPuzzles();
    this._populateOpeningsDropdown();
    this._setupCoordinateClickListener();
  },

  // ── Mode Management ─────────────────────────────────────────────────────
  switchMode(submode) {
    this.activeSubmode = submode;
    this._teardownActiveMode();

    // Show/hide subpanels
    const panels = ['menu', 'puzzles', 'openings', 'engine', 'coordinates'];
    panels.forEach(p => {
      const targetId = p === 'menu' ? 'training-menu' : `training-panel-${p}`;
      const el = document.getElementById(targetId);
      const shouldShow = (p === 'menu' && submode === 'hub') || (p === submode);
      if (el) el.classList.toggle('hidden', !shouldShow);
    });

    const backBtn = document.getElementById('btn-training-back');
    const headerTitle = document.getElementById('training-header-title');

    if (submode === 'hub') {
      if (backBtn) {
        backBtn.classList.add('hidden');
        backBtn.textContent = '✕ Exit Mode';
      }
      if (headerTitle) headerTitle.textContent = 'Training Hub';
      // Reset board to starting position
      this.board.setPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      this.board.clearMarrows();
      this.board.disableInteraction();
    } else {
      if (backBtn) {
        backBtn.classList.remove('hidden');
        backBtn.textContent = '✕ Back';
      }
      
      const titles = {
        puzzles: 'Tactics Trainer',
        openings: 'Opening Rehearsal',
        engine: 'Play vs Stockfish',
        coordinates: 'Coordinate Challenge'
      };
      if (headerTitle) headerTitle.textContent = titles[submode] || 'Training';
      
      // Initialize submode board state
      this._initSubmodeBoard(submode);
    }
  },

  _initSubmodeBoard(submode) {
    this.board.clearMarrows();
    
    if (submode === 'puzzles') {
      this._resetPuzzlesUI();
      // Load first curated puzzle in dropdown as default preview
      const select = document.getElementById('select-curated-puzzles');
      if (select && select.value) {
        this._loadPuzzleById(select.value);
      }
    } else if (submode === 'openings') {
      this._resetOpeningsUI();
      const select = document.getElementById('select-opening');
      if (select && select.value) {
        this._loadOpeningById(select.value);
      }
    } else if (submode === 'engine') {
      this._resetEngineUI();
      this.board.setPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    } else if (submode === 'coordinates') {
      this._resetCoordinatesUI();
      this.board.setPosition('8/8/8/8/8/8/8/8 w - - 0 1'); // Empty board
      this.board.disableInteraction();
    }
  },

  _teardownActiveMode() {
    // Clear Coordinate Timer
    if (this.coordinates.timerId) {
      clearInterval(this.coordinates.timerId);
      this.coordinates.timerId = null;
    }
    // Restore coordinates flash classes
    const boardEl = document.getElementById('board');
    if (boardEl) {
      boardEl.classList.remove('correct-board-flash', 'incorrect-board-flash');
    }
    // Enable interaction correctly
    this.board.disableInteraction();
    
    // Stop opening engine WS if active
    this._stopOpeningEngine();
  },

  // ── Move Routing Hooks ──────────────────────────────────────────────────
  handleMove(from, to, promotion) {
    if (this.activeSubmode === 'puzzles') {
      this._handlePuzzlePlayerMove(from, to, promotion);
    } else if (this.activeSubmode === 'openings') {
      this._handleOpeningPlayerMove(from, to, promotion);
    } else if (this.activeSubmode === 'engine') {
      this._handleEnginePlayerMove(from, to, promotion);
    }
  },

  getFenForLegalMoves() {
    if (this.activeSubmode === 'puzzles' && this.puzzles.chess) {
      return this.puzzles.chess.fen();
    }
    if (this.activeSubmode === 'openings' && this.openings.chess) {
      return this.openings.chess.fen();
    }
    if (this.activeSubmode === 'engine' && this.engine.chess) {
      return this.engine.chess.fen();
    }
    return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  },

  // ── DOM Binding ─────────────────────────────────────────────────────────
  _bindDOM() {
    // Hub Menu Buttons
    document.getElementById('menu-btn-puzzles')?.addEventListener('click', () => this.switchMode('puzzles'));
    document.getElementById('menu-btn-openings')?.addEventListener('click', () => this.switchMode('openings'));
    document.getElementById('menu-btn-engine')?.addEventListener('click', () => this.switchMode('engine'));
    document.getElementById('menu-btn-coordinates')?.addEventListener('click', () => this.switchMode('coordinates'));
    
    // Back Button
    document.getElementById('btn-training-back')?.addEventListener('click', () => {
      if (this.activeSubmode !== 'hub') {
        this.switchMode('hub');
      }
    });

    // Puzzles UI
    document.getElementById('btn-puzzle-daily')?.addEventListener('click', () => this._fetchLichessDailyPuzzle());
    document.getElementById('btn-puzzle-curated')?.addEventListener('click', () => this._showCuratedPuzzlesList());
    document.getElementById('select-curated-puzzles')?.addEventListener('change', (e) => this._loadPuzzleById(e.target.value));
    
    const puzzleActionBtn = document.getElementById('btn-puzzle-action');
    puzzleActionBtn?.addEventListener('click', () => {
      if (this.puzzles.activeStatus === 'idle') {
        this._startPuzzleGame();
      } else {
        this._resetActivePuzzle();
      }
    });

    document.getElementById('btn-puzzle-hint')?.addEventListener('click', () => this._showPuzzleHint());
    document.getElementById('btn-puzzle-reveal')?.addEventListener('click', () => this._revealPuzzleSolution());

    // Openings UI
    document.getElementById('select-opening')?.addEventListener('change', (e) => this._loadOpeningById(e.target.value));
    
    const sideWhiteBtn = document.getElementById('btn-opening-side-white');
    const sideBlackBtn = document.getElementById('btn-opening-side-black');
    sideWhiteBtn?.addEventListener('click', () => {
      this.openings.playerColor = 'white';
      sideWhiteBtn.className = 'btn-primary flex-1 py-1.5 text-xs';
      if (sideBlackBtn) sideBlackBtn.className = 'btn-secondary flex-1 py-1.5 text-xs';
      this._resetOpeningsUI();
    });
    sideBlackBtn?.addEventListener('click', () => {
      this.openings.playerColor = 'black';
      sideBlackBtn.className = 'btn-primary flex-1 py-1.5 text-xs';
      if (sideWhiteBtn) sideWhiteBtn.className = 'btn-secondary flex-1 py-1.5 text-xs';
      this._resetOpeningsUI();
    });

    const openingStartBtn = document.getElementById('btn-opening-start');
    openingStartBtn?.addEventListener('click', () => {
      if (this.openings.activeStatus === 'idle') {
        this._startOpeningTraining();
      } else {
        this._resetOpeningTraining();
      }
    });

    document.getElementById('toggle-opening-engine')?.addEventListener('change', () => {
      this._manageOpeningEngine();
    });

    // Play vs Engine UI
    const slider = document.getElementById('engine-elo-slider');
    const display = document.getElementById('engine-elo-display');
    const strengthLabel = document.getElementById('engine-strength-label');
    slider?.addEventListener('input', (e) => {
      const elo = parseInt(e.target.value, 10);
      this.engine.elo = elo;
      if (display) display.textContent = `${elo} ELO`;
      
      const labels = {
        800: '800 - Beginner',
        1000: '1000 - Casual Player',
        1200: '1200 - Club Player',
        1400: '1400 - Intermediate',
        1600: '1600 - Advanced',
        1800: '1800 - Strong Club Player',
        2000: '2000 - Expert / Candidate Master',
        2200: '2200 - Master',
        2400: '2400 - International Master',
        2600: '2600 - Grandmaster',
        2800: '2800 - Super Grandmaster',
        3000: '3000 - World Champion',
        3200: '3200 - Stockfish Max Strength (No Limit)'
      };
      if (strengthLabel) strengthLabel.textContent = labels[elo] || `${elo} ELO`;
    });

    const engineWhite = document.getElementById('btn-engine-side-white');
    const engineBlack = document.getElementById('btn-engine-side-black');
    const engineRandom = document.getElementById('btn-engine-side-random');
    
    engineWhite?.addEventListener('click', () => {
      this.engine.playerColor = 'white';
      engineWhite.className = 'btn-primary flex-1 py-1.5 text-xs';
      if (engineBlack) engineBlack.className = 'btn-secondary flex-1 py-1.5 text-xs';
      if (engineRandom) engineRandom.className = 'btn-secondary flex-1 py-1.5 text-xs';
    });
    engineBlack?.addEventListener('click', () => {
      this.engine.playerColor = 'black';
      engineBlack.className = 'btn-primary flex-1 py-1.5 text-xs';
      if (engineWhite) engineWhite.className = 'btn-secondary flex-1 py-1.5 text-xs';
      if (engineRandom) engineRandom.className = 'btn-secondary flex-1 py-1.5 text-xs';
    });
    engineRandom?.addEventListener('click', () => {
      this.engine.playerColor = 'random';
      engineRandom.className = 'btn-primary flex-1 py-1.5 text-xs';
      if (engineWhite) engineWhite.className = 'btn-secondary flex-1 py-1.5 text-xs';
      if (engineBlack) engineBlack.className = 'btn-secondary flex-1 py-1.5 text-xs';
    });

    document.getElementById('btn-engine-start')?.addEventListener('click', () => this._startEngineGame());
    document.getElementById('btn-engine-resign')?.addEventListener('click', () => this._resignEngineGame());
    document.getElementById('btn-engine-review')?.addEventListener('click', () => this._reviewEngineGame());

    // Coordinate Trainer UI
    const coordWhite = document.getElementById('btn-coords-side-white');
    const coordBlack = document.getElementById('btn-coords-side-black');
    coordWhite?.addEventListener('click', () => {
      this.coordinates.orientation = 'white';
      coordWhite.className = 'btn-primary flex-1 py-1.5 text-xs';
      if (coordBlack) coordBlack.className = 'btn-secondary flex-1 py-1.5 text-xs';
    });
    coordBlack?.addEventListener('click', () => {
      this.coordinates.orientation = 'black';
      coordBlack.className = 'btn-primary flex-1 py-1.5 text-xs';
      if (coordWhite) coordWhite.className = 'btn-secondary flex-1 py-1.5 text-xs';
    });

    document.getElementById('btn-coords-start')?.addEventListener('click', () => this._startCoordinateChallenge());
    document.getElementById('btn-coords-retry')?.addEventListener('click', () => {
      document.getElementById('coordinates-results-screen').classList.add('hidden');
      document.getElementById('coordinates-start-screen').classList.remove('hidden');
      this._resetCoordinatesUI();
    });
  },

  // ── Tactics Module (Puzzles) ────────────────────────────────────────────
  _loadCuratedPuzzles() {
    fetch(`${window.API_BASE || ''}/api/training/curated-puzzles`)
      .then(res => res.json())
      .then(data => {
        this.puzzles.curated = data;
        this._populatePuzzlesDropdown(data);
      })
      .catch(err => {
        console.error("Failed to load curated puzzles:", err);
      });
  },

  _populatePuzzlesDropdown(puzzles) {
    const select = document.getElementById('select-curated-puzzles');
    if (!select) return;
    select.innerHTML = '';
    puzzles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.title} (${p.rating} ELO)`;
      select.appendChild(opt);
    });
  },

  _showCuratedPuzzlesList() {
    document.getElementById('btn-puzzle-curated').className = 'btn-primary flex-1 py-2 text-xs';
    document.getElementById('btn-puzzle-daily').className = 'btn-secondary flex-1 py-2 text-xs';
    document.getElementById('puzzle-select-container').classList.remove('hidden');
    
    const select = document.getElementById('select-curated-puzzles');
    if (select && select.value) {
      this._loadPuzzleById(select.value);
    }
  },

  _loadPuzzleById(id) {
    const puzzle = this.puzzles.curated.find(p => p.id === id);
    if (puzzle) {
      this._displayPuzzleDetails(puzzle);
    }
  },

  _displayPuzzleDetails(puzzle) {
    this.puzzles.active = puzzle;
    this.puzzles.activeStatus = 'idle';

    document.getElementById('puzzle-active-info').classList.remove('hidden');
    document.getElementById('puzzle-title').textContent = puzzle.title;
    document.getElementById('puzzle-theme').textContent = puzzle.theme || 'Tactics';
    document.getElementById('puzzle-rating').textContent = `${puzzle.rating} ELO`;
    document.getElementById('puzzle-desc').textContent = puzzle.description;
    
    const feedback = document.getElementById('puzzle-feedback');
    feedback.textContent = `Play as ${puzzle.player_color.toUpperCase()}. Click Start to begin.`;
    feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)]';

    document.getElementById('btn-puzzle-action').textContent = 'Start Puzzle';
    document.getElementById('btn-puzzle-hint').disabled = true;
    document.getElementById('btn-puzzle-reveal').disabled = true;

    // Show initial position
    this.board.setPosition(puzzle.initialFen);
    this.board.setOrientation(puzzle.player_color);
    this.board.clearMarrows();
    this.board.disableInteraction();
  },

  _fetchLichessDailyPuzzle() {
    document.getElementById('btn-puzzle-daily').className = 'btn-primary flex-1 py-2 text-xs';
    document.getElementById('btn-puzzle-curated').className = 'btn-secondary flex-1 py-2 text-xs';
    document.getElementById('puzzle-select-container').classList.add('hidden');

    const feedback = document.getElementById('puzzle-feedback');
    feedback.textContent = 'Fetching daily puzzle...';
    feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-[var(--bg-primary)] border border-[var(--border)] text-yellow-500 animate-pulse';

    fetch(`${window.API_BASE || ''}/api/training/daily-puzzle`)
      .then(res => res.json())
      .then(puzzle => {
        this._displayPuzzleDetails(puzzle);
      })
      .catch(err => {
        console.error("Failed to load Lichess daily puzzle:", err);
        feedback.textContent = 'Failed to fetch puzzle. Loaded curated fallback.';
        feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-red-950/20 border border-red-500/30 text-red-400';
        this._showCuratedPuzzlesList();
      });
  },

  _startPuzzleGame() {
    const puzzle = this.puzzles.active;
    if (!puzzle) return;

    this.puzzles.chess = new Chess(puzzle.initialFen);
    this.puzzles.currentIndex = 0;
    this.puzzles.activeStatus = 'playing';

    document.getElementById('btn-puzzle-action').textContent = 'Restart';
    document.getElementById('btn-puzzle-hint').disabled = false;
    document.getElementById('btn-puzzle-reveal').disabled = false;

    const feedback = document.getElementById('puzzle-feedback');
    feedback.textContent = 'Opponent is making a move...';
    feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-[var(--bg-primary)] border border-[var(--border)] text-yellow-500';

    // Play the opponent's first blunder move in the solution
    setTimeout(() => {
      const blunder = puzzle.solution[0];
      const from = blunder.slice(0, 2);
      const to = blunder.slice(2, 4);
      
      this.puzzles.chess.move({ from, to, promotion: 'q' });
      this.board.setPosition(this.puzzles.chess.fen(), true);
      this.board.addLastMoveMarkers(from, to, null, null, puzzle.player_color === 'white' ? 'black' : 'white');

      this.puzzles.currentIndex = 1; // Now player needs to play solution[1]

      feedback.textContent = 'Your Turn! Find the best response.';
      feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-green-950/20 border border-green-500/30 text-green-400';

      this.board.enableInteraction(
        (fromSq, toSq) => this._validatePuzzleDrag(fromSq, toSq),
        (square) => this._getPuzzleLegalMoves(square)
      );
    }, 800);
  },

  _resetActivePuzzle() {
    this._teardownActiveMode();
    if (this.puzzles.active) {
      this._displayPuzzleDetails(this.puzzles.active);
    }
  },

  _resetPuzzlesUI() {
    this.puzzles.active = null;
    this.puzzles.chess = null;
    this.puzzles.currentIndex = 0;
    this.puzzles.activeStatus = 'idle';
    document.getElementById('puzzle-active-info').classList.add('hidden');
    document.getElementById('puzzle-select-container').classList.add('hidden');
    document.getElementById('btn-puzzle-daily').className = 'btn-secondary flex-1 py-2 text-xs';
    document.getElementById('btn-puzzle-curated').className = 'btn-secondary flex-1 py-2 text-xs';
  },

  _validatePuzzleDrag(from, to) {
    if (this.puzzles.activeStatus !== 'playing') return false;
    
    // Check if legal move in chess.js first
    const clone = new Chess(this.puzzles.chess.fen());
    try {
      clone.move({ from, to, promotion: 'q' });
    } catch (e) {
      return false; // Illegal move
    }
    return true;
  },

  _getPuzzleLegalMoves(square) {
    if (!this.puzzles.chess) return [];
    return this.puzzles.chess.moves({ square, verbose: true }).map(m => m.to);
  },

  _handlePuzzlePlayerMove(from, to, promotion) {
    const puzzle = this.puzzles.active;
    const expectedMove = puzzle.solution[this.puzzles.currentIndex];

    // Lichess UCI move check (from + to)
    const playedMove = from + to;
    const isCorrect = (playedMove === expectedMove || (playedMove + 'q') === expectedMove);

    const feedback = document.getElementById('puzzle-feedback');

    if (isCorrect) {
      // Correct player move
      this.puzzles.chess.move({ from, to, promotion: promotion || 'q' });
      this.board.setPosition(this.puzzles.chess.fen(), true);
      this.board.addLastMoveMarkers(from, to, 'best', null, puzzle.player_color);

      this.puzzles.currentIndex++;

      if (this.puzzles.currentIndex >= puzzle.solution.length) {
        // Solved!
        this.puzzles.activeStatus = 'solved';
        feedback.textContent = '🎉 Correct! Puzzle Solved successfully!';
        feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-emerald-900/30 border border-emerald-500/40 text-emerald-400 font-bold';
        this.board.disableInteraction();
        document.getElementById('btn-puzzle-hint').disabled = true;
        document.getElementById('btn-puzzle-reveal').disabled = true;
      } else {
        // Play opponent's response
        feedback.textContent = 'Correct! Opponent is replying...';
        feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-[var(--bg-primary)] border border-[var(--border)] text-yellow-500';
        this.board.disableInteraction();

        setTimeout(() => {
          const opponentMove = puzzle.solution[this.puzzles.currentIndex];
          const oppFrom = opponentMove.slice(0, 2);
          const oppTo = opponentMove.slice(2, 4);

          this.puzzles.chess.move({ from: oppFrom, to: oppTo, promotion: 'q' });
          this.board.setPosition(this.puzzles.chess.fen(), true);
          this.board.addLastMoveMarkers(oppFrom, oppTo, null, null, puzzle.player_color === 'white' ? 'black' : 'white');

          this.puzzles.currentIndex++;

          feedback.textContent = 'Your Turn! Find the next move.';
          feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-green-950/20 border border-green-500/30 text-green-400';
          
          this.board.enableInteraction(
            (f, t) => this._validatePuzzleDrag(f, t),
            (sq) => this._getPuzzleLegalMoves(sq)
          );
        }, 800);
      }
    } else {
      // Incorrect move - revert board position immediately
      feedback.textContent = '❌ Incorrect move! Reverting piece... Try again!';
      feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-red-950/30 border border-red-500/40 text-red-400';
      
      this.board.disableInteraction();
      setTimeout(() => {
        this.board.setPosition(this.puzzles.chess.fen(), false);
        this.board.clearMarrows();
        
        feedback.textContent = 'Your Turn! Find the best response.';
        feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-green-950/20 border border-green-500/30 text-green-400';
        
        this.board.enableInteraction(
          (f, t) => this._validatePuzzleDrag(f, t),
          (sq) => this._getPuzzleLegalMoves(sq)
        );
      }, 1000);
    }
  },

  _showPuzzleHint() {
    if (this.puzzles.activeStatus !== 'playing') return;
    const puzzle = this.puzzles.active;
    const expectedMove = puzzle.solution[this.puzzles.currentIndex];
    
    // Draw hint arrow or highlight piece
    const from = expectedMove.slice(0, 2);
    const to = expectedMove.slice(2, 4);

    this.board.drawEngineArrows([{ from_sq: from, to_sq: to, multipv: 1 }]);
    
    const feedback = document.getElementById('puzzle-feedback');
    feedback.textContent = `💡 Hint: Try moving the piece starting on ${from.toUpperCase()}!`;
    feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-yellow-950/20 border border-yellow-500/30 text-yellow-400';
  },

  _revealPuzzleSolution() {
    if (this.puzzles.activeStatus !== 'playing') return;
    const puzzle = this.puzzles.active;
    
    this.board.clearMarrows();
    
    // Show correct next move
    const nextMove = puzzle.solution[this.puzzles.currentIndex];
    const from = nextMove.slice(0, 2);
    const to = nextMove.slice(2, 4);
    
    this.board.drawEngineArrows([{ from_sq: from, to_sq: to, multipv: 1 }]);
    
    const feedback = document.getElementById('puzzle-feedback');
    feedback.textContent = `💡 Solution move: ${from.toUpperCase()} to ${to.toUpperCase()}. Click Restart to try again.`;
    feedback.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-yellow-950/20 border border-yellow-500/30 text-yellow-400 font-bold';
    
    this.board.disableInteraction();
    this.puzzles.activeStatus = 'failed';
  },

  // ── Openings Module ─────────────────────────────────────────────────────
  _populateOpeningsDropdown() {
    this.openings.list = OPENINGS; // default fallback
    fetch(`${window.API_BASE || ''}/api/openings/list`)
      .then(res => res.json())
      .then(data => {
        this.openings.list = data;
        const select = document.getElementById('select-opening');
        if (!select) return;
        select.innerHTML = '';
        data.forEach(op => {
          const opt = document.createElement('option');
          opt.value = op.id;
          opt.textContent = op.name;
          select.appendChild(opt);
        });
        if (select.value) {
          this._loadOpeningById(select.value);
        }
      })
      .catch(err => {
        console.error("Failed to load practice openings from backend, using hardcoded fallback:", err);
        const select = document.getElementById('select-opening');
        if (!select) return;
        select.innerHTML = '';
        OPENINGS.forEach(op => {
          const opt = document.createElement('option');
          opt.value = op.id;
          opt.textContent = op.name;
          select.appendChild(opt);
        });
      });
  },

  _loadOpeningById(id) {
    const op = (this.openings.list || OPENINGS).find(o => o.id === id);
    if (op) {
      this.openings.active = op;
      this.openings.activeStatus = 'idle';

      document.getElementById('opening-title').textContent = op.name;
      document.getElementById('opening-desc').textContent = op.desc;
      
      const feedback = document.getElementById('opening-feedback');
      feedback.textContent = `Practice as ${this.openings.playerColor.toUpperCase()}. Click Start.`;
      feedback.className = 'text-center py-1.5 px-3 rounded text-xs font-semibold bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)]';

      document.getElementById('opening-moves-container').classList.add('hidden');
      document.getElementById('opening-explorer-container').classList.add('hidden');
      document.getElementById('btn-opening-start').textContent = 'Start Training';
      
      this.board.setPosition(op.startFen);
      this.board.setOrientation(this.openings.playerColor);
      this.board.clearMarrows();
      this.board.disableInteraction();
      this._stopOpeningEngine();
    }
  },

  _startOpeningTraining() {
    const op = this.openings.active;
    if (!op) return;

    this.openings.chess = new Chess(op.startFen);
    this.openings.currentIndex = 0;
    this.openings.activeStatus = 'playing';

    document.getElementById('btn-opening-start').textContent = 'Restart';
    document.getElementById('opening-moves-container').classList.remove('hidden');

    const list = document.getElementById('opening-moves-list');
    list.innerHTML = '';
    op.sans.forEach((s, i) => {
      const d = document.createElement('div');
      d.id = `op-move-item-${i}`;
      d.className = 'py-0.5 border-b border-[var(--border)] opacity-30';
      d.textContent = s;
      list.appendChild(d);
    });

    const feedback = document.getElementById('opening-feedback');

    if (this.openings.playerColor === 'black') {
      // Opponent makes first move automatically
      feedback.textContent = 'Opponent is playing...';
      feedback.className = 'text-center py-1.5 px-3 rounded text-xs font-semibold bg-[var(--bg-primary)] border border-[var(--border)] text-yellow-500';
      
      setTimeout(() => {
        const whiteMove = op.moves[0];
        const from = whiteMove.slice(0, 2);
        const to = whiteMove.slice(2, 4);
        
        this.openings.chess.move({ from, to, promotion: 'q' });
        this.board.setPosition(this.openings.chess.fen(), true);
        this.board.addLastMoveMarkers(from, to, null, null, 'white');
        
        this.openings.currentIndex = 1;
        
        // Highlight move in list
        const mEl = document.getElementById('op-move-item-0');
        if (mEl) mEl.classList.remove('opacity-30');

        feedback.textContent = 'Your Turn! Play your opening move.';
        feedback.className = 'text-center py-1.5 px-3 rounded text-xs font-semibold bg-green-950/20 border border-green-500/30 text-green-400';
        
        this._updateOpeningExplorer();
        
        this.board.enableInteraction(
          (f, t) => this._validateOpeningDrag(f, t),
          (sq) => this._getOpeningLegalMoves(sq)
        );
      }, 800);
    } else {
      feedback.textContent = 'Your Turn! Play the first move.';
      feedback.className = 'text-center py-1.5 px-3 rounded text-xs font-semibold bg-green-950/20 border border-green-500/30 text-green-400';
      
      this._updateOpeningExplorer();
      
      this.board.enableInteraction(
          (f, t) => this._validateOpeningDrag(f, t),
          (sq) => this._getOpeningLegalMoves(sq)
      );
    }
  },

  _resetOpeningTraining() {
    this._teardownActiveMode();
    if (this.openings.active) {
      this._loadOpeningById(this.openings.active.id);
    }
  },

  _resetOpeningsUI() {
    this.openings.active = null;
    this.openings.chess = null;
    this.openings.currentIndex = 0;
    this.openings.activeStatus = 'idle';
    document.getElementById('opening-moves-container').classList.add('hidden');
    document.getElementById('opening-explorer-container').classList.add('hidden');
    document.getElementById('btn-opening-start').textContent = 'Start Training';
    this._stopOpeningEngine();
  },

  _validateOpeningDrag(from, to) {
    if (this.openings.activeStatus !== 'playing') return false;
    const clone = new Chess(this.openings.chess.fen());
    try {
      clone.move({ from, to, promotion: 'q' });
    } catch (e) {
      return false;
    }
    return true;
  },

  _getOpeningLegalMoves(square) {
    if (!this.openings.chess) return [];
    return this.openings.chess.moves({ square, verbose: true }).map(m => m.to);
  },

  _handleOpeningPlayerMove(from, to, promotion) {
    this._makeOpeningMove(from, to, promotion);
  },

  _makeOpeningMove(from, to, promotion = null) {
    if (this.activeSubmode !== 'openings' || !this.openings.chess) return;

    if (this.openings.opponentTimeoutId) {
      clearTimeout(this.openings.opponentTimeoutId);
      this.openings.opponentTimeoutId = null;
    }

    const playerColorLetter = this.openings.playerColor === 'white' ? 'w' : 'b';
    const isPlayerTurn = this.openings.chess.turn() === playerColorLetter;

    try {
      this.openings.chess.move({ from, to, promotion: promotion || 'q' });
      this.board.setPosition(this.openings.chess.fen(), true);

      const moveColor = isPlayerTurn ? this.openings.playerColor : (this.openings.playerColor === 'white' ? 'black' : 'white');
      this.board.addLastMoveMarkers(from, to, 'theory', null, moveColor);

      this._updateMovesHistory();
      this._updateOpeningExplorer();
    } catch (e) {
      console.error("Manual move error:", e);
    }
  },

  _updateMovesHistory() {
    const list = document.getElementById('opening-moves-list');
    if (!list || !this.openings.chess) return;

    const container = document.getElementById('opening-moves-container');
    if (container) container.classList.remove('hidden');

    const history = this.openings.chess.history({ verbose: true });
    list.innerHTML = '';

    let moveNum = 1;
    for (let i = 0; i < history.length; i += 2) {
      const whiteMove = history[i] ? history[i].san : '';
      const blackMove = history[i + 1] ? history[i + 1].san : '';
      const row = document.createElement('div');
      row.className = 'py-0.5 border-b border-[var(--border)] flex justify-between';
      row.innerHTML = `
        <span class="text-[var(--text-muted)]">${moveNum}.</span>
        <span class="font-bold text-[var(--text-primary)] flex-1 pl-2">${whiteMove}</span>
        <span class="text-[var(--text-secondary)] flex-1 text-right">${blackMove}</span>
      `;
      list.appendChild(row);
      moveNum++;
    }
  },

  _updateOpeningExplorer() {
    const fen = this.openings.chess.fen();
    const container = document.getElementById('opening-explorer-container');
    if (container) container.classList.remove('hidden');

    const tbody = document.getElementById('opening-explorer-tbody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="4" class="p-3 text-center text-[var(--text-muted)] animate-pulse">Loading explorer...</td></tr>';
    }

    fetch(`${window.API_BASE || ''}/api/openings/explorer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen })
    })
      .then(res => res.json())
      .then(data => {
        if (this.activeSubmode !== 'openings' || !this.openings.chess || this.openings.chess.fen() !== fen) {
          return;
        }

        const moves = data.moves || [];
        this.openings.currentExplorerMoves = moves;

        this.board.drawOpeningHints(moves);

        if (tbody) {
          tbody.innerHTML = '';
          if (moves.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="p-3 text-center text-[var(--text-muted)]">No opening database games found.</td></tr>';
          } else {
            moves.forEach(m => {
              const tr = document.createElement('tr');
              tr.className = 'border-b border-[var(--border)] hover:bg-[var(--bg-card)] cursor-pointer transition-colors';
              tr.dataset.uci = m.uci;

              const wdb = `${m.white_win_ratio}%/${m.draw_ratio}%/${m.black_win_ratio}%`;

              tr.innerHTML = `
                <td class="p-1.5 font-mono font-bold text-[var(--text-primary)]">${m.san}</td>
                <td class="p-1.5 text-right text-[var(--text-secondary)] font-semibold">${m.popularity}%</td>
                <td class="p-1.5 text-right text-[var(--text-muted)] text-[10px]">${wdb}</td>
                <td id="op-eval-${m.uci}" class="p-1.5 text-right font-mono font-semibold text-[var(--text-muted)]">—</td>
              `;
              tbody.appendChild(tr);
            });

            // Add click listeners to rows to manual play
            tbody.querySelectorAll('tr').forEach(tr => {
              tr.addEventListener('click', () => {
                const uci = tr.dataset.uci;
                if (uci) {
                  const from = uci.slice(0, 2);
                  const to = uci.slice(2, 4);
                  this._makeOpeningMove(from, to);
                }
              });
            });
          }
        }

        this._manageOpeningEngine();

        // Manage turn flow and opponent automatic play
        const feedback = document.getElementById('opening-feedback');
        const turn = this.openings.chess.turn();
        const playerColorLetter = this.openings.playerColor === 'white' ? 'w' : 'b';

        if (turn !== playerColorLetter) {
          // Opponent's turn
          this.board.disableInteraction();
          if (moves.length > 0) {
            feedback.textContent = 'Opponent is choosing a response...';
            feedback.className = 'text-center py-1.5 px-3 rounded text-xs font-semibold bg-[var(--bg-primary)] border border-[var(--border)] text-yellow-500';

            this.openings.opponentTimeoutId = setTimeout(() => {
              if (this.activeSubmode !== 'openings' || !this.openings.chess || this.openings.chess.turn() === playerColorLetter) {
                return;
              }
              const topMove = moves[0];
              this._makeOpeningMove(topMove.uci.slice(0, 2), topMove.uci.slice(2, 4));
            }, 800);
          } else {
            feedback.textContent = 'Out of book. Opponent has no popular responses.';
            feedback.className = 'text-center py-1.5 px-3 rounded text-xs font-semibold bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)]';
            this.board.enableInteraction(
              (f, t) => this._validateOpeningDrag(f, t),
              (sq) => this._getOpeningLegalMoves(sq)
            );
          }
        } else {
          // Player's turn
          feedback.textContent = 'Your Turn! Make a move.';
          feedback.className = 'text-center py-1.5 px-3 rounded text-xs font-semibold bg-green-950/20 border border-green-500/30 text-green-400';
          this.board.enableInteraction(
            (f, t) => this._validateOpeningDrag(f, t),
            (sq) => this._getOpeningLegalMoves(sq)
          );
        }
      })
      .catch(err => {
        console.error("Failed to load opening explorer:", err);
        if (tbody) {
          tbody.innerHTML = '<tr><td colspan="4" class="p-3 text-center text-red-400">Failed to load responses.</td></tr>';
        }
      });
  },

  _manageOpeningEngine() {
    const isEngineToggled = document.getElementById('toggle-opening-engine')?.checked;
    this._stopOpeningEngine();

    if (!isEngineToggled || !this.openings.chess) {
      return;
    }

    const fen = this.openings.chess.fen();
    const loc = window.location;
    const wsUrl = `ws://${loc.host}/ws/analyze`;
    const ws = new WebSocket(wsUrl);
    this.openings.ws = ws;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'set_fen', fen, depth: 14 }));
    });

    ws.addEventListener('message', e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'info') {
          const pv = msg.pv || [];
          if (pv.length > 0) {
            const firstMoveUci = pv[0];
            const scoreCp = msg.score_cp;
            const scoreMate = msg.score_mate;

            let scoreStr = '0.00';
            if (scoreMate !== null && scoreMate !== undefined) {
              scoreStr = `#M${scoreMate}`;
            } else if (scoreCp !== null && scoreCp !== undefined) {
              const val = (scoreCp / 100).toFixed(2);
              scoreStr = scoreCp > 0 ? `+${val}` : val;
            }

            const td = document.getElementById(`op-eval-${firstMoveUci}`);
            if (td) {
              td.textContent = scoreStr;
              const valNum = scoreCp !== null ? scoreCp / 100 : (scoreMate > 0 ? 10 : -10);
              const boardTurn = this.openings.chess.turn();
              const isGoodForTurn = (boardTurn === 'w' && valNum > 0) || (boardTurn === 'b' && valNum < 0);

              if (Math.abs(valNum) < 0.5) {
                td.className = 'p-1.5 text-right font-mono font-semibold text-[var(--text-secondary)]';
              } else if (isGoodForTurn) {
                td.className = 'p-1.5 text-right font-mono font-semibold text-[var(--accent-green)]';
              } else {
                td.className = 'p-1.5 text-right font-mono font-semibold text-red-400';
              }
            }
          }
        }
      } catch (err) {
        console.error("Opening WS parse error:", err);
      }
    });

    ws.addEventListener('error', err => {
      console.error("Opening WS error:", err);
    });
  },

  _stopOpeningEngine() {
    if (this.openings.ws) {
      if (this.openings.ws.readyState === WebSocket.OPEN || this.openings.ws.readyState === WebSocket.CONNECTING) {
        this.openings.ws.close();
      }
      this.openings.ws = null;
    }
    if (this.openings.opponentTimeoutId) {
      clearTimeout(this.openings.opponentTimeoutId);
      this.openings.opponentTimeoutId = null;
    }
  },

  // ── Play vs Engine Module ───────────────────────────────────────────────
  _resetEngineUI() {
    this.engine.chess = null;
    this.engine.activeStatus = 'idle';
    this.engine.moves = [];
    document.getElementById('engine-game-status').textContent = 'Ready to play vs Stockfish';
    document.getElementById('engine-game-status').className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)]';
    document.getElementById('engine-moves-container').classList.add('hidden');
    document.getElementById('btn-engine-start').textContent = 'Start Game';
    document.getElementById('btn-engine-resign').classList.add('hidden');
    document.getElementById('btn-engine-review')?.classList.add('hidden');
    this.board.disableInteraction();
  },

  _startEngineGame() {
    this._teardownActiveMode();

    this.engine.chess = new Chess();
    this.engine.activeStatus = 'playing';
    this.engine.moves = [];

    // Randomize side if chosen
    let activeColor = this.engine.playerColor;
    if (activeColor === 'random') {
      activeColor = Math.random() < 0.5 ? 'white' : 'black';
    }
    this.engine.actualColor = activeColor; // Store white or black orientation

    document.getElementById('btn-engine-start').textContent = 'Restart';
    document.getElementById('btn-engine-resign').classList.remove('hidden');
    document.getElementById('btn-engine-review')?.classList.add('hidden');
    document.getElementById('engine-moves-container').classList.remove('hidden');
    
    this._renderEngineMoves();

    this.board.setPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    this.board.setOrientation(activeColor);
    this.board.clearMarrows();

    const status = document.getElementById('engine-game-status');

    if (activeColor === 'black') {
      status.textContent = 'Stockfish is thinking...';
      status.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-[var(--bg-primary)] border border-[var(--border)] text-yellow-500';
      this.board.disableInteraction();
      this._fetchEngineOpponentMove();
    } else {
      status.textContent = 'Your Turn! Make a move.';
      status.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-green-950/20 border border-green-500/30 text-green-400';
      this.board.enableInteraction(
        (f, t) => this._validateEngineDrag(f, t),
        (sq) => this._getEngineLegalMoves(sq)
      );
    }
  },

  _validateEngineDrag(from, to) {
    if (this.engine.activeStatus !== 'playing') return false;
    const clone = new Chess(this.engine.chess.fen());
    try {
      clone.move({ from, to, promotion: 'q' });
    } catch (e) {
      return false;
    }
    return true;
  },

  _getEngineLegalMoves(square) {
    if (!this.engine.chess) return [];
    return this.engine.chess.moves({ square, verbose: true }).map(m => m.to);
  },

  _handleEnginePlayerMove(from, to, promotion) {
    // Player played a move
    const move = this.engine.chess.move({ from, to, promotion: promotion || 'q' });
    this.board.setPosition(this.engine.chess.fen(), true);
    this.board.addLastMoveMarkers(from, to, null, null, this.engine.actualColor);

    this._recordEngineMove(move.san);
    this._renderEngineMoves();

    const status = document.getElementById('engine-game-status');
    
    if (this.engine.chess.isGameOver()) {
      this._handleEngineGameOver();
    } else {
      status.textContent = 'Stockfish is thinking...';
      status.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-[var(--bg-primary)] border border-[var(--border)] text-yellow-500';
      this.board.disableInteraction();
      this._fetchEngineOpponentMove();
    }
  },

  _fetchEngineOpponentMove() {
    fetch(`${window.API_BASE || ''}/api/training/engine-move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fen: this.engine.chess.fen(),
        elo: this.engine.elo
      })
    })
      .then(res => {
        if (!res.ok) throw new Error("Move API error");
        return res.json();
      })
      .then(data => {
        if (this.engine.activeStatus !== 'playing') return; // Cancelled/resigned mid-thought
        
        const best = data.best_move;
        const from = best.slice(0, 2);
        const to = best.slice(2, 4);
        
        const move = this.engine.chess.move({ from, to, promotion: 'q' });
        this.board.setPosition(this.engine.chess.fen(), true);
        this.board.addLastMoveMarkers(from, to, null, null, this.engine.actualColor === 'white' ? 'black' : 'white');

        this._recordEngineMove(move.san);
        this._renderEngineMoves();

        const status = document.getElementById('engine-game-status');

        if (this.engine.chess.isGameOver()) {
          this._handleEngineGameOver();
        } else {
          status.textContent = 'Your Turn! Make a move.';
          status.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-green-950/20 border border-green-500/30 text-green-400';
          this.board.enableInteraction(
            (f, t) => this._validateEngineDrag(f, t),
            (sq) => this._getEngineLegalMoves(sq)
          );
        }
      })
      .catch(err => {
        console.error("Play vs engine error:", err);
        const status = document.getElementById('engine-game-status');
        status.textContent = 'Engine error. Connection lost.';
        status.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-red-950/20 border border-red-500/30 text-red-400';
      });
  },

  _recordEngineMove(san) {
    const history = this.engine.chess.history();
    const totalMoves = history.length;
    
    if (totalMoves % 2 === 1) {
      // White move
      const moveNum = Math.ceil(totalMoves / 2);
      this.engine.moves.push({
        moveNum,
        whiteMove: san,
        blackMove: ''
      });
    } else {
      // Black move
      const activeRow = this.engine.moves[this.engine.moves.length - 1];
      if (activeRow) {
        activeRow.blackMove = san;
      }
    }
  },

  _renderEngineMoves() {
    const container = document.getElementById('engine-moves-list');
    if (!container) return;
    container.innerHTML = '';

    if (this.engine.moves.length === 0) {
      container.innerHTML = `<div class="text-center text-[var(--text-muted)] text-xs py-4 italic">No moves played yet.</div>`;
      return;
    }

    this.engine.moves.forEach(m => {
      const row = document.createElement('div');
      row.className = 'training-move-log-row';

      const num = document.createElement('span');
      num.className = 'training-move-log-num';
      num.textContent = `${m.moveNum}.`;
      row.appendChild(num);

      const wMove = document.createElement('span');
      wMove.className = 'training-move-log-move';
      wMove.textContent = m.whiteMove;
      // Mark as active if it's the absolute last move
      if (!m.blackMove) {
        wMove.className += ' current';
      }
      row.appendChild(wMove);

      const bMove = document.createElement('span');
      bMove.className = 'training-move-log-move';
      bMove.textContent = m.blackMove || '...';
      if (m.blackMove && this.engine.moves[this.engine.moves.length - 1] === m) {
        bMove.className += ' current';
      }
      row.appendChild(bMove);

      container.appendChild(row);
    });

    // Auto scroll to bottom
    container.scrollTop = container.scrollHeight;
  },

  _resignEngineGame() {
    if (this.engine.activeStatus !== 'playing') return;
    this.engine.activeStatus = 'over';
    
    const status = document.getElementById('engine-game-status');
    status.textContent = '🏳️ Game Over. You resigned.';
    status.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-red-950/20 border border-red-500/30 text-red-400 font-bold';
    
    this.board.disableInteraction();
    document.getElementById('btn-engine-resign').classList.add('hidden');
    document.getElementById('btn-engine-review')?.classList.remove('hidden');
  },

  _handleEngineGameOver() {
    this.engine.activeStatus = 'over';
    const chess = this.engine.chess;
    const status = document.getElementById('engine-game-status');
    
    let text = 'Game Over. ';
    if (chess.isCheckmate()) {
      const winner = chess.turn() === 'w' ? 'Black (Stockfish)' : 'White (You)';
      text += `Checkmate! Winner: ${winner}`;
    } else if (chess.isDraw()) {
      text += 'Draw!';
    }
    
    status.textContent = text;
    status.className = 'text-center py-2 px-3 rounded text-xs font-semibold bg-emerald-900/20 border border-emerald-500/30 text-emerald-400 font-bold';
    
    this.board.disableInteraction();
    document.getElementById('btn-engine-resign').classList.add('hidden');
    document.getElementById('btn-engine-review')?.classList.remove('hidden');
  },

  _reviewEngineGame() {
    if (!this.engine.chess) return;

    const isPlayerWhite = (this.engine.actualColor || 'white') === 'white';
    const engineElo = this.engine.elo || 1500;
    const now = new Date().toISOString().split('T')[0].replace(/-/g, '.');

    this.engine.chess.header('Event', 'Play vs Stockfish Engine');
    this.engine.chess.header('Site', 'ChessReviewer');
    this.engine.chess.header('Date', now);

    if (isPlayerWhite) {
      this.engine.chess.header('Black', 'Stockfish');
      this.engine.chess.header('BlackTitle', 'ENGINE');
      this.engine.chess.header('BlackElo', String(engineElo));
    } else {
      this.engine.chess.header('White', 'Stockfish');
      this.engine.chess.header('WhiteTitle', 'ENGINE');
      this.engine.chess.header('WhiteElo', String(engineElo));
    }

    // Determine result
    let result = '*';
    if (this.engine.chess.isCheckmate()) {
      // The side whose turn it is has been checkmated
      result = this.engine.chess.turn() === 'w' ? '0-1' : '1-0';
    } else if (this.engine.chess.isDraw()) {
      result = '1/2-1/2';
    } else if (this.engine.activeStatus === 'over') {
      // Player resigned
      result = isPlayerWhite ? '0-1' : '1-0';
    }
    this.engine.chess.header('Result', result);

    const pgn = this.engine.chess.pgn();
    if (this.onReviewGame) {
      this.onReviewGame(pgn);
    }
  },

  // ── Coordinates Trainer Module ──────────────────────────────────────────
  _resetCoordinatesUI() {
    this.coordinates.score = 0;
    this.coordinates.attempts = 0;
    this.coordinates.timeLeft = 30;
    this.coordinates.activeStatus = 'idle';

    document.getElementById('coordinates-start-screen').classList.remove('hidden');
    document.getElementById('coordinates-active-screen').classList.add('hidden');
    document.getElementById('coordinates-results-screen').classList.add('hidden');
    
    const personalBest = localStorage.getItem('coord_high_score') || 0;
    document.getElementById('coords-high-score').textContent = `Personal Best: ${personalBest} correct clicks`;
  },

  _startCoordinateChallenge() {
    this._teardownActiveMode();

    this.coordinates.score = 0;
    this.coordinates.attempts = 0;
    this.coordinates.timeLeft = 30;
    this.coordinates.activeStatus = 'playing';

    document.getElementById('coordinates-start-screen').classList.add('hidden');
    document.getElementById('coordinates-results-screen').classList.add('hidden');
    document.getElementById('coordinates-active-screen').classList.remove('hidden');

    document.getElementById('coords-score').textContent = '0';
    document.getElementById('coords-timer').textContent = '30s';
    document.getElementById('coords-active-feedback').textContent = 'Click square quickly!';

    this.board.setPosition('8/8/8/8/8/8/8/8 w - - 0 1');
    this.board.setOrientation(this.coordinates.orientation);
    this.board.clearMarrows();
    this.board.disableInteraction();

    this._generateNextCoordinateTarget();

    // Start timer loop
    this.coordinates.timerId = setInterval(() => {
      this.coordinates.timeLeft--;
      const timerEl = document.getElementById('coords-timer');
      if (timerEl) {
        timerEl.textContent = `${this.coordinates.timeLeft}s`;
      }

      if (this.coordinates.timeLeft <= 0) {
        this._endCoordinateChallenge();
      }
    }, 1000);
  },

  _generateNextCoordinateTarget() {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = ['1', '2', '3', '4', '5', '6', '7', '8'];
    
    let nextTarget = '';
    do {
      const file = files[Math.floor(Math.random() * 8)];
      const rank = ranks[Math.floor(Math.random() * 8)];
      nextTarget = file + rank;
    } while (nextTarget === this.coordinates.target); // Ensure new target is different

    this.coordinates.target = nextTarget;
    
    const targetEl = document.getElementById('coords-target');
    if (targetEl) {
      targetEl.textContent = nextTarget;
      // Re-trigger animation
      targetEl.style.animation = 'none';
      targetEl.offsetHeight; // Reflow
      targetEl.style.animation = 'target-grow 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
    }
  },

  _setupCoordinateClickListener() {
    const boardEl = document.getElementById('board');
    if (!boardEl) return;
    
    boardEl.addEventListener('mousedown', (e) => {
      if (this.activeSubmode !== 'coordinates' || this.coordinates.activeStatus !== 'playing') return;
      
      const squareEl = e.target.closest('.square');
      if (squareEl) {
        const square = squareEl.dataset.square;
        this._handleCoordinateClick(square);
      }
    });
  },

  _handleCoordinateClick(square) {
    if (this.coordinates.activeStatus !== 'playing') return;

    this.coordinates.attempts++;
    const isCorrect = (square === this.coordinates.target);
    
    const boardEl = document.getElementById('board');
    const feedbackEl = document.getElementById('coords-active-feedback');

    // Trigger board flashes and custom highlights
    if (boardEl) {
      boardEl.classList.remove('correct-board-flash', 'incorrect-board-flash');
      boardEl.offsetHeight; // Reflow
      boardEl.classList.add(isCorrect ? 'correct-board-flash' : 'incorrect-board-flash');
    }

    this.board.clearMarrows();
    this.board.addCoordTrainerMarker(square, isCorrect);

    if (isCorrect) {
      this.coordinates.score++;
      if (feedbackEl) feedbackEl.textContent = '✓ Correct!';
      document.getElementById('coords-score').textContent = this.coordinates.score;
    } else {
      if (feedbackEl) feedbackEl.textContent = `✗ Wrong! That was ${square.toUpperCase()}`;
    }

    // Schedule next target and clear markers
    setTimeout(() => {
      this.board.clearMarrows();
    }, 400);

    this._generateNextCoordinateTarget();
  },

  _endCoordinateChallenge() {
    clearInterval(this.coordinates.timerId);
    this.coordinates.timerId = null;
    this.coordinates.activeStatus = 'ended';

    this.board.clearMarrows();
    
    // Save High Score
    const currentHighScore = parseInt(localStorage.getItem('coord_high_score') || '0', 10);
    const score = this.coordinates.score;
    const attempts = this.coordinates.attempts;
    const accuracy = attempts > 0 ? Math.round((score / attempts) * 100) : 0;

    if (score > currentHighScore) {
      localStorage.setItem('coord_high_score', score);
    }

    // Show results
    document.getElementById('coordinates-active-screen').classList.add('hidden');
    document.getElementById('coordinates-results-screen').classList.remove('hidden');

    document.getElementById('coords-result-score').textContent = score;
    document.getElementById('coords-result-attempts').textContent = attempts;
    document.getElementById('coords-result-accuracy').textContent = `${accuracy}%`;
  }
};

// Add board coordinate marker support helper to BoardManager class dynamically
import('./board.js').then(module => {
  if (module.BoardManager) {
    module.BoardManager.prototype.addCoordTrainerMarker = function(square, isCorrect) {
      if (!this._board) return;
      const marker = isCorrect
        ? { class: 'marker-coord-correct', slice: 'markerSquare' }
        : { class: 'marker-coord-incorrect', slice: 'markerSquare' };
      this._board.addMarker(marker, square);
    };
  }
});
