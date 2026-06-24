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
        moveToMarker: MARKER_TYPE.frame,
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
          const to = event.squareTo;

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

  addOutcomeBadges(outcomeBadges) {
    const formatted = outcomeBadges.map(ob => ({
      square: ob.square,
      text: ob.text,
      type: 'outcome',
      color: 'white'
    }));
    this._activeBadges = (this._activeBadges || []).concat(formatted);
    this._renderActiveBadges();
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
        badge.className = 'board-class-badge';

        if (type === 'classification' || type === 'outcome') {
          badge.src = `assets/markers/${text}.svg`;
          badge.alt = text;
        } else {
          badge.src = `assets/markers/${text.svg}`;
          badge.alt = text.label || text;
          if (color === 'white') {
            badge.style.filter = 'invert(1)';
          }
        }

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