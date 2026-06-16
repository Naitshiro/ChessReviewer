/**
 * board.js — cm-chessboard wrapper for ChessReviewer
 * Manages the board instance, piece movement, markers, and engine arrows.
 */

import { Chessboard, COLOR, INPUT_EVENT_TYPE } from
  'https://cdn.jsdelivr.net/npm/cm-chessboard@8/src/Chessboard.js';
import { Arrows, ARROW_TYPE } from
  'https://cdn.jsdelivr.net/npm/cm-chessboard@8/src/extensions/arrows/Arrows.js';
import { Markers, MARKER_TYPE } from
  'https://cdn.jsdelivr.net/npm/cm-chessboard@8/src/extensions/markers/Markers.js';

// CDN assets URL for cm-chessboard (piece sprites, CSS)
const CM_ASSETS = 'https://cdn.jsdelivr.net/npm/cm-chessboard@8/assets/';

// Inject cm-chessboard CSS dynamically
(function injectCSS() {
  const styles = [
    CM_ASSETS + 'chessboard.css',
    CM_ASSETS + 'extensions/arrows/arrows.css',
    CM_ASSETS + 'extensions/markers/markers.css',
  ];
  styles.forEach(href => {
    if (!document.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      document.head.appendChild(link);
    }
  });
})();

/** Arrow type mapping for MultiPV lines
 *  Explicitly defining the classes to avoid version mismatch issues with ARROW_TYPE exports
 *  info = best move (green), success = 2nd (blue), danger = 3rd (purple) */
const ARROW_TYPES = [
  {class: 'arrow-info', slice: 'arrowDefault'}, 
  {class: 'arrow-success', slice: 'arrowDefault'}, 
  {class: 'arrow-danger', slice: 'arrowDefault'}
];

// Custom markers for move classifications
const CLASSIFICATION_MARKERS = {
  brilliant:  { class: 'marker-brilliant',  slice: 'markerSquare' },
  great:      { class: 'marker-great',      slice: 'markerSquare' },
  best:       { class: 'marker-best',       slice: 'markerSquare' },
  excellent:  { class: 'marker-excellent',  slice: 'markerSquare' },
  good:       { class: 'marker-good',       slice: 'markerSquare' },
  inaccuracy: { class: 'marker-inaccuracy', slice: 'markerSquare' },
  mistake:    { class: 'marker-mistake',    slice: 'markerSquare' },
  miss:       { class: 'marker-miss',       slice: 'markerSquare' },
  blunder:    { class: 'marker-blunder',    slice: 'markerSquare' },
  theory:     { class: 'marker-theory',     slice: 'markerSquare' },
};

/**
 * BoardManager wraps cm-chessboard and exposes a clean interface
 * for the application state machine.
 */
export class BoardManager {
  constructor(elementId) {
    this._elementId = elementId;
    this._board = null;
    this._onMoveCallback = null;
    this._interactive = false;
    this._orientation = COLOR.white;
    this._currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    this._activeBadge = null; // { square, classification }
  }

  /**
   * Initialize the chessboard. Must be called once after DOM is ready.
   * @param {Function} onMove - callback(from, to, promotion) when user drags a piece
   */
  init(onMove) {
    this._onMoveCallback = onMove;

    this._board = new Chessboard(document.getElementById(this._elementId), {
      position: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      assetsUrl: "assets/",
      style: {
        cssClass: 'default',
        pieces: { file: "pieces/neo.svg" },
        showCoordinates: true,
        moveFromMarker: MARKER_TYPE.frame,
        moveToMarker:   MARKER_TYPE.frame,
      },
      orientation: COLOR.white,
      extensions: [
        { class: Arrows },
        { class: Markers },
      ],
    });

    // Disable interaction by default (enabled in Review/Analysis mode)
    this._board.disableMoveInput();

    // Redraw badge on window resize
    window.addEventListener('resize', () => {
      this._redrawActiveBadge();
    });
  }

  // ── Position ──────────────────────────────────────────────────────────

  /**
   * Set the board to a FEN position.
   * @param {string} fen
   * @param {boolean} [animate=true]
   */
  async setPosition(fen, animate = true) {
    if (!this._board) return;
    this._currentFen = fen;
    await this._board.setPosition(fen, animate);
  }

  get currentFen() { return this._currentFen; }

  // ── Orientation ───────────────────────────────────────────────────────

  setOrientation(color) {
    if (!this._board) return;
    this._orientation = color === 'black' ? COLOR.black : COLOR.white;
    this._board.setOrientation(this._orientation);
    this._redrawActiveBadge();
  }

  flipBoard() {
    if (!this._board) return;
    this._orientation = this._orientation === COLOR.white ? COLOR.black : COLOR.white;
    this._board.setOrientation(this._orientation);
    this._redrawActiveBadge();
  }

  // ── Interactivity ─────────────────────────────────────────────────────

  /**
   * Enable interactive piece dragging.
   * @param {Function} validateMove - (from, to) => bool; if false, move is rejected
   * @param {Function} getValidMoves - (from) => string[]; returns array of valid target squares
   */
  enableInteraction(validateMove, getValidMoves) {
    if (!this._board || this._interactive) return;
    this._interactive = true;

    this._board.enableMoveInput((event) => {
      switch (event.type) {
        case INPUT_EVENT_TYPE.moveInputStarted:
          if (getValidMoves) {
            const moves = getValidMoves(event.squareFrom);
            moves.forEach(to => this._board.addMarker(MARKER_TYPE.dot, to));
          }
          return true; // allow picking up any piece

        case INPUT_EVENT_TYPE.validateMoveInput: {
          this._board.removeMarkers(MARKER_TYPE.dot);
          
          const from = event.squareFrom;
          const to   = event.squareTo;

          // Ask the caller if the move is valid
          if (validateMove && !validateMove(from, to)) {
            return false;
          }

          // Notify the app of the move
          if (this._onMoveCallback) {
            // Use a microtask so cm-chessboard finishes its internal animation first
            queueMicrotask(() => this._onMoveCallback(from, to, event.promotion || null));
          }
          return true;
        }

        case INPUT_EVENT_TYPE.moveInputCanceled:
          this._board.removeMarkers(MARKER_TYPE.dot);
          return true;

        default:
          return true;
      }
    });
  }

  disableInteraction() {
    if (!this._board || !this._interactive) return;
    this._interactive = false;
    this._board.disableMoveInput();
  }

  // ── Markers (last-move highlight) ─────────────────────────────────────

  clearMarkers() {
    if (!this._board) return;
    this._board.removeMarkers();
    this.clearClassificationBadge();
  }

  addLastMoveMarkers(fromSq, toSq, classification = null) {
    if (!this._board || !fromSq || !toSq) return;
    this.clearMarkers();
    
    // Highlight from-square (always default highlight)
    this._board.addMarker(MARKER_TYPE.square, fromSq);

    // Highlight to-square with classification or default highlight
    if (classification && CLASSIFICATION_MARKERS[classification]) {
      this._board.addMarker(CLASSIFICATION_MARKERS[classification], toSq);
      this.showClassificationBadge(toSq, classification);
    } else {
      this._board.addMarker(MARKER_TYPE.square, toSq);
      this.clearClassificationBadge();
    }
  }

  // ── Classification Badges ─────────────────────────────────────────────

  showClassificationBadge(square, classification) {
    // Keep track of active badge state
    this._activeBadge = { square, classification };

    // Find wrapper (must be relative positioned)
    const wrapper = document.getElementById('board-wrapper');
    if (!wrapper) return;

    // Remove any existing badge first
    document.querySelectorAll('#board-class-badge').forEach(el => el.remove());

    const boardEl = document.getElementById(this._elementId);
    if (!boardEl) return;

    const boardRect = boardEl.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();

    const squareSize = boardRect.width / 8;
    const badgeSize = Math.max(26, Math.min(36, squareSize * 0.45)); // Responsive sizing (min 26px, max 36px)

    // File (a-h -> 0-7) and Rank (1-8 -> 0-7)
    const file = square.charCodeAt(0) - 97;
    const rank = parseInt(square.charAt(1), 10) - 1;

    let col = file;
    let row = rank;

    // Flip coordinates if board is black orientation
    if (this._orientation === 'black' || this._orientation === COLOR.black) {
      col = 7 - file;
      row = rank;
    } else {
      col = file;
      row = 7 - rank;
    }

    // Coordinates relative to wrapper
    const boardLeft = boardRect.left - wrapperRect.left;
    const boardTop = boardRect.top - wrapperRect.top;

    const x = boardLeft + col * squareSize + squareSize - (badgeSize / 2);
    const y = boardTop + row * squareSize - (badgeSize / 2);

    // Create DOM element
    const badge = document.createElement('div');
    badge.id = 'board-class-badge';
    badge.className = `board-class-badge badge-${classification}`;
    badge.style.width = `${badgeSize}px`;
    badge.style.height = `${badgeSize}px`;
    badge.style.left = `${x}px`;
    badge.style.top = `${y}px`;

    // Map symbols (using checkmarks for excellent and good, matching chess.com)
    const symbols = {
      brilliant: '!!',
      great: '!',
      best: '★',
      excellent: '✓',
      good: '✓',
      inaccuracy: '?!',
      mistake: '?',
      miss: '✗',
      blunder: '??',
      theory: '⌕',
    };
    badge.textContent = symbols[classification] || '';

    wrapper.appendChild(badge);
  }

  clearClassificationBadge() {
    this._activeBadge = null;
    document.querySelectorAll('#board-class-badge').forEach(el => el.remove());
  }

  _redrawActiveBadge() {
    if (this._activeBadge) {
      const { square, classification } = this._activeBadge;
      this.showClassificationBadge(square, classification);
    }
  }

  // ── Engine Arrows (MultiPV) ───────────────────────────────────────────

  clearArrows() {
    if (!this._board) return;
    this._board.removeArrows();
  }

  /**
   * Draw engine suggestion arrows for up to 3 MultiPV lines.
   * @param {Array<{from_sq: string, to_sq: string, multipv: number}>} lines
   */
  drawEngineArrows(lines) {
    if (!this._board) return;
    this.clearArrows();

    let linesToDraw = [...lines];
    if (linesToDraw.length > 0) {
      const best = linesToDraw[0];
      // If the best move is a forced mate in 1 or mate in 0, remove the other arrows
      if (best.score_mate === 1 || best.score_mate === -1 || best.score_mate === 0) {
        linesToDraw = [best];
      }
    }

    // Draw in reverse order so the best move (PV1) is rendered last = on top
    const sorted = linesToDraw.sort((a, b) => (b.multipv || 1) - (a.multipv || 1));
    for (const line of sorted) {
      const pvIdx = (line.multipv || 1) - 1;   // 0-based
      const arrowType = ARROW_TYPES[Math.min(pvIdx, ARROW_TYPES.length - 1)];

      if (line.from_sq && line.to_sq) {
        this._board.addArrow(arrowType, line.from_sq, line.to_sq);
      }
    }
  }

  // ── Combined helpers ─────────────────────────────────────────────────

  /** Clear both markers and arrows in one call. */
  clearMarrows() {
    this.clearMarkers();
    this.clearArrows();
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  destroy() {
    if (this._board) {
      this._board.destroy();
      this._board = null;
    }
  }
}
