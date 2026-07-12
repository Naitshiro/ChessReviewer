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
import { PromotionDialog, PROMOTION_DIALOG_RESULT_TYPE } from
  'https://cdn.jsdelivr.net/npm/cm-chessboard@8/src/extensions/promotion-dialog/PromotionDialog.js';
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';

// CDN assets URL for cm-chessboard (piece sprites, CSS)
const CM_ASSETS = 'https://cdn.jsdelivr.net/npm/cm-chessboard@8/assets/';

// Inject cm-chessboard CSS dynamically
(function injectCSS() {
  const styles = [
    CM_ASSETS + 'chessboard.css',
    CM_ASSETS + 'extensions/arrows/arrows.css',
    CM_ASSETS + 'extensions/markers/markers.css',
    CM_ASSETS + 'extensions/promotion-dialog/promotion-dialog.css',
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
  { class: 'arrow-info', slice: 'arrowDefault' },
  { class: 'arrow-success', slice: 'arrowDefault' },
  { class: 'arrow-danger', slice: 'arrowDefault' }
];

// Custom markers for move classifications
const CLASSIFICATION_MARKERS = {
  brilliant: { class: 'marker-brilliant', slice: 'markerSquare' },
  great: { class: 'marker-great', slice: 'markerSquare' },
  best: { class: 'marker-best', slice: 'markerSquare' },
  excellent: { class: 'marker-excellent', slice: 'markerSquare' },
  good: { class: 'marker-good', slice: 'markerSquare' },
  inaccuracy: { class: 'marker-inaccuracy', slice: 'markerSquare' },
  mistake: { class: 'marker-mistake', slice: 'markerSquare' },
  blunder: { class: 'marker-blunder', slice: 'markerSquare' },
  theory: { class: 'marker-theory', slice: 'markerSquare' },
  winner: { class: 'marker-winner', slice: 'markerSquare' },
  loser: { class: 'marker-loser', slice: 'markerSquare' },
  draw: { class: 'marker-draw', slice: 'markerSquare' },
};

const ANNOTATION_MARKERS = {
  white: { class: 'marker-annotation-white', slice: 'markerSquare' },
  black: { class: 'marker-annotation-black', slice: 'markerSquare' },
};

class ChessAudio {
  constructor() {
    this.sounds = {
      move: new Audio('assets/sounds/move-self.mp3'),
      capture: new Audio('assets/sounds/capture.mp3'),
      check: new Audio('assets/sounds/move-check.mp3'),
      castle: new Audio('assets/sounds/castle.mp3'),
      promote: new Audio('assets/sounds/promote.mp3')
    };

    // Preload all audio assets
    for (const key in this.sounds) {
      this.sounds[key].load();
    }
  }

  play(type) {
    try {
      const audio = this.sounds[type];
      if (audio) {
        // Clone the node so multiple sounds can play simultaneously
        const soundClone = audio.cloneNode();
        soundClone.play().catch(err => {
          console.warn("Audio playback prevented:", err);
        });
      }
    } catch (e) {
      console.warn("Failed to play chess sound:", e);
    }
  }
}

function getFenKey(fen) {
  if (!fen) return '';
  return fen.split(' ').slice(0, 4).join(' ');
}

function detectMoveType(prevFen, newFen) {
  if (!prevFen || !newFen) return null;
  const keyPrev = getFenKey(prevFen);
  const keyNew = getFenKey(newFen);
  if (keyPrev === keyNew) return null;

  try {
    const c1 = new Chess(prevFen);
    for (const m of c1.moves({ verbose: true })) {
      const clone = new Chess(prevFen);
      clone.move(m);
      if (getFenKey(clone.fen()) === keyNew) {
        if (clone.inCheck()) {
          return 'check';
        }
        if (m.flags.includes('k') || m.flags.includes('q')) {
          return 'castle';
        }
        if (m.flags.includes('p')) {
          return 'promote';
        }
        if (m.flags.includes('c') || m.flags.includes('e')) {
          return 'capture';
        }
        return 'move';
      }
    }

    const c2 = new Chess(newFen);
    for (const m of c2.moves({ verbose: true })) {
      const clone = new Chess(newFen);
      clone.move(m);
      if (getFenKey(clone.fen()) === keyPrev) {
        return 'move';
      }
    }
  } catch (e) {
    console.warn("Error in detectMoveType:", e);
  }
  return "move";
}

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
    this._activeBadges = []; // Array of { square, text, type, color }
    this._audio = new ChessAudio();
    this.soundEnabled = localStorage.getItem('chess_sound_enabled') !== 'false';

    // User right-click annotations
    this._userHighlights = new Set();
    this._userArrows = new Set();
    this._previewArrow = null;
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
        moveFromMarker: null,
        moveToMarker: null,
      },
      orientation: COLOR.white,
      extensions: [
        { class: Arrows },
        { class: Markers },
        { class: PromotionDialog },
      ],
    });

    // Disable interaction by default (enabled in Review/Analysis mode)
    this._board.disableMoveInput();

    // Redraw badge on window resize
    window.addEventListener('resize', () => {
      this._redrawActiveBadge();
    });

    // Setup right-click highlights and arrows
    const boardEl = document.getElementById(this._elementId);
    const boardWrapper = boardEl ? boardEl.parentElement : null;
    if (boardWrapper) {
      if (!document.getElementById('board-arrows-overlay')) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('id', 'board-arrows-overlay');
        svg.setAttribute('class', 'absolute top-0 left-0 w-full h-full pointer-events-none z-10');
        svg.setAttribute('viewBox', '0 0 800 800');
        svg.style.display = 'block';
        boardWrapper.appendChild(svg);
      }

      this._contextMenuHandler = this._handleContextMenu.bind(this);
      this._mouseDownHandler = this._handleMouseDown.bind(this);
      this._mouseMoveHandler = this._handleMouseMove.bind(this);
      this._mouseUpHandler = this._handleMouseUp.bind(this);

      boardWrapper.addEventListener('contextmenu', this._contextMenuHandler);
      boardWrapper.addEventListener('mousedown', this._mouseDownHandler);
      boardWrapper.addEventListener('mousemove', this._mouseMoveHandler);
      window.addEventListener('mouseup', this._mouseUpHandler);
    }
  }

  // ── Position ──────────────────────────────────────────────────────────

  /**
   * Set the board to a FEN position.
   * @param {string} fen
   * @param {boolean} [animate=true]
   */
  async setPosition(fen, animate = true) {
    if (!this._board) return;
    const oldFen = this._currentFen;
    this._currentFen = fen;

    if (this.soundEnabled && oldFen && oldFen !== fen) {
      const type = detectMoveType(oldFen, fen);
      if (type) {
        this._audio.play(type);
      }
    }

    this.clearUserDrawings();
    await this._board.setPosition(fen, animate);
  }

  get currentFen() { return this._currentFen; }

  // ── Orientation ───────────────────────────────────────────────────────

  setOrientation(color) {
    if (!this._board) return;
    this._orientation = color === 'black' ? COLOR.black : COLOR.white;
    this._board.setOrientation(this._orientation);
    this._redrawActiveBadge();
    this.renderUserDrawings();
  }

  flipBoard() {
    if (!this._board) return;
    this._orientation = this._orientation === COLOR.white ? COLOR.black : COLOR.white;
    this._board.setOrientation(this._orientation);
    this._redrawActiveBadge();
    this.renderUserDrawings();
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
          const to = event.squareTo;

          // Check for re-selection (clicking another piece of the same color)
          try {
            const chess = new Chess(this._currentFen);
            const pieceFrom = chess.get(from);
            const pieceTo = chess.get(to);
            if (pieceFrom && pieceTo && pieceFrom.color === pieceTo.color) {
              setTimeout(() => {
                const squareEl = document.querySelector(`#${this._elementId} [data-square="${to}"]`);
                if (squareEl) {
                  squareEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                  squareEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
                }
              }, 0);
              return false;
            }
          } catch (e) {
            console.warn("Error checking re-selection:", e);
          }

          // Ask the caller if the move is valid
          if (validateMove && !validateMove(from, to)) {
            return false;
          }

          // Check for pawn promotion
          let isPromotion = false;
          let color = COLOR.white;
          try {
            const chess = new Chess(this._currentFen);
            const piece = chess.get(from);
            if (piece && piece.type === 'p') {
              color = piece.color === 'w' ? COLOR.white : COLOR.black;
              const possibleMoves = chess.moves({ square: from, verbose: true });
              for (const m of possibleMoves) {
                if (m.promotion && m.to === to) {
                  isPromotion = true;
                  break;
                }
              }
            }
          } catch (e) {
            console.warn("Error checking promotion move:", e);
          }

          if (isPromotion) {
            this._board.showPromotionDialog(to, color, (result) => {
              if (result.type === PROMOTION_DIALOG_RESULT_TYPE.pieceSelected) {
                const promoChar = result.piece.charAt(1); // 'q', 'r', 'b', 'n'
                if (this._onMoveCallback) {
                  queueMicrotask(() => this._onMoveCallback(from, to, promoChar));
                }
              } else {
                // Promotion canceled — restore board state
                this._board.setPosition(this._currentFen, true);
              }
            });
            return true;
          }

          // Notify the app of the move
          if (this._onMoveCallback) {
            // Use a microtask so cm-chessboard finishes its internal animation first
            queueMicrotask(() => this._onMoveCallback(from, to, null));
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

  addLastMoveMarkers(fromSq, toSq, classification = null, annotationObj = null, moveColor = 'white') {
    if (!this._board || !fromSq || !toSq) return;
    this.clearMarkers();

    if (classification && CLASSIFICATION_MARKERS[classification]) {
      this._board.addMarker(CLASSIFICATION_MARKERS[classification], fromSq);
      this._board.addMarker(CLASSIFICATION_MARKERS[classification], toSq);
      this.showClassificationBadge(toSq, classification, 'classification', moveColor);
    } else if (annotationObj) {
      const marker = moveColor === 'black' ? ANNOTATION_MARKERS.black : ANNOTATION_MARKERS.white;
      this._board.addMarker(marker, fromSq);
      this._board.addMarker(marker, toSq);
      this.showClassificationBadge(toSq, annotationObj, 'annotation', moveColor);
    } else {
      this._board.addMarker(MARKER_TYPE.square, fromSq);
      this._board.addMarker(MARKER_TYPE.square, toSq);
      this.clearClassificationBadge();
    }
  }

  // ── Classification Badges ─────────────────────────────────────────────

  showClassificationBadges(badges) {
    // badges is an array of { square, text, type, color }
    this._activeBadges = badges;
    this._renderActiveBadges();
  }

  showClassificationBadge(square, text, type = 'classification', moveColor = 'white') {
    this.showClassificationBadges([{ square, text, type, color: moveColor }]);
  }



  clearClassificationBadge() {
    this._activeBadges = [];
    document.querySelectorAll('.board-class-badge').forEach(el => el.remove());
  }

  _redrawActiveBadge() {
    this._renderActiveBadges();
  }

  _renderActiveBadges() {
    const wrapper = document.getElementById('board-wrapper');
    if (!wrapper) return;

    // Remove any existing badges first
    document.querySelectorAll('.board-class-badge').forEach(el => el.remove());

    if (!this._activeBadges || this._activeBadges.length === 0) return;

    const boardEl = document.getElementById(this._elementId);
    if (!boardEl) return;

    const boardRect = boardEl.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();

    const squareSize = boardRect.width / 8;
    const badgeSize = Math.max(26, Math.min(36, squareSize * 0.45));

    for (const badgeData of this._activeBadges) {
      const { square, text, type, color } = badgeData;
      if (!square) continue;

      const file = square.charCodeAt(0) - 97;
      const rank = parseInt(square.charAt(1), 10) - 1;

      let col = file;
      let row = rank;

      if (this._orientation === 'black' || this._orientation === COLOR.black) {
        col = 7 - file;
        row = rank;
      } else {
        col = file;
        row = 7 - rank;
      }

      const boardLeft = boardRect.left - wrapperRect.left;
      const boardTop = boardRect.top - wrapperRect.top;

      const x = boardLeft + col * squareSize + squareSize - (badgeSize / 2);
      const y = boardTop + row * squareSize - (badgeSize / 2);

      const badge = document.createElement('img');
      badge.style.width = `${badgeSize}px`;
      badge.style.height = `${badgeSize}px`;
      badge.style.left = `${x}px`;
      badge.style.top = `${y}px`;
      badge.style.pointerEvents = 'none';
      badge.className = 'board-class-badge';

      badge.onerror = () => {
        console.error(`[Badges] Failed to load badge image for classification: "${text}" from URL: "${badge.src}"`);
      };

      if (type === 'classification') {
        badge.src = `assets/markers/${text}.svg`;
        badge.alt = text;
      } else {
        badge.src = `assets/markers/${text.svg}`;
        badge.alt = text.label || text;
        if (color === 'white') {
          badge.style.filter = 'invert(1)';
        }
      }

      console.log(`[Badges] Rendered badge "${text}" on square ${square} (col:${col}, row:${row}) at position left:${x}px, top:${y}px with size ${badgeSize}px.`);
      wrapper.appendChild(badge);
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

  /**
   * Draw threat arrows for up to 3 threat moves.
   * @param {Array<{from: string, to: string, multipv: number}>} threats
   */
  drawThreatArrows(threats) {
    if (!this._board) return;
    this.clearArrows();

    const threatTypes = [
      { class: 'threat-pv1', slice: 'arrowDefault' },
      { class: 'threat-pv2', slice: 'arrowDefault' },
      { class: 'threat-pv3', slice: 'arrowDefault' }
    ];

    // Draw in reverse order so multipv 1 (Highest Threat) is on top
    const sorted = [...threats].sort((a, b) => b.multipv - a.multipv);
    for (const threat of sorted) {
      const idx = threat.multipv - 1; // 1-based to 0-based
      const arrowType = threatTypes[Math.min(idx, threatTypes.length - 1)];

      if (threat.from && threat.to) {
        this._board.addArrow(arrowType, threat.from, threat.to);
      }
    }
  }

  /**
   * Draw both engine suggestions and threat arrows simultaneously.
   * @param {Array<{from_sq: string, to_sq: string, multipv: number}>} engineLines
   * @param {Array<{from: string, to: string, multipv: number}>} threats
   */
  drawAllArrows(engineLines, threats) {
    if (!this._board) return;
    this.clearArrows();

    // 1. Draw engine arrows
    if (engineLines && engineLines.length > 0) {
      let linesToDraw = [...engineLines];
      const best = linesToDraw[0];
      if (best.score_mate === 1 || best.score_mate === -1 || best.score_mate === 0) {
        linesToDraw = [best];
      }
      const sorted = linesToDraw.sort((a, b) => (b.multipv || 1) - (a.multipv || 1));
      for (const line of sorted) {
        const pvIdx = (line.multipv || 1) - 1;
        const arrowType = ARROW_TYPES[Math.min(pvIdx, ARROW_TYPES.length - 1)];
        if (line.from_sq && line.to_sq) {
          this._board.addArrow(arrowType, line.from_sq, line.to_sq);
        }
      }
    }

    // 2. Draw threat arrows
    if (threats && threats.length > 0) {
      const threatTypes = [
        { class: 'threat-pv1', slice: 'arrowDefault' },
        { class: 'threat-pv2', slice: 'arrowDefault' },
        { class: 'threat-pv3', slice: 'arrowDefault' }
      ];
      const sorted = [...threats].sort((a, b) => b.multipv - a.multipv);
      for (const threat of sorted) {
        const idx = threat.multipv - 1;
        const arrowType = threatTypes[Math.min(idx, threatTypes.length - 1)];
        if (threat.from && threat.to) {
          this._board.addArrow(arrowType, threat.from, threat.to);
        }
      }
    }
  }

  /**
   * Draw opening popularity hints on the board.
   * @param {Array<{uci: string, popularity: number}>} moves
   */
  drawOpeningHints(moves) {
    if (!this._board) return;
    this.clearArrows();
    moves.forEach((m, idx) => {
      const from = m.uci.slice(0, 2);
      const to = m.uci.slice(2, 4);
      if (from && to) {
        const arrowType = idx === 0
          ? { class: 'arrow-info', slice: 'arrowDefault' }
          : { class: 'arrow-danger', slice: 'arrowDefault' };
        this._board.addArrow(arrowType, from, to);
      }
    });
  }

  // ── Combined helpers ─────────────────────────────────────────────────

  /** Clear both markers and arrows in one call. */
  clearMarrows() {
    this.clearMarkers();
    this.clearArrows();
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  destroy() {
    const boardEl = document.getElementById(this._elementId);
    const boardWrapper = boardEl ? boardEl.parentElement : null;
    if (boardWrapper) {
      if (this._contextMenuHandler) boardWrapper.removeEventListener('contextmenu', this._contextMenuHandler);
      if (this._mouseDownHandler) boardWrapper.removeEventListener('mousedown', this._mouseDownHandler);
      if (this._mouseMoveHandler) boardWrapper.removeEventListener('mousemove', this._mouseMoveHandler);
      const svg = document.getElementById('board-arrows-overlay');
      if (svg) svg.remove();
      const highlights = boardWrapper.querySelector('#board-highlights-container');
      if (highlights) highlights.remove();
    }
    if (this._mouseUpHandler) window.removeEventListener('mouseup', this._mouseUpHandler);

    if (this._board) {
      this._board.destroy();
      this._board = null;
    }
  }

  // ── User Right-Click Drawing Logic ────────────────────────────────────

  _handleContextMenu(e) {
    e.preventDefault();
  }

  _handleMouseDown(e) {
    if (e.button === 0) {
      // Left click: clear user highlights and arrows
      this.clearUserDrawings();
    } else if (e.button === 2) {
      e.preventDefault();
      const boardWrapper = e.currentTarget;
      const rect = boardWrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const startSquare = this._getSquareFromCoords(x, y, rect);
      if (startSquare) {
        this._rightClickStartSquare = startSquare;
        this._rightClickActive = true;
        this._rightClickHasDragged = false;
      }
    }
  }

  _handleMouseMove(e) {
    if (this._rightClickActive) {
      const boardWrapper = document.getElementById('board-wrapper');
      if (!boardWrapper) return;
      const rect = boardWrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const currentSquare = this._getSquareFromCoords(x, y, rect);
      if (currentSquare && currentSquare !== this._rightClickStartSquare) {
        this._rightClickHasDragged = true;
        this._previewArrow = { from: this._rightClickStartSquare, to: currentSquare };
      } else {
        this._previewArrow = null;
      }
      this.renderUserDrawings();
    }
  }

  _handleMouseUp(e) {
    if (this._rightClickActive) {
      if (e.button === 2) {
        this._rightClickActive = false;
        const boardWrapper = document.getElementById('board-wrapper');
        if (!boardWrapper) return;
        const rect = boardWrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const endSquare = this._getSquareFromCoords(x, y, rect);

        if (this._rightClickHasDragged && endSquare && endSquare !== this._rightClickStartSquare) {
          this.toggleUserArrow(this._rightClickStartSquare, endSquare);
        } else if (!this._rightClickHasDragged && endSquare === this._rightClickStartSquare) {
          this.toggleUserHighlight(this._rightClickStartSquare);
        }
        this._previewArrow = null;
        this.renderUserDrawings();
      }
    }
  }

  _getSquareFromCoords(x, y, rect) {
    const squareSize = rect.width / 8;
    const col = Math.floor(x / squareSize);
    const row = Math.floor(y / squareSize);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;

    const isBlack = this._orientation === 'black' || this._orientation === COLOR.black;
    let file, rank;
    if (isBlack) {
      file = 7 - col;
      rank = row + 1;
    } else {
      file = col;
      rank = 8 - row;
    }
    return String.fromCharCode(97 + file) + rank;
  }

  _squareToColRow(square, isBlack) {
    if (!square || square.length < 2) return null;
    const file = square.charCodeAt(0) - 97; // 0..7
    const rank = parseInt(square.charAt(1), 10) - 1; // 0..7

    let col, row;
    if (isBlack) {
      col = 7 - file;
      row = rank;
    } else {
      col = file;
      row = 7 - rank;
    }
    return { col, row };
  }

  toggleUserHighlight(square) {
    if (this._userHighlights.has(square)) {
      this._userHighlights.delete(square);
    } else {
      this._userHighlights.add(square);
    }
  }

  toggleUserArrow(from, to) {
    const arrowStr = `${from}${to}`;
    if (this._userArrows.has(arrowStr)) {
      this._userArrows.delete(arrowStr);
    } else {
      this._userArrows.add(arrowStr);
    }
  }

  clearUserDrawings() {
    this._userHighlights.clear();
    this._userArrows.clear();
    this._previewArrow = null;

    const highlightsGroup = this._getHighlightsContainer();
    if (highlightsGroup) {
      highlightsGroup.innerHTML = '';
    }

    this.renderUserDrawings();
  }

  _getSquareSize(boardSvg) {
    const rect = boardSvg.querySelector('.square');
    if (rect) {
      const w = parseFloat(rect.getAttribute('width'));
      if (!isNaN(w) && w > 0) return w;
    }
    return 40; // Fallback for cm-chessboard v8 default viewBox
  }

  _getHighlightsContainer() {
    const boardEl = document.getElementById(this._elementId);
    if (!boardEl) return null;
    const boardSvg = boardEl.querySelector('svg');
    if (!boardSvg) return null;

    let highlightsGroup = boardSvg.querySelector('#board-highlights-container');
    if (!highlightsGroup) {
      highlightsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      highlightsGroup.setAttribute('id', 'board-highlights-container');
      highlightsGroup.setAttribute('class', 'pointer-events-none');
      
      const piecesGroup = boardSvg.querySelector('.pieces-layer') || boardSvg.querySelector('.pieces') || boardSvg.querySelector('g.pieces');
      if (piecesGroup && piecesGroup.parentNode) {
        piecesGroup.parentNode.insertBefore(highlightsGroup, piecesGroup);
      } else {
        boardSvg.appendChild(highlightsGroup);
      }
    }
    return highlightsGroup;
  }

  _getArrowsContainer() {
    const boardEl = document.getElementById(this._elementId);
    if (!boardEl) return null;
    const boardSvg = boardEl.querySelector('svg');
    if (!boardSvg) return null;

    let arrowsGroup = boardSvg.querySelector('#board-user-arrows-container');
    if (!arrowsGroup) {
      arrowsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      arrowsGroup.setAttribute('id', 'board-user-arrows-container');
      arrowsGroup.setAttribute('class', 'pointer-events-none');
      boardSvg.appendChild(arrowsGroup);
    }
    return arrowsGroup;
  }

  renderUserDrawings() {
    const isBlack = this._orientation === 'black' || this._orientation === COLOR.black;

    // 1. Draw Highlights (under pieces)
    const highlightsGroup = this._getHighlightsContainer();
    if (highlightsGroup) {
      highlightsGroup.innerHTML = '';
      const boardEl = document.getElementById(this._elementId);
      const boardSvg = boardEl ? boardEl.querySelector('svg') : null;
      const sqSize = boardSvg ? this._getSquareSize(boardSvg) : 40;

      for (const sq of this._userHighlights) {
        const coords = this._squareToColRow(sq, isBlack);
        if (!coords) continue;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', coords.col * sqSize);
        rect.setAttribute('y', coords.row * sqSize);
        rect.setAttribute('width', sqSize);
        rect.setAttribute('height', sqSize);
        rect.setAttribute('class', 'right-click-highlight');
        highlightsGroup.appendChild(rect);
      }
    }

    // 2. Draw Arrows (on top of pieces, inside the native board SVG)
    const boardEl2 = document.getElementById(this._elementId);
    const boardSvg2 = boardEl2 ? boardEl2.querySelector('svg') : null;
    const sqSize2 = boardSvg2 ? this._getSquareSize(boardSvg2) : 40;
    const arrowsGroup = this._getArrowsContainer();
    if (arrowsGroup) {
      arrowsGroup.innerHTML = '';

      for (const arrowStr of this._userArrows) {
        const from = arrowStr.slice(0, 2);
        const to = arrowStr.slice(2, 4);
        const arrowEl = this._createArrowSvgElement(from, to, isBlack, false, sqSize2);
        if (arrowEl) arrowsGroup.appendChild(arrowEl);
      }

      // Draw Preview Arrow
      if (this._previewArrow) {
        const { from, to } = this._previewArrow;
        const previewEl = this._createArrowSvgElement(from, to, isBlack, true, sqSize2);
        if (previewEl) arrowsGroup.appendChild(previewEl);
      }
    }
  }

  _createArrowSvgElement(from, to, isBlack, isPreview = false, sqSize = 40) {
    const fromCoords = this._squareToColRow(from, isBlack);
    const toCoords = this._squareToColRow(to, isBlack);
    if (!fromCoords || !toCoords) return null;

    const half = sqSize / 2;
    const x1 = fromCoords.col * sqSize + half;
    const y1 = fromCoords.row * sqSize + half;
    const x2 = toCoords.col * sqSize + half;
    const y2 = toCoords.row * sqSize + half;

    const colDist = Math.abs(toCoords.col - fromCoords.col);
    const rowDist = Math.abs(toCoords.row - fromCoords.row);
    const isKnightMove = (colDist === 2 && rowDist === 1) || (colDist === 1 && rowDist === 2);

    // Use the EXACT same class structure as cm-chessboard's Arrows extension
    // so we inherit identical dimensions (headSize=7, stroke-width from CSS)
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'user-arrow');
    if (isPreview) {
      g.setAttribute('opacity', '0.6');
    }

    // The headSize matches cm-chessboard default (7 SVG units in viewBox space)
    const headSize = 7;
    // offsetTo matches the cm-chessboard default (0.55 = proportion of a square)
    const offsetTo = sqSize * 0.55;

    if (isKnightMove) {
      // L-shaped path for knight moves
      let xCorner, yCorner;
      if (colDist === 2) {
        xCorner = x2;
        yCorner = y1;
      } else {
        xCorner = x1;
        yCorner = y2;
      }

      // Direction of the final segment (corner -> target)
      const dx2 = x2 - xCorner;
      const dy2 = y2 - yCorner;
      const L2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      const u2_x = dx2 / L2;
      const u2_y = dy2 / L2;

      // Shorten the endpoint by offsetTo for the arrowhead
      const lineEndX = x2 - u2_x * offsetTo;
      const lineEndY = y2 - u2_y * offsetTo;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} L ${xCorner} ${yCorner} L ${lineEndX} ${lineEndY}`);
      path.setAttribute('class', 'arrow-line');
      g.appendChild(path);

      // Arrowhead: <use> referencing the same sprite as the engine arrows
      const angle = Math.atan2(dy2, dx2) * (180 / Math.PI);
      const headX = x2 - u2_x * offsetTo;
      const headY = y2 - u2_y * offsetTo;
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `assets/extensions/arrows/arrows.svg#arrowDefault`);
      use.setAttribute('x', headX - headSize / 2);
      use.setAttribute('y', headY - headSize / 2);
      use.setAttribute('width', headSize);
      use.setAttribute('height', headSize);
      use.setAttribute('transform', `rotate(${angle}, ${headX}, ${headY})`);
      use.setAttribute('class', 'arrow-head');
      g.appendChild(use);
    } else {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const L = Math.sqrt(dx * dx + dy * dy);
      if (L === 0) return null;

      const u_x = dx / L;
      const u_y = dy / L;

      // Shorten the endpoint by offsetTo for the arrowhead
      const lineEndX = x2 - u_x * offsetTo;
      const lineEndY = y2 - u_y * offsetTo;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', lineEndX);
      line.setAttribute('y2', lineEndY);
      line.setAttribute('class', 'arrow-line');
      g.appendChild(line);

      // Arrowhead: <use> referencing the same sprite as the engine arrows
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      const headX = x2 - u_x * offsetTo;
      const headY = y2 - u_y * offsetTo;
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `assets/extensions/arrows/arrows.svg#arrowDefault`);
      use.setAttribute('x', headX - headSize / 2);
      use.setAttribute('y', headY - headSize / 2);
      use.setAttribute('width', headSize);
      use.setAttribute('height', headSize);
      use.setAttribute('transform', `rotate(${angle}, ${headX}, ${headY})`);
      use.setAttribute('class', 'arrow-head');
      g.appendChild(use);
    }

    return g;
  }
}