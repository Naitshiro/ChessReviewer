// ── Move Coach ──────────────────────────────────────────────────────────
// Deterministic, template-based move commentary. All the "why" comes from
// hard facts computed engine-side (src-tauri/src/analysis.rs::compute_coach_facts);
// this file only turns those facts into sentences, so wording can be iterated
// on without touching the Rust analysis code.
//
// Phrasing patterns below (headline shape "{san} is {label}.", "Takes back.",
// "That's not a mistake, but it's not the best move either.", "A forced move. No
// other option on the board.", the repetition wording, etc.) are modeled on a
// real captured chess.com Coach transcript the user provided, not invented from
// scratch — see lines.txt in the repo root.

const CLASS_LABEL = {
  brilliant: 'a brilliant move',
  great: 'a great move',
  best: 'best',
  excellent: 'excellent',
  good: 'good',
  inaccuracy: 'an inaccuracy',
  mistake: 'a mistake',
  blunder: 'a blunder',
};

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function withArticle(role) {
  return /^[aeiou]/i.test(role) ? `an ${role}` : `a ${role}`;
}

// ── Opening-principle motifs ────────────────────────────────────────────
// Chess.com's own opening commentary is curated master-written prose per line —
// out of scope to reproduce for hundreds of openings. This instead tags each book
// move with a generic opening-principle motif (central space, development, fianchetto,
// castling, early queen sortie...) purely from its SAN, the way a coach would narrate
// a move on principle before knowing the deep theory behind it.
function describeBookMotif(san, moveNumber) {
  const clean = (san || '').replace(/[+#!?]+$/, '');

  if (clean === 'O-O') return 'Castling kingside tends to be safer than queenside because the king ends up further from the center.';
  if (clean === 'O-O-O') return 'Castling queenside — often a sign of aggressive intentions on the other wing.';

  const pieceChar = clean[0];
  const isPieceMove = ['N', 'B', 'R', 'Q', 'K'].includes(pieceChar);
  const destMatch = clean.match(/([a-h][1-8])$/);
  const dest = destMatch ? destMatch[1] : null;
  const file = dest ? dest[0] : null;
  const rank = dest ? parseInt(dest[1], 10) : null;
  const isCapture = clean.includes('x');

  if (!isPieceMove) {
    // Pawn move.
    const isCentralFile = file === 'd' || file === 'e';
    const isDoublePush = rank === 4 || rank === 5;

    if (isCapture) return 'This captures in the center, opening lines for the pieces.';
    if (isCentralFile) {
      return isDoublePush
        ? 'This establishes center control with the pawn and opens up the bishop and queen.'
        : 'This stakes a modest claim in the center, keeping the structure flexible.';
    }
    if ((file === 'c' || file === 'f') && isDoublePush) {
      return 'This challenges the center from the flank.';
    }
    if ((file === 'g' || file === 'b') && (rank === 3 || rank === 6)) {
      return 'This prepares to fianchetto the bishop onto the long diagonal.';
    }
    if ((file === 'h' || file === 'a') && (rank === 3 || rank === 6)) {
      return 'A quiet flank move — often just luft or prophylaxis.';
    }
    return 'A flexible pawn move, keeping options open.';
  }

  switch (pieceChar) {
    case 'N':
      return (file === 'a' || file === 'h')
        ? 'This develops the knight toward the rim, usually the less active post.'
        : 'This develops the knight and supports the center.';
    case 'B':
      if (dest === 'g2' || dest === 'g7' || dest === 'b2' || dest === 'b7') {
        return 'This fianchettoes the bishop onto the long diagonal.';
      }
      return 'This prepares the bishop for an active diagonal.';
    case 'Q':
      return moveNumber <= 6
        ? 'This brings the queen out early — developing moves can attack it with tempo.'
        : 'This repositions the queen.';
    case 'R':
      return 'This repositions the rook, often eyeing an open file.';
    case 'K':
      return 'This moves the king by hand, unusual this early.';
    default:
      return 'A solid choice.';
  }
}

/**
 * Turn one move record (as returned by the backend, including its `coach` facts)
 * into a short coach message: { headline, lines }.
 * @param {object} move - the active move record
 * @returns {{headline: string, lines: string[]} | null}
 */
export function buildCoachMessage(move) {
  if (!move) return null;

  const facts = move.coach || {};
  const color = move.color || 'white';
  const san = move.san || '';
  const classification = move.classification || null;

  // Mate-in-N, mover-relative (matches the sign convention already used for classification):
  // positive = the side that just moved now has a forced mate; negative = that side has just
  // walked into (or remains under) a forced mate from the opponent.
  const mateBefore = typeof move.mate_best === 'number' ? move.mate_best : null;
  const mateAfter = typeof move.mate_played === 'number' ? move.mate_played : null;
  const wasAlreadyLostByForce = mateBefore !== null && mateBefore < 0;
  const nowForcesMateForMover = mateAfter !== null && mateAfter > 0 && !facts.delivers_checkmate;
  const nowAllowsOpponentMate = mateAfter !== null && mateAfter < 0;
  const missedForcedMate = mateBefore !== null && mateBefore > 0 && !nowForcesMateForMover && !facts.delivers_checkmate;

  const lines = [];
  let headline;

  // 1. Headline — mate-forcing/self-mating/forced-move/checkmate news outranks the ordinary
  //    "{san} is {label}." shape, since these settle or determine the game outcome by force.
  if (facts.delivers_checkmate) {
    headline = `Checkmate! ${san} ends the game.`;
  } else if (nowAllowsOpponentMate && !wasAlreadyLostByForce) {
    headline = `${san} allows a forced mate in ${Math.abs(mateAfter)} for the opponent!`;
  } else if (nowForcesMateForMover) {
    headline = `${san} forces mate in ${mateAfter} with best play.`;
  } else if (facts.is_forced_move) {
    headline = `${san} is forced.`;
    lines.push('A forced move. No other option on the board.');
  } else if (move.is_book) {
    headline = `${san} is ${move.is_last_book_move ? 'the last book move' : 'a book move'}.`;
  } else if (classification && CLASS_LABEL[classification]) {
    headline = `${san} is ${CLASS_LABEL[classification]}.`;
  } else {
    headline = `${san} is played.`;
  }

  // Secondary mate context that doesn't need to dominate the headline.
  if (nowAllowsOpponentMate && wasAlreadyLostByForce) {
    lines.push(`The position was already lost by force — mate in ${Math.abs(mateAfter)} stands.`);
  }
  if (missedForcedMate) {
    lines.push(`This is a miss! ${facts.best_move_san ? `${facts.best_move_san} forced mate in ${mateBefore}.` : `A mate in ${mateBefore} was on the board.`}`);
  }

  // 2. The "why" line. Book moves get their opening-principle motif; every other move gets
  //    the single most relevant reason, roughly in the order a coach would reach for it:
  //    how it responded to check, whether it was a free/equal/recapture trade, whether it
  //    creates or misses a concrete tactic, then a generic classification-flavored fallback.
  if (move.is_book) {
    lines.push(describeBookMotif(san, move.move_number));
    if (move.is_last_book_move && move.opening) lines.push(`Opening: ${move.opening}.`);
  } else if (!facts.is_forced_move && !facts.delivers_checkmate) {
    if (facts.was_in_check && facts.check_response) {
      if (facts.check_response === 'captures_checker') {
        lines.push(`This captures the checking ${facts.checker_role || 'piece'}.`);
      } else if (facts.check_response === 'king_moves') {
        lines.push('This moves the king out of check.');
      } else {
        lines.push(`This blocks the check from ${withArticle(`opposing ${facts.checker_role || 'piece'}`)}.`);
      }
    } else if (facts.captured_role && facts.captured_was_free) {
      lines.push(`That ${facts.captured_role} was free for the taking.`);
    } else if (facts.forks && facts.forks.length >= 2) {
      const targets = facts.forks.map(f => f.role).join(' and ');
      lines.push(`This forks the ${targets}.`);
    } else if (facts.captured_role && facts.is_recapture) {
      lines.push(facts.captured_role === facts.moved_role
        ? 'Takes back.'
        : `With this recapture, ${capitalize(color)} introduces a new piece to the game.`);
    } else if (facts.captured_role && facts.moved_role && facts.captured_role === facts.moved_role) {
      lines.push('This is an equal trade.');
    } else if (facts.captured_role) {
      lines.push(`${san} wins the ${facts.captured_role}.`);
    } else if (facts.gives_check) {
      lines.push(`${san} gives check.`);
    } else if (classification === 'good') {
      lines.push("That's not a mistake, but it's not the best move either.");
    } else if (classification === 'excellent' || classification === 'best') {
      lines.push('A solid choice.');
    }
  }

  // 3. What it allows (concrete threats the move leaves on the board, not just an eval verdict).
  if (facts.hanging && facts.hanging.length > 0) {
    const worst = facts.hanging[0];
    lines.push(`This leaves the ${capitalize(worst.role)} on ${worst.square} hanging — this choice allows a capture for the opponent.`);
  }
  if (facts.opponent_reply_san && (facts.hanging?.length || classification === 'blunder' || classification === 'mistake')) {
    lines.push(`Watch out for the reply ${facts.opponent_reply_san}.`);
  }

  // Repetition / forced-draw context — real chess.com phrasing when a threefold repetition
  // claim is actually available; a softer probability-based warning otherwise.
  if (facts.is_repetition_draw) {
    if (classification === 'great') {
      lines.length = 0;
      lines.push('Great find! This was the only move that works!');
      lines.push('This will lead to a draw by repetition, where the same position repeats three times.');
    } else if (classification === 'mistake' || classification === 'blunder') {
      lines.push('This permits the opponent to claim a draw by three-fold repetition.');
    } else {
      lines.push('This leads to a draw by repetition, where the same position repeats three times.');
    }
  } else {
    const pBest = typeof move.p_best === 'number' ? move.p_best : null;
    const pPlayed = typeof move.p_played === 'number' ? move.p_played : null;
    if (pBest !== null && pPlayed !== null && pBest >= 0.85 && pPlayed >= 0.35 && pPlayed <= 0.65 && mateAfter === null) {
      lines.push('This only holds a draw — the position was clearly winning before this move.');
    }
  }

  // 4. What was better — only worth saying if this wasn't already the top choice, and not if
  //    a missed-mate/miss line above already covered it. Names the missed tactic when the
  //    engine's suggested move would have won a fork or piece, matching chess.com's "miss"
  //    behavior ("this misses an opportunity to win a rook through a fork").
  const alreadyOptimal = classification === 'best' || classification === 'great' || classification === 'brilliant' || move.is_book || facts.is_forced_move;
  if (!alreadyOptimal && !missedForcedMate && facts.best_move_san && facts.best_move_san !== san) {
    if (facts.best_move_forks && facts.best_move_forks.length >= 2) {
      const targets = facts.best_move_forks.map(f => f.role).join(' and ');
      lines.push(`This misses an opportunity to win a piece through a fork on the ${targets}.`);
    } else if (facts.best_move_captured_role) {
      lines.push(`This misses a chance to win the ${facts.best_move_captured_role} with ${facts.best_move_san}.`);
    } else {
      lines.push(`The better move was ${facts.best_move_san}.`);
    }
  }

  return { headline, lines };
}
