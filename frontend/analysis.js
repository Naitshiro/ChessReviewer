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
  brilliant: { symbol: '!!', label: 'Brilliant', css: 'badge-brilliant' },
  great: { symbol: '!', label: 'Great', css: 'badge-great' },
  best: { symbol: '★', label: 'Best', css: 'badge-best' },
  excellent: { symbol: '✦', label: 'Excellent', css: 'badge-excellent' },
  good: { symbol: '✓', label: 'Good', css: 'badge-good' },
  inaccuracy: { symbol: '?!', label: 'Inaccuracy', css: 'badge-inaccuracy' },
  mistake: { symbol: '?', label: 'Mistake', css: 'badge-mistake' },
  miss: { symbol: '✗', label: 'Miss', css: 'badge-miss' },
  blunder: { symbol: '??', label: 'Blunder', css: 'badge-blunder' },
  book: { symbol: '📖', label: 'Book', css: 'badge-book' },
};

// Classification display order for the scorecard
const SCORE_ORDER = [
  'brilliant', 'great', 'best', 'excellent', 'good',
  'inaccuracy', 'mistake', 'miss', 'blunder', 'book',
];

// ── Move Classification (JS port of backend formulas) ───────────────────

export function winProb(cp) {
  const clamped = Math.max(-3000.0, Math.min(3000.0, parseFloat(cp) || 0));
  return 1.0 / (1.0 + Math.exp(-0.004 * clamped));
}

export function classifyMove(delta, pBest, pSecondBest, pPlayed, sacrificed, isBook, cpBest, cpSecond) {
  if (isBook) return "book";
  if (delta < 0.05 && sacrificed && pPlayed >= 0.45) return "brilliant";
  if (delta < 0.02 && cpBest > 0.0 && cpSecond <= 0.0) return "great";
  if (delta === 0.0) return "best";
  if (delta < 0.02) return "excellent";
  if (delta < 0.05) return "good";
  if (delta < 0.10) return "inaccuracy";
  if (delta < 0.20) return "mistake";
  if (pPlayed >= 0.50 && pBest >= 0.70) return "miss";
  return "blunder";
}

// ── Evaluation Bar ──────────────────────────────────────────────────────

const evalBarWhite = document.getElementById('eval-bar-white');
const evalBarLabel = document.getElementById('eval-bar-label');

/**
 * Update the evaluation bar.
 * @param {number} whiteCp - Centipawns from White's perspective (positive = White winning)
 * @param {number|null} mateMoves - Mate-in-N (positive = White mating, negative = Black mating)
 */
export function renderEvalBar(whiteCp, mateMoves = null, gameOver = false, winner = null) {
  if (!evalBarWhite) return;

  let heightPct;
  let labelText;

  if (gameOver) {
    if (winner === 'white') {
      heightPct = 100;
      labelText = '1 - 0';
    } else if (winner === 'black') {
      heightPct = 0;
      labelText = '0 - 1';
    } else {
      heightPct = 50;
      labelText = '½ - ½';
    }
  } else if (mateMoves !== null) {
    if (mateMoves === 0 && whiteCp > 0) {
      heightPct = 100;
      labelText = '1 - 0';
    } else if (mateMoves === 0 && whiteCp < 0) {
      heightPct = 0;
      labelText = '0 - 1';
    } else {
      heightPct = mateMoves > 0 ? 98 : 2;
      labelText = mateMoves > 0 ? `M${mateMoves}` : `M${-mateMoves}`;
    }
  } else {
    // Win probability from White's perspective
    const clampedCp = Math.max(-3000, Math.min(3000, whiteCp || 0));
    const prob = 1 / (1 + Math.exp(-0.004 * clampedCp));
    // Map 0–1 to 2–98% (leave a small gutter at extremes)
    heightPct = 2 + prob * 96;

    // Use 1 decimal place like chess.com (e.g., 1.5, 0.4)
    const absVal = Math.abs(clampedCp / 100).toFixed(1);
    labelText = absVal;
  }

  evalBarWhite.style.height = `${heightPct}%`;

  if (evalBarLabel) {
    evalBarLabel.textContent = labelText;

    // Position label dynamically (like chess.com: text on the winning side)
    if (heightPct > 50) {
      // White is winning -> label at bottom, dark text on white background
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

/**
 * Render the win probability over time chart using Chart.js.
 * @param {Array<{white_win_prob: number, move_number: number, color: string, san: string}>} moves
 */
export function renderEvalChart(moves) {
  const ctx = document.getElementById('eval-chart');
  if (!ctx || typeof Chart === 'undefined') return;

  const labels = moves.map((m, i) => {
    const prefix = m.color === 'white' ? `${m.move_number}.` : `${m.move_number}...`;
    return `${prefix}${m.san}`;
  });

  const whiteProbs = moves.map(m => Math.round(m.white_win_prob * 100));

  if (evalChart) {
    evalChart.moves = moves; // Store current moves for the draw plugin
    evalChart.data.labels = labels;
    evalChart.data.datasets[0].data = whiteProbs;
    evalChart.update('none');
    return;
  }

  evalChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: whiteProbs,
        borderColor: '#6366f1',
        borderWidth: 1.5,
        backgroundColor: (ctx) => {
          const chart = ctx.chart;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return 'transparent';
          const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, 'rgba(99, 102, 241, 0.3)');
          gradient.addColorStop(0.5, 'rgba(99, 102, 241, 0.05)');
          gradient.addColorStop(1, 'rgba(99, 102, 241, 0)');
          return gradient;
        },
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#6366f1',
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

        canvasCtx.save();
        meta.data.forEach((point, index) => {
          const move = currentMoves[index];
          if (!move) return;

          const cls = move.classification;
          const x = point.x;
          const y = point.y;

          // Draw text badges only for critical move classes to keep it clean
          const isInteresting = ['brilliant', 'great', 'inaccuracy', 'mistake', 'blunder'].includes(cls);

          if (isInteresting) {
            const symbol = CLASS_META[cls]?.symbol || '';
            const bgColor = _classColor(cls);
            const textColor = ['inaccuracy', 'good'].includes(cls) ? '#21201d' : '#ffffff';

            canvasCtx.beginPath();
            canvasCtx.arc(x, y, 7.5, 0, 2 * Math.PI);
            canvasCtx.fillStyle = bgColor;
            canvasCtx.fill();

            canvasCtx.lineWidth = 1.25;
            canvasCtx.strokeStyle = '#111118';
            canvasCtx.stroke();

            canvasCtx.fillStyle = textColor;
            canvasCtx.font = 'bold 8px "Outfit", sans-serif';
            canvasCtx.textAlign = 'center';
            canvasCtx.textBaseline = 'middle';
            canvasCtx.fillText(symbol, x, y + 0.5);
          } else {
            // Draw tiny dots for standard moves
            const bgColor = _classColor(cls);
            canvasCtx.beginPath();
            canvasCtx.arc(x, y, 2.5, 0, 2 * Math.PI);
            canvasCtx.fillStyle = bgColor;
            canvasCtx.fill();
          }
        });
        canvasCtx.restore();
      }
    }],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          display: false,
        },
        y: {
          min: 0,
          max: 100,
          display: true,
          ticks: {
            color: '#475569',
            font: { size: 9 },
            maxTicksLimit: 5,
            callback: v => `${v}%`,
          },
          grid: {
            color: 'rgba(255,255,255,0.04)',
          },
          border: { display: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(22, 22, 31, 0.95)',
          borderColor: 'rgba(99, 102, 241, 0.3)',
          borderWidth: 1,
          titleColor: '#94a3b8',
          bodyColor: '#f1f5f9',
          padding: 8,
          callbacks: {
            title: items => items[0]?.label || '',
            label: item => `White: ${item.raw}%`,
          },
        },
      },
    },
  });
  evalChart.moves = moves;
}

/**
 * Highlight a specific move index in the chart.
 * @param {number} moveIndex
 */
export function highlightChartMove(moveIndex) {
  if (!evalChart) return;
  evalChart.data.datasets[0].pointRadius = evalChart.data.labels.map(
    (_, i) => i === moveIndex ? 5 : 0
  );
  evalChart.update('none');
}

// ── Move List ───────────────────────────────────────────────────────────

/**
 * Render the interactive move list.
 * @param {Array} moves - Processed move records from backend
 * @param {Function} onMoveClick - callback(type, index)
 * @param {Array} branchMoves - Array of branch moves
 * @param {number} forkIndex - Index in main moves where branch started
 */
export function renderMoveList(moves, onMoveClick, branchMoves = [], forkIndex = null) {
  const container = document.getElementById('move-list');
  if (!container) return;

  const rows = [];
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
      return currentRow;
    }, (row) => currentRow = row, lastMoveNum);
    lastMoveNum = m.move_number;
  }

  // 2. Render branch moves (if any) underneath
  if (branchMoves && branchMoves.length > 0) {
    const branchContainer = document.createElement('div');
    branchContainer.className = 'branch-container mt-2 ml-4 pl-3 border-l-2 border-indigo-500/30 bg-indigo-900/10 rounded-r-md py-1';
    const branchRows = [];
    let bCurrentRow = null;
    let bLastMoveNum = -1;

    for (let i = 0; i < branchMoves.length; i++) {
      const m = branchMoves[i];
      _appendMoveToRows(branchRows, m, 'branch', i, onMoveClick, () => {
        bCurrentRow = document.createElement('div');
        bCurrentRow.className = 'move-row';
        const numEl = document.createElement('span');
        numEl.className = 'move-num text-[var(--text-secondary)]';
        numEl.textContent = `${m.move_number}.`;
        bCurrentRow.appendChild(numEl);
        bCurrentRow.appendChild(_createEmptyCell(`b-move-cell-w-${m.move_number}`));
        bCurrentRow.appendChild(_createEmptyCell(`b-move-cell-b-${m.move_number}`));
        return bCurrentRow;
      }, (row) => bCurrentRow = row, bLastMoveNum);
      bLastMoveNum = m.move_number;
    }

    branchRows.forEach(r => branchContainer.appendChild(r));
    rows.push(branchContainer);
  }

  container.innerHTML = '';
  rows.forEach(r => container.appendChild(r));
}

function _createEmptyCell(id) {
  const el = document.createElement('div');
  el.id = id;
  return el;
}

function _appendMoveToRows(rowsArray, m, type, index, onClick, createRowFn, setRowFn, lastMoveNum) {
  if (m.color === 'white' || m.move_number !== lastMoveNum) {
    rowsArray.push(createRowFn());
  }

  const currentRow = rowsArray[rowsArray.length - 1];
  const meta = CLASS_META[m.classification];
  const cell = document.createElement('div');
  cell.className = `move-item ${m.color}-move`;
  cell.dataset.type = type;
  cell.dataset.index = index;
  cell.id = `${type}-move-item-${index}`;

  if (meta) {
    const badge = document.createElement('span');
    badge.className = `move-badge ${meta.css}`;
    badge.textContent = meta.symbol;
    cell.appendChild(badge);
  } else {
    // Unclassified yet (waiting for engine)
    const spinner = document.createElement('span');
    spinner.className = 'w-2 h-2 rounded-full bg-indigo-500/50 animate-pulse mr-1 inline-block';
    cell.appendChild(spinner);
  }

  const text = document.createElement('span');
  text.textContent = m.san;
  cell.appendChild(text);
  cell.addEventListener('click', () => onClick(type, index));

  const cellId = type === 'main'
    ? (m.color === 'white' ? `move-cell-w-${m.move_number}` : `move-cell-b-${m.move_number}`)
    : (m.color === 'white' ? `b-move-cell-w-${m.move_number}` : `b-move-cell-b-${m.move_number}`);

  const targetCell = currentRow.querySelector(`#${cellId}`) || currentRow.lastElementChild;
  targetCell.replaceWith(cell);
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
export function renderScorecard(accuracy) {
  _renderSideAccuracy('white', accuracy.white);
  _renderSideAccuracy('black', accuracy.black);
}

function _renderSideAccuracy(side, data) {
  const pct = data.accuracy;

  // Accuracy ring
  const ringEl = document.getElementById(`accuracy-${side}`);
  if (ringEl) {
    const circle = ringEl.querySelector('.ring-progress');
    const label = ringEl.querySelector('.accuracy-number');

    if (circle) {
      const r = 28;
      const circumference = 2 * Math.PI * r;
      const dashOffset = circumference * (1 - pct / 100);
      circle.style.strokeDasharray = circumference;
      circle.style.strokeDashoffset = dashOffset;
      circle.style.stroke = _accuracyColor(pct);
    }
    if (label) label.textContent = Math.round(pct);
  }

  // Estimated Rating
  const ratingContainer = document.getElementById(`rating-${side}`);
  if (ratingContainer && data.estimated_rating !== undefined) {
    ratingContainer.querySelector('span').textContent = data.estimated_rating;
    ratingContainer.classList.remove('hidden');
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
          badgeEl.textContent = meta.symbol;
          badgeEl.style = '';
          badgeEl.className = `move-badge ${meta.css}`;
        } else {
          badgeEl.textContent = "—";
          badgeEl.style = '';
          badgeEl.className = `move-badge text-[var(--text-muted)] bg-[var(--bg-card)] border border-[var(--border)]`;
        }
      }
    });
  }

  // Scorecard counts
  const scEl = document.getElementById(`scorecard-${side}`);
  if (!scEl) return;

  scEl.innerHTML = SCORE_ORDER.map(cls => {
    const count = data.counts[cls] || 0;
    const meta = CLASS_META[cls];
    return `
      <div class="score-row">
        <span class="score-label">
          <span class="move-badge ${meta.css}">${meta.symbol}</span>
          ${meta.label}
        </span>
        <span class="score-count" style="color: ${count > 0 ? _classColor(cls) : 'var(--text-muted)'}">
          ${count}
        </span>
      </div>
    `;
  }).join('');
}

function _accuracyColor(pct) {
  if (pct >= 90) return '#22c55e';
  if (pct >= 75) return '#84cc16';
  if (pct >= 60) return '#eab308';
  if (pct >= 45) return '#f97316';
  return '#ef4444';
}

function _classColor(cls) {
  const map = {
    brilliant: '#06b6d4', great: '#818cf8', best: '#22c55e',
    excellent: '#4ade80', good: '#a3e635', inaccuracy: '#eab308',
    mistake: '#f97316', miss: '#f43f5e', blunder: '#ef4444', book: '#94a3b8',
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
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span>
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
