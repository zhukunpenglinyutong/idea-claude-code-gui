export function getBlockMap(turnState, key) {
  if (!(turnState[key] instanceof Map)) {
    turnState[key] = new Map();
  }
  return turnState[key];
}

function getBlockIndex(index) {
  const numericIndex = typeof index === 'string' ? Number(index) : index;
  return Number.isInteger(numericIndex) && numericIndex >= 0 ? numericIndex : 0;
}

function getModeMap(turnState) {
  if (!(turnState.blockStreamModeByKey instanceof Map)) {
    turnState.blockStreamModeByKey = new Map();
  }
  return turnState.blockStreamModeByKey;
}

function modeKey(kind, blockIndex) {
  return `${kind}:${blockIndex}`;
}

function computeNovelDelta(previous, incoming, mode, origin) {
  if (!incoming) {
    return { novel: '', next: previous, mode };
  }
  if (!previous) {
    return { novel: incoming, next: incoming, mode };
  }

  // Cumulative-snapshot path: incoming is previous + new content. Confirms the
  // block is in snapshot mode for any subsequent corrective rewrites.
  //
  // Special case `incoming === previous` (novel === ''): meaning depends on
  // which path the caller is on, distinguished by `origin`:
  //
  //   • origin === 'snapshot' — assistant-message snapshot re-delivering the
  //     fully-accumulated block. The whole block has already been emitted via
  //     live deltas. Always absorb: re-emitting would duplicate the entire
  //     block in the UI (issue tracker streaming-duplication-fix). This was
  //     the legacy unconditional behavior, and is correct for THIS path.
  //
  //   • origin === 'stream' — a live content_block_delta. Each call is one
  //     fresh delta from the provider. An identical delta is a real duplicate
  //     (repeated characters like "刚刚", "谢谢", "慢慢", or any token
  //     boundary that emits the same token twice). The legacy code wrongly
  //     absorbed these AND locked snapshot mode, swallowing the rest of the
  //     reply — issue #1371's "除第一个字都会被吞掉". Treat it as an
  //     incremental delta: emit the duplicate as novel content and DO NOT
  //     lock snapshot mode. A real snapshot provider would never emit an
  //     identical re-send as its first ambiguous signal — its defining trait
  //     is monotonically GROWING accumulated content.
  if (incoming.startsWith(previous)) {
    const novel = incoming.slice(previous.length);
    if (!novel) {
      if (origin === 'snapshot' || mode === 'snapshot' || mode === 'incremental') {
        return { novel: '', next: previous, mode };
      }
      return { novel: incoming, next: previous + incoming, mode };
    }
    return { novel, next: incoming, mode: 'snapshot' };
  }

  // Stale replay: incoming is fully contained at the start or end of previous.
  // Only active in cumulative-snapshot mode.  In incremental mode every delta is
  // by definition novel, and a coincidental suffix match (e.g. "0" arriving after
  // "150") would falsely absorb legitimate characters — producing the exact
  // character-shift bug seen with 1500 → 150.
  if (mode === 'snapshot' && (previous.startsWith(incoming) || previous.endsWith(incoming))) {
    return { novel: '', next: previous, mode };
  }

  // Fall-through: incoming neither extends nor is a stale replay of previous.
  //
  // For Anthropic-standard providers this is the regular incremental path —
  // each delta is just the next chunk and previous is the cumulative content.
  //
  // For Claude-compatible providers in cumulative-snapshot mode (mimo-v2.5-pro,
  // GLM, MiniMax, etc.) this branch fires when the model emits a "rewritten"
  // snapshot mid-stream: a typo correction, a token re-translation, or a
  // paraphrase.  The two strings share a long common prefix but diverge in the
  // middle, so neither startsWith nor endsWith matches.  Naively appending the
  // rewritten snapshot would visibly double every character before the
  // divergence point — the bug captured in image 1 of issue tracker
  // streaming-duplication-fix-2026-04-28.md.
  //
  // Mode tracking distinguishes the two: once a block has produced at least one
  // confirmed snapshot delta, we know the provider speaks cumulative-snapshot
  // for that block, and any later divergent payload must be a correction, not
  // an incremental fragment.  Absorb it silently and update bookkeeping so the
  // next genuine extension can still be diffed correctly.
  if (mode === 'snapshot') {
    return { novel: '', next: incoming, mode };
  }

  // Default: Anthropic-standard incremental delta.
  return { novel: incoming, next: previous + incoming, mode: 'incremental' };
}

/**
 * Normalise an incoming delta against the block's accumulated content and
 * return the novel slice to emit (empty string when nothing new to deliver).
 *
 * Maintains two pieces of per-block state on `turnState`:
 *   • blockMap (kind+index → accumulated content)
 *   • modeMap  (kind+index → 'snapshot' | 'incremental' | undefined)
 *
 * @param {object} turnState  Per-turn streaming state (see createTurnState).
 * @param {'text'|'thinking'} kind  Which block channel.
 * @param {number|string} index  Content block index from the SDK event.
 * @param {string} incoming  The payload to normalise.
 * @param {'stream'|'snapshot'} [origin='stream']  Call-site semantics —
 *   determines how `incoming === previous` is interpreted:
 *     • 'stream'   — one fresh content_block_delta from the provider; an
 *                    identical re-send is a real duplicate token (e.g. "刚刚",
 *                    "谢谢") and must emit. Pass this from the live event
 *                    handler. Default.
 *     • 'snapshot' — an assistant-message snapshot re-delivering the fully
 *                    accumulated block; an identical match means "nothing new"
 *                    and must absorb to avoid duplicating the whole block in
 *                    the UI. Used internally by {@link resolveSnapshotDelta} —
 *                    direct callers should prefer that wrapper.
 * @returns {string}  The novel suffix to emit, or '' to skip emission.
 */
export function normalizeStreamDelta(turnState, kind, index, incoming, origin = 'stream') {
  const text = typeof incoming === 'string' ? incoming : '';
  const key = kind === 'thinking' ? 'thinkingBlockContentByIndex' : 'textBlockContentByIndex';
  const blockMap = getBlockMap(turnState, key);
  const blockIndex = getBlockIndex(index);
  const previous = blockMap.get(blockIndex) || '';

  const modeMap = getModeMap(turnState);
  const mKey = modeKey(kind, blockIndex);
  const mode = modeMap.get(mKey);

  const result = computeNovelDelta(previous, text, mode, origin);
  blockMap.set(blockIndex, result.next);
  if (result.mode && result.mode !== mode) {
    modeMap.set(mKey, result.mode);
  }
  return result.novel;
}

/**
 * Snapshot-path counterpart to {@link normalizeStreamDelta}.
 *
 * The final (or interim) assistant message carries the FULL text of each block.
 * Route that whole snapshot through the SAME novelty/correction engine the live
 * delta path uses, instead of a naive `snapshot.substring(previous.length)`.
 * A bare substring assumes the snapshot is always a prefix-extension of the
 * accumulated content; when a Claude-compatible provider emits a mid-stream
 * corrective rewrite (same prefix, divergent middle, equal-or-shorter length)
 * the substring either mis-slices or silently drops the change. computeNovelDelta
 * absorbs that case in snapshot mode and keeps the block map single-sourced.
 *
 * Returns the novel delta to emit plus `hadPrevious` (whether the block already
 * held streamed content before this snapshot) — the gate the tail-fill fix
 * depends on. IO and emit-gating stay with the caller so this stays pure.
 */
export function resolveSnapshotDelta(turnState, kind, index, snapshot) {
  const key = kind === 'thinking' ? 'thinkingBlockContentByIndex' : 'textBlockContentByIndex';
  const blockMap = getBlockMap(turnState, key);
  const blockIndex = getBlockIndex(index);
  const hadPrevious = (blockMap.get(blockIndex) || '').length > 0;
  const delta = normalizeStreamDelta(turnState, kind, index, snapshot, 'snapshot');
  return { delta, hadPrevious };
}

/**
 * Reset all per-block streaming bookkeeping at an assistant-turn boundary.
 *
 * The content maps and the mode map are keyed by block INDEX, but every
 * assistant turn — including each tool_use loop iteration — is its own message
 * whose content blocks re-number from index 0. The whole request shares one
 * turnState, so without clearing these at message_start the previous turn's
 * index-0 accumulator and its locked 'snapshot' mode leak into the next turn:
 * computeNovelDelta's snapshot-mode branch then absorbs the new turn's genuine
 * deltas (novel='' → fragmented / vanished output, e.g. the "constifprev"
 * garbled thinking) and a stale accumulator makes the tail-fill snapshot
 * re-emit a whole block (duplication).
 *
 * Token usage is intentionally NOT reset here — it accumulates across turns and
 * is owned by the caller's usage bookkeeping.
 */
export function resetTurnBlockState(turnState) {
  turnState.textBlockContentByIndex = new Map();
  turnState.thinkingBlockContentByIndex = new Map();
  turnState.blockStreamModeByKey = new Map();
}
