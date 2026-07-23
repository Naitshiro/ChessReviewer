/**
 * analysis.js — UI rendering for ChessReviewer
 *
 * Handles:
 *  - Evaluation bar (win probability → height %)
 *  - Win probability Chart.js graph
 *  - Move list rendering with classification badges
 *  - Accuracy scorecard rendering
 */

// Chart.js is loaded globally via <script> CDN in index.html
/* global Chart */

// ── Classification metadata ─────────────────────────────────────────────

export const CLASS_META = {
  brilliant: { symbol: '!!', label: 'Brilliant', css: 'badge-brilliant', svg: 'brilliant.svg' },
  great: { symbol: '!', label: 'Great', css: 'badge-great', svg: 'great.svg' },
  best: { symbol: '★', label: 'Best', css: 'badge-best', svg: 'best.svg' },
  excellent: { symbol: '✦', label: 'Excellent', css: 'badge-excellent', svg: 'excellent.svg' },
  good: { symbol: '✓', label: 'Good', css: 'badge-good', svg: 'good.svg' },
  inaccuracy: { symbol: '?!', label: 'Inaccuracy', css: 'badge-inaccuracy', svg: 'inaccuracy.svg' },
  mistake: { symbol: '?', label: 'Mistake', css: 'badge-mistake', svg: 'mistake.svg' },
  blunder: { symbol: '??', label: 'Blunder', css: 'badge-blunder', svg: 'blunder.svg' },
  theory: { symbol: '⌕', label: 'Theory', css: 'badge-theory', svg: 'theory.svg' },
};

// Classification display order for the scorecard
const SCORE_ORDER = [
  'brilliant', 'great', 'best', 'excellent', 'good', 'theory',
  'inaccuracy', 'mistake', 'blunder',
];

export const COMPREHENSIVE_NAG_MAP = {
  1: { symbol: "!", label: "Good Move", classKey: "good", svg: "annotation_good.svg" },
  2: { symbol: "?", label: "Mistake", classKey: "mistake", svg: "annotation_mistake.svg" },
  3: { symbol: "!!", label: "Brilliant Move", classKey: "brilliant", svg: "annotation_brilliant.svg" },
  4: { symbol: "??", label: "Blunder", classKey: "blunder", svg: "annotation_blunder.svg" },
  5: { symbol: "!?", label: "Interesting", classKey: "excellent", svg: "annotation_interesting.svg" },
  6: { symbol: "?!", label: "Dubious Move", classKey: "inaccuracy", svg: "annotation_dubious.svg" },
  7: { symbol: "□", label: "Forced", classKey: "best", svg: "annotation_forced.svg" },
  10: { symbol: "=", label: "Balanced", classKey: "theory", svg: "annotation_balanced.svg" },
  11: { symbol: "=", label: "Balanced", classKey: "theory", svg: "annotation_balanced.svg" },
  12: { symbol: "=", label: "Balanced", classKey: "theory", svg: "annotation_balanced.svg" },
  13: { symbol: "∞", label: "Unclear", classKey: "theory", svg: "annotation_unclear.svg" },
  14: { symbol: "⩲", label: "Slight advantage", classKey: "theory", svg: "annotation_white_slight_advantage.svg" },
  15: { symbol: "⩱", label: "Slight advantage", classKey: "theory", svg: "annotation_black_slight_advantage.svg" },
  16: { symbol: "±", label: "Moderate advantage", classKey: "theory", svg: "annotation_white_moderate_advantage.svg" },
  17: { symbol: "∓", label: "Moderate advantage", classKey: "theory", svg: "annotation_black_moderate_advantage.svg" },
  18: { symbol: "+-", label: "Decisive advantage", classKey: "theory", svg: "annotation_white_decisive_advantage.svg" },
  20: { symbol: "+-", label: "Decisive advantage", classKey: "theory", svg: "annotation_white_decisive_advantage.svg" },
  19: { symbol: "-+", label: "Decisive advantage", classKey: "theory", svg: "annotation_black_decisive_advantage.svg" },
  21: { symbol: "-+", label: "Decisive advantage", classKey: "theory", svg: "annotation_black_decisive_advantage.svg" },
  22: { symbol: "⨀", label: "Zugzwang", classKey: "theory", svg: "annotation_zugzwang.svg" },
  23: { symbol: "⨀", label: "Zugzwang", classKey: "theory", svg: "annotation_zugzwang.svg" },
  26: { symbol: "○", label: "Space", classKey: "theory", svg: "annotation_space.svg" },
  27: { symbol: "○", label: "Space", classKey: "theory", svg: "annotation_space.svg" },
  32: { symbol: "⟳", label: "Development", classKey: "theory", svg: "annotation_development.svg" },
  33: { symbol: "⟳", label: "Development", classKey: "theory", svg: "annotation_development.svg" },
  36: { symbol: "↑", label: "Initiative", svg: "annotation_initiative.svg" },
  37: { symbol: "↑", label: "Initiative", svg: "annotation_initiative.svg" },
  40: { symbol: "→", label: "Attack", svg: "annotation_attack.svg" },
  41: { symbol: "→", label: "Attack", svg: "annotation_attack.svg" },
  44: { symbol: "⯹", label: "Compensation", svg: "annotation_compensation.svg" },
  45: { symbol: "⯹", label: "Compensation", svg: "annotation_compensation.svg" },
  130: { symbol: "⇆", label: "Counterplay", svg: "annotation_counterplay.svg" },
  131: { symbol: "⇆", label: "Counterplay", svg: "annotation_counterplay.svg" },
  136: { symbol: "⨁", label: "Time trouble", svg: "annotation_time_trouble.svg" },
  137: { symbol: "⨁", label: "Time trouble", svg: "annotation_time_trouble.svg" },
  146: { symbol: "N", label: "Novelty", svg: "annotation_novelty.svg" }
};

export function getMateMoves(scoreMate, color) {
  if (scoreMate === null || scoreMate === undefined) return null;
  return color === 'white' ? scoreMate : -scoreMate;
}

// ── Evaluation Bar ──────────────────────────────────────────────────────

const evalBarWhite = document.getElementById('eval-bar-white');
const evalBarLabel = document.getElementById('eval-bar-label');

/**
 * Update the evaluation bar.
 * @param {number} whiteCp - Centipawns from White's perspective (positive = White winning)
 * @param {number|null} mateMoves - Mate-in-N (positive = White mating, negative = Black mating)
 */
export function renderEvalBar(whiteCp, mateMoves = null, gameOver = false, winner = null, orientation = 'white', whiteWinProb = null) {
  if (!evalBarWhite) return;

  const container = document.getElementById('eval-bar-container');
  if (container) {
    if (orientation === 'black') {
      container.classList.add('flipped');
    } else {
      container.classList.remove('flipped');
    }
  }

  let heightPct;
  let labelText;

  let isWhiteWinner = null;
  if (winner === 'white') {
    isWhiteWinner = true;
  } else if (winner === 'black') {
    isWhiteWinner = false;
  } else if (gameOver) {
    isWhiteWinner = null;
  } else if (mateMoves === 0) {
    if (whiteWinProb !== null) {
      isWhiteWinner = whiteWinProb > 0.5;
    } else if (whiteCp !== null && whiteCp !== 0) {
      isWhiteWinner = whiteCp > 0;
    }
  }

  if (gameOver || mateMoves === 0) {
    if (isWhiteWinner === true) {
      heightPct = 100;
      labelText = '1-0';
    } else if (isWhiteWinner === false) {
      heightPct = 0;
      labelText = '0-1';
    } else {
      heightPct = 50;
      labelText = '½-½';
    }
  } else if (mateMoves !== null) {
    heightPct = mateMoves > 0 ? 100 : 0;
    labelText = mateMoves > 0 ? `M${mateMoves}` : `M${-mateMoves}`;
  } else {
    // Visually map centipawn evaluation to a smooth curve (similar to chess.com/lichess)
    const clampedCp = Math.max(-2000, Math.min(2000, whiteCp || 0));
    const prob = 1 / (1 + Math.exp(-0.0025 * clampedCp));
    // Map 0–1 to 2–98% (leave a small gutter at extremes)
    heightPct = 2 + prob * 96;

    const val = Math.abs((whiteCp || 0) / 100);
    const formatted = val.toFixed(1);
    if (parseFloat(formatted) < 10) {
      labelText = formatted;
    } else {
      labelText = Math.round(val).toString();
    }
  }

  evalBarWhite.style.height = `${heightPct}%`;
  evalBarWhite.style.setProperty('--eval-width', `${heightPct}%`);

  if (evalBarLabel) {
    evalBarLabel.textContent = labelText;

    // Position label dynamically (like chess.com: text on the winning side)
    if (heightPct >= 50) {
      // White is winning or equal -> label at bottom, dark text on white background
      evalBarLabel.style.top = 'auto';
      evalBarLabel.style.bottom = '8px';
      evalBarLabel.style.color = '#21201d';
    } else {
      // Black is winning -> label at top, light text on black background
      evalBarLabel.style.bottom = 'auto';
      evalBarLabel.style.top = '8px';
      evalBarLabel.style.color = '#ffffff';
    }
  }
}

// ── Win Probability Graph ───────────────────────────────────────────────

let evalChart = null;
let wdlChart = null;
let chartClickCallback = null;

export function registerChartClickCallback(callback) {
  chartClickCallback = callback;
}

function formatEval(move) {
  if (move.score_mate !== null && move.score_mate !== undefined) {
    if (move.score_mate === 0) {
      return (move.color === 'white' || move.color === 'w') ? '1-0' : '0-1';
    }
    const isWhiteMate = move.score_mate > 0;
    return isWhiteMate ? `+M${Math.abs(move.score_mate)}` : `-M${Math.abs(move.score_mate)}`;
  }
  if (move.white_cp !== null && move.white_cp !== undefined) {
    const val = move.white_cp / 100.0;
    return val >= 0 ? `+${val.toFixed(2)}` : `${val.toFixed(2)}`;
  }
  return '0.00';
}

export function renderEvalChart(moves, initialEval) {
  const ctx = document.getElementById('eval-chart');
  const wdlCtx = document.getElementById('wdl-chart');
  if (!ctx || !wdlCtx || typeof Chart === 'undefined') return;

  // Helper: convert white_cp (centipawns) or score_mate to log-scaled chart value
  function evalToChartVal(white_cp, score_mate, color = 'white') {
    let evalPawns = 0.0;
    if (score_mate !== null && score_mate !== undefined) {
      if (score_mate === 0) {
        if (white_cp !== null && white_cp !== undefined && white_cp !== 0) {
          evalPawns = white_cp > 0 ? 20.0 : -20.0;
        } else {
          evalPawns = color === 'white' ? 20.0 : -20.0;
        }
      } else {
        evalPawns = score_mate > 0 ? 20.0 : -20.0;
      }
    } else if (white_cp !== null && white_cp !== undefined) {
      evalPawns = white_cp / 100.0;
    }
    const sign = Math.sign(evalPawns);
    const absX = Math.abs(evalPawns);
    const val = sign * (5.0 / Math.log(4.0)) * Math.log(3.0 * absX + 1.0);
    return Math.round(Math.max(-10, Math.min(10, val)) * 100) / 100;
  }

  const moveLabels = moves.map((m) => {
    const prefix = m.color === 'white' ? `${m.move_number}.` : `${m.move_number}...`;
    return `${prefix}${m.san}`;
  });

  const moveEvalValues = moves.map(m => evalToChartVal(m.white_cp, m.score_mate, m.color));

  // Prepend the initial position eval as a "Start" anchor point
  let labels, evalValues;
  if (initialEval) {
    labels = ['Start', ...moveLabels];
    evalValues = [evalToChartVal(initialEval.white_cp, initialEval.score_mate, 'white'), ...moveEvalValues];
  } else {
    labels = moveLabels;
    evalValues = moveEvalValues;
  }

  // Map evaluation directly to equivalent pawns, then scale logarithmically to [-10, +10]
  // Such that:
  // 0.0 pawns -> 0.0 Y-axis
  // 1.0 pawn -> 5.0 Y-axis (middle tick)
  // 5.0 pawns -> 10.0 Y-axis (top tick)

  // Helper: estimate WDL probabilities from cp/mate for starting position
  function getInitialWdl(initEval) {
    if (!initEval) {
      return { whiteWin: 33, blackWin: 33, draw: 34 };
    }
    if (initEval.score_mate !== null && initEval.score_mate !== undefined) {
      return initEval.score_mate > 0 
        ? { whiteWin: 100, blackWin: 0, draw: 0 }
        : { whiteWin: 0, blackWin: 100, draw: 0 };
    }
    const cp = initEval.white_cp || 0;
    const wp = 1.0 / (1.0 + Math.pow(10, -cp / 400.0));
    const d = 0.65 * Math.exp(-Math.pow(cp / 300.0, 2));
    let w = wp - 0.5 * d;
    let l = 1.0 - wp - 0.5 * d;
    w = Math.max(0.0, Math.min(1.0, w));
    l = Math.max(0.0, Math.min(1.0, l));
    const d_clamped = Math.max(0.0, Math.min(1.0, 1.0 - w - l));
    return {
      whiteWin: Math.round(w * 100),
      blackWin: Math.round(l * 100),
      draw: Math.round(d_clamped * 100)
    };
  }

  const whiteWinValues = moves.map(m => Math.round((m.white_win || 0) * 100));
  const blackWinValues = moves.map(m => Math.round((m.black_win || 0) * 100));
  const drawValues = moves.map(m => Math.round((m.draw_prob || 0) * 100));

  let wdlLabels, wdlWhiteWin, wdlBlackWin, wdlDraw;
  if (initialEval) {
    const initWdl = getInitialWdl(initialEval);
    wdlLabels = ['Start', ...moveLabels];
    wdlWhiteWin = [initWdl.whiteWin, ...whiteWinValues];
    wdlBlackWin = [initWdl.blackWin, ...blackWinValues];
    wdlDraw = [initWdl.draw, ...drawValues];
  } else {
    wdlLabels = moveLabels;
    wdlWhiteWin = whiteWinValues;
    wdlBlackWin = blackWinValues;
    wdlDraw = drawValues;
  }

  // --- 1. Position Evaluation Chart ---
  if (evalChart) {
    evalChart.moves = moves;
    evalChart.initialEval = initialEval;
    evalChart.data.labels = labels;
    evalChart.data.datasets[0].data = evalValues;
    evalChart.update('none');
  } else {
    evalChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: evalValues,
          borderColor: '#ffffff',
          borderWidth: 2,
          backgroundColor: 'rgba(255, 255, 255, 0.85)',
          fill: 'origin',
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: '#ffffff',
        }],
      },
      plugins: [{
        id: 'pointBadges',
        afterDatasetsDraw: (chart) => {
          const currentMoves = chart.moves;
          if (!currentMoves) return;
          const { ctx: canvasCtx } = chart;
          const meta = chart.getDatasetMeta(0);
          if (!meta || !meta.data) return;
          const offset = chart.initialEval ? 1 : 0;

          canvasCtx.save();
          meta.data.forEach((point, index) => {
            const move = currentMoves[index - offset];
            if (!move) return;

            const cls = move.classification;
            const x = point.x;
            const y = point.y;

            // Draw tiny dots for all moves
            const bgColor = _classColor(cls);
            canvasCtx.beginPath();
            canvasCtx.arc(x, y, 2.5, 0, 2 * Math.PI);
            canvasCtx.fillStyle = bgColor;
            canvasCtx.fill();
          });
          canvasCtx.restore();
        }
      }],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: { mode: 'index', intersect: false },
        onClick: (event, activeElements, chart) => {
          if (activeElements && activeElements.length > 0) {
            const chartIdx = activeElements[0].index;
            const offset = chart.initialEval ? 1 : 0;
            const moveIdx = chartIdx - offset;
            if (chartClickCallback && moveIdx >= 0) {
              chartClickCallback(moveIdx);
            }
          }
        },
        onHover: (event, activeElements, chart) => {
          chart.canvas.style.cursor = (activeElements && activeElements.length > 0) ? 'pointer' : 'default';
        },
        scales: {
          x: {
            display: false,
          },
          y: {
            min: -10,
            max: 10,
            display: true,
            ticks: {
              color: '#bab9b7',
              font: { size: 9, family: 'var(--font-mono)', weight: '500' },
              stepSize: 5,
              maxTicksLimit: 5,
              callback: v => {
                const rounded = Math.round(v);
                if (rounded === 10) return '+5.0';
                if (rounded === 5) return '+1.0';
                if (rounded === 0) return ' 0.0';
                if (rounded === -5) return '-1.0';
                if (rounded === -10) return '-5.0';
                return '';
              },
            },
            grid: {
              color: (context) => {
                if (context.tick.value === 0) {
                  return 'rgba(255, 255, 255, 0.4)';
                }
                return 'rgba(255, 255, 255, 0.04)';
              },
              lineWidth: (context) => {
                if (context.tick.value === 0) {
                  return 1.5;
                }
                return 1;
              }
            },
            border: { display: false },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            backgroundColor: 'rgba(30, 29, 27, 0.95)',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            titleColor: '#bab9b7',
            bodyColor: '#ffffff',
            padding: 8,
            callbacks: {
              title: items => items[0]?.label || '',
              label: item => {
                const offset = evalChart?.initialEval ? 1 : 0;
                if (offset === 1 && item.dataIndex === 0) {
                  const initEval = evalChart.initialEval;
                  return `Eval: ${formatEval(initEval)}`;
                }
                const move = moves[item.dataIndex - offset];
                if (!move) return '';
                return `Eval: ${formatEval(move)}`;
              },
            },
          },
        },
      },
    });
    evalChart.moves = moves;
    evalChart.initialEval = initialEval;
  }

  // --- 2. Win Probability (WDL) Chart ---
  if (wdlChart) {
    wdlChart.moves = moves;
    wdlChart.initialEval = initialEval;
    wdlChart.data.labels = wdlLabels;
    wdlChart.data.datasets[0].data = wdlWhiteWin;
    wdlChart.data.datasets[1].data = wdlBlackWin;
    wdlChart.data.datasets[2].data = wdlDraw;
    wdlChart.update('none');
  } else {
    wdlChart = new Chart(wdlCtx, {
      type: 'line',
      data: {
        labels: wdlLabels,
        datasets: [
          {
            label: 'White Win',
            data: wdlWhiteWin,
            borderColor: '#ffffff',
            borderWidth: 1.75,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
            fill: false,
          },
          {
            label: 'Black Win',
            data: wdlBlackWin,
            borderColor: '#111111',
            borderWidth: 1.75,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
            fill: false,
          },
          {
            label: 'Draw',
            data: wdlDraw,
            borderColor: '#8b8987',
            borderWidth: 1.75,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
            fill: false,
          }
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: { mode: 'index', intersect: false },
        onClick: (event, activeElements, chart) => {
          if (activeElements && activeElements.length > 0) {
            const chartIdx = activeElements[0].index;
            const offset = chart.initialEval ? 1 : 0;
            const moveIdx = chartIdx - offset;
            if (chartClickCallback && moveIdx >= 0) {
              chartClickCallback(moveIdx);
            }
          }
        },
        onHover: (event, activeElements, chart) => {
          chart.canvas.style.cursor = (activeElements && activeElements.length > 0) ? 'pointer' : 'default';
        },
        scales: {
          x: { display: false },
          y: {
            min: 0,
            max: 100,
            display: true,
            ticks: {
              color: '#bab9b7',
              font: { size: 9, family: 'var(--font-sans)', weight: '500' },
              maxTicksLimit: 5,
              callback: v => `${v}%`,
            },
            grid: {
              color: 'rgba(255, 255, 255, 0.04)',
            },
            border: { display: false },
          },
        },
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#bab9b7',
              boxWidth: 8,
              boxHeight: 8,
              padding: 10,
              font: { size: 9, family: 'var(--font-sans)' }
            }
          },
          tooltip: {
            backgroundColor: 'rgba(30, 29, 27, 0.95)',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            titleColor: '#bab9b7',
            bodyColor: '#ffffff',
            padding: 8,
            callbacks: {
              title: items => items[0]?.label || '',
              label: item => {
                return `${item.dataset.label}: ${item.raw}%`;
              },
            },
          },
        },
      },
    });
    wdlChart.moves = moves;
    wdlChart.initialEval = initialEval;
  }
}

/**
 * Highlight a specific move index in the chart.
 * @param {number} moveIndex
 */
export function highlightChartMove(moveIndex) {
  // When the chart has an initial eval "Start" point prepended, offset move indices by 1
  const chartOffset = (evalChart && evalChart.initialEval) ? 1 : 0;
  const chartIndex = moveIndex < 0 ? -1 : moveIndex + chartOffset;

  if (evalChart) {
    evalChart.data.datasets[0].pointRadius = evalChart.data.labels.map(
      (_, i) => i === chartIndex ? 5 : 0
    );
    evalChart.update('none');
  }
  if (wdlChart) {
    // WDL chart doesn't have the Start offset (it only has move data)
    wdlChart.data.datasets.forEach(dataset => {
      dataset.pointRadius = wdlChart.data.labels.map(
        (_, i) => i === moveIndex ? 4 : 0
      );
    });
    wdlChart.update('none');
  }
}

// ── Move List ───────────────────────────────────────────────────────────

/**
 * Render the interactive move list.
 * @param {Array} moves - Processed move records from backend
 * @param {Function} onMoveClick - callback(type, index)
 * @param {Array} branchMoves - Array of branch moves
 * @param {number} forkIndex - Index in main moves where branch started
 */
export function renderMoveList(moves, onMoveClick, branchMoves = [], forkIndex = null, overlayPriority = 'classification', liveReviewEnabled = false, result = null) {
  const container = document.getElementById('move-list');
  if (!container) return;

  const rows = [];
  const rowElements = [];
  let currentRow = null;
  let lastMoveNum = -1;

  // 1. Render main line
  const mainLen = moves.length;
  for (let i = 0; i < mainLen; i++) {
    const m = moves[i];
    _appendMoveToRows(rows, m, 'main', i, onMoveClick, () => {
      currentRow = document.createElement('div');
      currentRow.className = 'move-row';
      const numEl = document.createElement('span');
      numEl.className = 'move-num';
      numEl.textContent = `${m.move_number}.`;
      currentRow.appendChild(numEl);
      currentRow.appendChild(_createEmptyCell(`move-cell-w-${m.move_number}`));
      currentRow.appendChild(_createEmptyCell(`move-cell-b-${m.move_number}`));

      const timeContainer = document.createElement('div');
      timeContainer.className = 'move-time-container';
      timeContainer.id = `move-time-container-${m.move_number}`;
      currentRow.appendChild(timeContainer);

      return currentRow;
    }, (row) => currentRow = row, lastMoveNum, overlayPriority, liveReviewEnabled);
    lastMoveNum = m.move_number;
    rowElements[i] = currentRow;
  }

  container.innerHTML = '';
  rows.forEach(r => container.appendChild(r));

  // 2. Render branch moves inline
  if (branchMoves && branchMoves.length > 0 && forkIndex !== null) {
    const branchContainer = document.createElement('div');
    branchContainer.className = 'branch-container my-1 py-1 rounded';
    branchContainer.style.background = 'rgba(60, 58, 55, 0.5)';
    const branchRows = [];
    let bCurrentRow = null;
    let bLastMoveNum = -1;

    for (let i = 0; i < branchMoves.length; i++) {
      const m = branchMoves[i];
      _appendMoveToRows(branchRows, m, 'branch', i, onMoveClick, () => {
        bCurrentRow = document.createElement('div');
        bCurrentRow.className = 'move-row';
        const numEl = document.createElement('span');
        numEl.className = 'move-num text-[var(--text-secondary)] relative';

        if (i === 0) {
          const lIcon = document.createElement('span');
          lIcon.textContent = '↳ ';
          lIcon.className = 'absolute -left-3 top-0 opacity-50';
          numEl.appendChild(lIcon);
        }
        numEl.appendChild(document.createTextNode(`${m.move_number}.`));

        bCurrentRow.appendChild(numEl);
        bCurrentRow.appendChild(_createEmptyCell(`b-move-cell-w-${m.move_number}`));
        bCurrentRow.appendChild(_createEmptyCell(`b-move-cell-b-${m.move_number}`));

        const timeContainer = document.createElement('div');
        timeContainer.className = 'move-time-container';
        timeContainer.id = `b-move-time-container-${m.move_number}`;
        bCurrentRow.appendChild(timeContainer);

        return bCurrentRow;
      }, (row) => bCurrentRow = row, bLastMoveNum, overlayPriority, liveReviewEnabled);
      bLastMoveNum = m.move_number;
    }

    branchRows.forEach(r => branchContainer.appendChild(r));

    const targetRow = rowElements[forkIndex];
    if (targetRow) {
      targetRow.after(branchContainer);
    } else {
      container.prepend(branchContainer);
    }
  }

  // 3. Render game result at the bottom
  if (result && result !== '*') {
    const resultRow = document.createElement('div');
    resultRow.className = 'move-list-result-row';
    resultRow.innerHTML = `
      <span class="result-text">${result}</span>
      <span class="result-info-icon" title="Game Over">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
        </svg>
      </span>
    `;
    container.appendChild(resultRow);
  }
}

function _createEmptyCell(id) {
  const el = document.createElement('div');
  el.id = id;
  return el;
}

function formatSanWithPieceIcon(san, isWhite) {
  const pieceChar = san[0];
  if (['N', 'B', 'R', 'Q', 'K'].includes(pieceChar)) {
    const pieceMap = { 'N': 'n', 'B': 'b', 'R': 'r', 'Q': 'q', 'K': 'k' };
    const colorCode = isWhite ? 'w' : 'b';
    const pieceId = `${colorCode}${pieceMap[pieceChar]}`;
    const rest = san.slice(1);
    return `<span style="display:inline-flex; align-items:center; vertical-align:middle;"><svg style="width:16px; height:16px; margin-bottom: 2px;" viewBox="0 0 40 40"><use href="#${pieceId}"></use></svg>${rest}</span>`;
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
      return `<span style="display:inline-flex; align-items:center; vertical-align:middle;">${prefix}<svg style="width:16px; height:16px; margin-bottom: 2px; margin-left: 1px; margin-right: 1px;" viewBox="0 0 40 40"><use href="#${pieceId}"></use></svg>${rest}</span>`;
    }
  }
  return san;
}

function _appendMoveToRows(rowsArray, m, type, index, onClick, createRowFn, setRowFn, lastMoveNum, overlayPriority = 'classification', liveReviewEnabled = false) {
  if (m.color === 'white' || m.move_number !== lastMoveNum) {
    rowsArray.push(createRowFn());
  }

  const currentRow = rowsArray[rowsArray.length - 1];

  let badgeToRender = null;
  let annotationObj = null;
  if (m.nags && m.nags.length > 0) {
    for (const code of m.nags) {
      if (COMPREHENSIVE_NAG_MAP[code]) {
        annotationObj = COMPREHENSIVE_NAG_MAP[code];
        break;
      }
    }
  }

  const meta = m.classification ? CLASS_META[m.classification] : null;

  if (overlayPriority === 'annotation') {
    if (annotationObj) {
      badgeToRender = {
        symbol: annotationObj.symbol,
        svg: annotationObj.svg,
        label: annotationObj.label
      };
    } else if (meta) {
      badgeToRender = {
        symbol: meta.symbol,
        svg: meta.svg,
        label: meta.label
      };
    }
  } else { // 'classification'
    if (meta) {
      badgeToRender = {
        symbol: meta.symbol,
        svg: meta.svg,
        label: meta.label
      };
    } else if (annotationObj) {
      badgeToRender = {
        symbol: annotationObj.symbol,
        svg: annotationObj.svg,
        label: annotationObj.label
      };
    }
  }

  const cell = document.createElement('div');
  cell.className = `move-item ${m.color}-move`;
  cell.dataset.type = type;
  cell.dataset.index = index;
  cell.id = `${type}-move-item-${index}`;

  if (badgeToRender) {
    const badge = document.createElement('img');
    badge.className = 'move-badge';
    badge.src = `assets/markers/${badgeToRender.svg}`;
    badge.title = badgeToRender.label;
    badge.alt = badgeToRender.symbol;
    if (badgeToRender.svg && badgeToRender.svg.startsWith('annotation_') && m.color === 'white') {
      badge.style.filter = 'invert(1)';
    }
    cell.appendChild(badge);
  } else if (liveReviewEnabled && (m.classification === null || m.classification === undefined)) {
    // Unclassified yet (waiting for engine)
    const spinner = document.createElement('span');
    spinner.className = 'w-2 h-2 rounded-full bg-[#81b64c]/50 animate-pulse mr-1 inline-block';
    cell.appendChild(spinner);
  }

  const text = document.createElement('span');
  text.innerHTML = formatSanWithPieceIcon(m.san, m.color === 'white');
  cell.appendChild(text);
  cell.addEventListener('click', () => onClick(type, index));

  const cellId = type === 'main'
    ? (m.color === 'white' ? `move-cell-w-${m.move_number}` : `move-cell-b-${m.move_number}`)
    : (m.color === 'white' ? `b-move-cell-w-${m.move_number}` : `b-move-cell-b-${m.move_number}`);

  const targetCell = currentRow.querySelector(`#${cellId}`) || currentRow.lastElementChild;
  targetCell.replaceWith(cell);

  // Update timespent display
  const timeContainerId = type === 'main'
    ? `move-time-container-${m.move_number}`
    : `b-move-time-container-${m.move_number}`;
  let timeContainer = currentRow.querySelector(`#${timeContainerId}`);
  if (!timeContainer) {
    timeContainer = document.createElement('div');
    timeContainer.className = 'move-time-container';
    timeContainer.id = timeContainerId;
    currentRow.appendChild(timeContainer);
  }

  const colorTimeClass = `move-time-${m.color}`;
  let timeItem = timeContainer.querySelector(`.${colorTimeClass}`);
  if (!timeItem) {
    timeItem = document.createElement('div');
    timeItem.className = `move-time-item ${colorTimeClass}`;
    timeContainer.appendChild(timeItem);
  }

  if (m.move_time) {
    const barColor = m.color === 'white' ? '#bab9b7' : '#5b5956';
    timeItem.innerHTML = `
      <span class="move-time-bar" style="background-color: ${barColor};"></span>
      <span class="move-time-text">${m.move_time}</span>
    `;
    timeItem.style.display = 'flex';
  } else {
    timeItem.style.display = 'none';
  }
}


/**
 * Highlight the active move in the move list.
 * @param {string} type - 'main' or 'branch'
 * @param {number|null} moveIndex
 */
export function setActiveMoveInList(type, moveIndex) {
  // Remove previous active
  document.querySelectorAll('.move-item.active').forEach(el => el.classList.remove('active'));

  if (moveIndex === null || moveIndex < 0) return;

  const el = document.getElementById(`${type}-move-item-${moveIndex}`);
  if (el) {
    el.classList.add('active');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// ── Accuracy Scorecard ──────────────────────────────────────────────────

/**
 * Render the accuracy ring + classification counts for both sides.
 * @param {object} accuracy - { white: { accuracy, counts }, black: { accuracy, counts } }
 */
export function renderScorecard(accuracy, depthUsed = null) {
  const accuracyRow = document.getElementById('accuracy-row');
  const ratingRow = document.getElementById('rating-row');
  const phasesContainer = document.getElementById('game-phases-container');

  if (depthUsed === 0) {
    if (accuracyRow) accuracyRow.classList.add('hidden');
    if (ratingRow) ratingRow.classList.add('hidden');
    if (phasesContainer) phasesContainer.classList.add('hidden');

    const mergedEl = document.getElementById('scorecard-merged');
    if (mergedEl) {
      mergedEl.innerHTML = '<div class="text-[var(--text-muted)] text-xs italic text-center py-2">Analyze a game to see results.</div>';
    }
    return;
  }

  if (accuracyRow) accuracyRow.classList.remove('hidden');

  _renderSideAccuracy('white', accuracy.white);
  _renderSideAccuracy('black', accuracy.black);

  // Render merged scorecard
  const mergedEl = document.getElementById('scorecard-merged');
  if (mergedEl) {
    mergedEl.innerHTML = SCORE_ORDER.map(cls => {
      const wCount = accuracy.white.counts[cls] || 0;
      const bCount = accuracy.black.counts[cls] || 0;
      const meta = CLASS_META[cls];
      return `
        <div class="flex justify-between items-center">
          <span class="flex items-center gap-2">
            <img class="move-badge" src="assets/markers/${meta.svg}" title="${meta.label}" alt="${meta.symbol}" />
            ${meta.label}
          </span>
          <div class="flex justify-between items-center w-[56px] mr-1 text-[13px] font-bold">
            <span class="w-5 text-center" style="color: ${wCount > 0 ? _classColor(cls) : 'var(--text-muted)'}">${wCount}</span>
            <span class="w-5 text-center" style="color: ${bCount > 0 ? _classColor(cls) : 'var(--text-muted)'}">${bCount}</span>
          </div>
        </div>
      `;
    }).join('');
  }
}

export function renderAnnotationsScorecard(moves) {
  const container = document.getElementById('annotations-container');
  const listEl = document.getElementById('annotations-list');
  if (!container || !listEl) return;

  const counts = {};

  for (const m of moves) {
    if (m.nags && m.nags.length > 0) {
      for (const nagCode of m.nags) {
        const nagObj = COMPREHENSIVE_NAG_MAP[nagCode];
        if (nagObj) {
          const key = `${nagObj.symbol}_${nagObj.label}`;
          if (!counts[key]) counts[key] = { symbol: nagObj.symbol, label: nagObj.label, classKey: nagObj.classKey, svg: nagObj.svg, white: 0, black: 0 };
          counts[key][m.color]++;
        }
      }
    }
  }

  const keys = Object.keys(counts);
  if (keys.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';

  listEl.innerHTML = keys.map(key => {
    const data = counts[key];
    const wCount = data.white;
    const bCount = data.black;
    const nagStr = data.symbol;
    const label = data.label;
    const svgFile = data.svg || 'annotation_balanced.svg';
    return `
      <div class="flex justify-between items-center">
        <span class="flex items-center gap-2">
          <div class="flex gap-1">
            <img class="move-badge" src="assets/markers/${svgFile}" title="${label}" alt="${nagStr}" />
          </div>
          <span class="text-[13px] truncate" title="${label}">${label}</span>
        </span>
        <div class="flex justify-between items-center w-[56px] mr-1 text-[13px] font-bold">
          <span class="w-5 text-center" style="color: ${wCount > 0 ? 'var(--text-primary)' : 'var(--text-muted)'}">${wCount}</span>
          <span class="w-5 text-center" style="color: ${bCount > 0 ? 'var(--text-primary)' : 'var(--text-muted)'}">${bCount}</span>
        </div>
      </div>
    `;
  }).join('');
}

function _renderSideAccuracy(side, data) {
  const pct = data.accuracy;

  // Update Accuracy Box
  const accuracyBox = document.getElementById(`accuracy-${side}-box`);
  if (accuracyBox) {
    accuracyBox.textContent = pct.toFixed(1);
  }

  // Update Estimated Rating Box
  const ratingBox = document.getElementById(`rating-${side}-box`);
  const ratingRow = document.getElementById('rating-row');
  if (ratingBox && data.estimated_rating !== undefined) {
    ratingBox.textContent = data.estimated_rating;
    if (ratingRow) ratingRow.classList.remove('hidden');
  }

  // Game Phases
  if (data.phases) {
    const phasesContainer = document.getElementById('game-phases-container');
    if (phasesContainer) phasesContainer.classList.remove('hidden');

    ['opening', 'middlegame', 'endgame'].forEach(phase => {
      const badgeEl = document.getElementById(`phase-badge-${side}-${phase}`);
      if (badgeEl) {
        const badgeClass = data.phases[phase];
        if (badgeClass && CLASS_META[badgeClass]) {
          const meta = CLASS_META[badgeClass];
          const phaseName = phase.charAt(0).toUpperCase() + phase.slice(1); // Capitalize the first letter
          const accuracyValue = data.phase_accuracies && data.phase_accuracies[phase] !== undefined ? data.phase_accuracies[phase] : 'N/A';
          badgeEl.innerHTML = `<img class="move-badge" src="assets/markers/${meta.svg}" title="${phaseName} accuracy: ${accuracyValue}%" alt="${meta.symbol}" />`;
          badgeEl.style.border = 'none';
          badgeEl.style.background = 'transparent';
          badgeEl.className = 'move-badge';
        } else {
          badgeEl.textContent = "—";
          badgeEl.removeAttribute('style');
          badgeEl.className = `move-badge text-[var(--text-muted)] bg-[var(--bg-card)] border border-[var(--border)]`;
        }
      }
    });
  }
}

function _accuracyColor(pct) {
  if (pct >= 90) return '#98bc49';
  if (pct >= 75) return '#97af8b';
  if (pct >= 60) return '#f7c631';
  if (pct >= 45) return '#e6912c';
  return '#ca3431';
}

function _classColor(cls) {
  const map = {
    brilliant: '#26c2a3', great: '#5c8bb0', best: '#98bc49',
    excellent: '#98bc49', good: '#97af8b', inaccuracy: '#f7c631',
    mistake: '#e6912c', blunder: '#ca3431', theory: '#d4a76a',
  };
  return map[cls] || 'var(--text-primary)';
}

// ── Toast Notifications ─────────────────────────────────────────────────

const toastContainer = document.getElementById('toast-container');

/**
 * Show a temporary toast notification.
 * @param {string} message
 * @param {'success'|'error'|'info'} [type='info']
 * @param {number} [duration=4000]
 */
export function showToast(message, type = 'info', duration = 4000) {
  if (!toastContainer) return;

  // Prevent duplicate popups if an identical toast message is currently visible
  const existingToasts = toastContainer.querySelectorAll('.toast');
  for (const existing of existingToasts) {
    if (existing.dataset.message === message) {
      return;
    }
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.dataset.message = message;
  toast.innerHTML = `
    <span>${type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warning' ? '⚠️' : 'ℹ'}</span>
    <span>${message}</span>
  `;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Eval bar live update (analysis mode) ────────────────────────────────

/**
 * Update the eval bar display text for live streaming mode.
 * @param {string} text
 */
export function setEvalText(text) {
  if (evalBarLabel) evalBarLabel.textContent = text;
}

// Chart Tab switching logic
function _initChartTabs() {
  const chartTabEval = document.getElementById('chart-tab-eval');
  const chartTabWdl = document.getElementById('chart-tab-wdl');
  const evalChartWrapper = document.getElementById('eval-chart-wrapper');
  const wdlChartWrapper = document.getElementById('wdl-chart-wrapper');

  if (chartTabEval && chartTabWdl && evalChartWrapper && wdlChartWrapper) {
    chartTabEval.addEventListener('click', () => {
      chartTabEval.classList.add('active');
      chartTabWdl.classList.remove('active');
      evalChartWrapper.classList.remove('hidden');
      wdlChartWrapper.classList.add('hidden');
      if (evalChart) {
        evalChart.resize();
        evalChart.update();
      }
    });

    chartTabWdl.addEventListener('click', () => {
      chartTabWdl.classList.add('active');
      chartTabEval.classList.remove('active');
      wdlChartWrapper.classList.remove('hidden');
      evalChartWrapper.classList.add('hidden');
      if (wdlChart) {
        wdlChart.resize();
        wdlChart.update();
      }
    });
  }
}

// Initialize immediately
_initChartTabs();
