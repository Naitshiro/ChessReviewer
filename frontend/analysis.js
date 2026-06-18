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
  theory: { symbol: '⌕', label: 'Theory', css: 'badge-theory' },
};

// Classification display order for the scorecard
const SCORE_ORDER = [
  'brilliant', 'great', 'best', 'excellent', 'good', 'theory',
  'inaccuracy', 'mistake', 'miss', 'blunder',
];

export const COMPREHENSIVE_NAG_MAP = {
  1: { symbol: "!", label: "Good Move", classKey: "good" },
  2: { symbol: "?", label: "Mistake", classKey: "mistake" },
  3: { symbol: "!!", label: "Brilliant Move", classKey: "brilliant" },
  4: { symbol: "??", label: "Blunder", classKey: "blunder" },
  5: { symbol: "!?", label: "Interesting", classKey: "excellent" },
  6: { symbol: "?!", label: "Dubious Move", classKey: "inaccuracy" },
  7: { symbol: "□", label: "Forced", classKey: "best" },
  10: { symbol: "=", label: "Balanced", classKey: "theory" },
  11: { symbol: "=", label: "Balanced", classKey: "theory" },
  12: { symbol: "=", label: "Balanced", classKey: "theory" },
  13: { symbol: "∞", label: "Unclear", classKey: "theory" },
  14: { symbol: "⩲", label: "Slight advantage", classKey: "theory" },
  15: { symbol: "⩱", label: "Slight advantage", classKey: "theory" },
  16: { symbol: "±", label: "Moderate advantage", classKey: "theory" },
  17: { symbol: "∓", label: "Moderate advantage", classKey: "theory" },
  18: { symbol: "+-", label: "Decisive advantage", classKey: "theory" },
  20: { symbol: "+-", label: "Decisive advantage", classKey: "theory" },
  19: { symbol: "-+", label: "Decisive advantage", classKey: "theory" },
  21: { symbol: "-+", label: "Decisive advantage", classKey: "theory" },
  22: { symbol: "⨀", label: "Zugzwang", classKey: "theory" },
  23: { symbol: "⨀", label: "Zugzwang", classKey: "theory" },
  26: { symbol: "○", label: "Space", classKey: "theory" },
  27: { symbol: "○", label: "Space", classKey: "theory" },
  32: { symbol: "⟳", label: "Development", classKey: "theory" },
  33: { symbol: "⟳", label: "Development", classKey: "theory" },
  36: { symbol: "↑", label: "Initiative" },
  37: { symbol: "↑", label: "Initiative" },
  40: { symbol: "→", label: "Attack" },
  41: { symbol: "→", label: "Attack" },
  44: { symbol: "⯹", label: "Compensation" },
  45: { symbol: "⯹", label: "Compensation" },
  130: { symbol: "⇆", label: "Counterplay" },
  131: { symbol: "⇆", label: "Counterplay" },
  136: { symbol: "⨁", label: "Time trouble" },
  137: { symbol: "⨁", label: "Time trouble" },
  146: { symbol: "N", label: "Novelty" }
};

export function getMateMoves(plies, color) {
  if (plies === null || plies === undefined) return null;
  const relPlies = color === 'white' ? plies : -plies;
  if (relPlies > 0) return Math.ceil(relPlies / 2.0);
  if (relPlies < 0) return -Math.ceil(Math.abs(relPlies) / 2.0);
  return 0;
}

// ── Evaluation Bar ──────────────────────────────────────────────────────

const evalBarWhite = document.getElementById('eval-bar-white');
const evalBarLabel = document.getElementById('eval-bar-label');

/**
 * Update the evaluation bar.
 * @param {number} whiteCp - Centipawns from White's perspective (positive = White winning)
 * @param {number|null} mateMoves - Mate-in-N (positive = White mating, negative = Black mating)
 */
export function renderEvalBar(whiteCp, mateMoves = null, gameOver = false, winner = null, orientation = 'white') {
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
      heightPct = mateMoves > 0 ? 100 : 0;
      labelText = mateMoves > 0 ? `M${mateMoves}` : `M${-mateMoves}`;
    }
  } else {
    // Win probability from White's perspective
    const clampedCp = Math.max(-3000, Math.min(3000, whiteCp || 0));
    const prob = 1 / (1 + Math.exp(-0.004 * clampedCp));
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
export function renderMoveList(moves, onMoveClick, branchMoves = [], forkIndex = null, overlayPriority = 'classification') {
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
      return currentRow;
    }, (row) => currentRow = row, lastMoveNum, overlayPriority);
    lastMoveNum = m.move_number;
    rowElements[i] = currentRow;
  }

  container.innerHTML = '';
  rows.forEach(r => container.appendChild(r));

  // 2. Render branch moves inline
  if (branchMoves && branchMoves.length > 0 && forkIndex !== null) {
    const branchContainer = document.createElement('div');
    // Subtle background to distinguish branch, no left margin so columns align perfectly
    branchContainer.className = 'branch-container bg-indigo-900/20 my-1 py-1 rounded';
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
        return bCurrentRow;
      }, (row) => bCurrentRow = row, bLastMoveNum, overlayPriority);
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
}

function _createEmptyCell(id) {
  const el = document.createElement('div');
  el.id = id;
  return el;
}

function _appendMoveToRows(rowsArray, m, type, index, onClick, createRowFn, setRowFn, lastMoveNum, overlayPriority = 'classification') {
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
        css: `badge-${annotationObj.classKey || 'theory'}`,
        label: annotationObj.label
      };
    } else if (meta) {
      badgeToRender = {
        symbol: meta.symbol,
        css: meta.css,
        label: meta.label
      };
    }
  } else { // 'classification'
    if (meta) {
      badgeToRender = {
        symbol: meta.symbol,
        css: meta.css,
        label: meta.label
      };
    } else if (annotationObj) {
      badgeToRender = {
        symbol: annotationObj.symbol,
        css: 'badge-annotation',
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
    const badge = document.createElement('span');
    badge.className = `move-badge ${badgeToRender.css}`;
    badge.textContent = badgeToRender.symbol;
    badge.title = badgeToRender.label;
    cell.appendChild(badge);
  } else if (m.classification === null || m.classification === undefined) {
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
            <span class="move-badge ${meta.css}">${meta.symbol}</span>
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
          if (!counts[key]) counts[key] = { symbol: nagObj.symbol, label: nagObj.label, classKey: nagObj.classKey, white: 0, black: 0 };
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
    const classKey = data.classKey || 'theory';
    return `
      <div class="flex justify-between items-center">
        <span class="flex items-center gap-2">
          <div class="flex gap-1">
            <span class="move-badge badge-${classKey} font-bold">${nagStr}</span>
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
          badgeEl.textContent = meta.symbol;
          badgeEl.removeAttribute('style');
          badgeEl.className = `move-badge ${meta.css}`;
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
    mistake: '#f97316', miss: '#f43f5e', blunder: '#ef4444', theory: '#b58863',
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
