/**
 * Snapshot windowing — truncate large accessibility snapshots while
 * preserving pagination/navigation links at the tail.
 */

export interface WindowSnapshotResult {
  text: string;
  truncated: boolean;
  totalChars: number;
  offset: number;
  hasMore?: boolean;
  nextOffset?: number | null;
}

const DEFAULT_MAX_SNAPSHOT_CHARS = 80_000;
const DEFAULT_SNAPSHOT_TAIL_CHARS = 5_000;

/**
 * Return a window of the snapshot YAML.
 *  offset=0 (default): head chunk + tail (pagination/nav).
 *  offset=N: chars N..N+budget from the full snapshot.
 *  Always appends pagination tail so nav refs are available in every chunk.
 */
export function windowSnapshot(
  yaml: string | null | undefined,
  offset: number = 0,
  maxChars: number = DEFAULT_MAX_SNAPSHOT_CHARS,
  tailChars: number = DEFAULT_SNAPSHOT_TAIL_CHARS,
): WindowSnapshotResult {
  if (!yaml) return { text: '', truncated: false, totalChars: 0, offset: 0 };

  const total = yaml.length;
  if (total <= maxChars) {
    return { text: yaml, truncated: false, totalChars: total, offset: 0, hasMore: false, nextOffset: null };
  }

  const safeTailChars = Math.max(0, Math.min(tailChars, total));
  const safeMaxChars = Math.max(1, maxChars);
  const markerBudget = 200;
  const minContentBudget = 100;
  const contentBudget = Math.max(minContentBudget, safeMaxChars - safeTailChars - markerBudget);

  const tail = yaml.slice(-safeTailChars);
  const maxOffset = Math.max(0, total - safeTailChars);
  const clampedOffset = Math.min(Math.max(0, offset), maxOffset);
  const chunk = yaml.slice(clampedOffset, clampedOffset + contentBudget);
  const chunkEnd = clampedOffset + contentBudget;
  const hasMore = chunkEnd < total - safeTailChars;

  const marker = hasMore
    ? `\n[... truncated at char ${chunkEnd} of ${total}. Call snapshot with offset=${chunkEnd} to see more. Pagination links below. ...]\n`
    : '\n';

  return {
    text: chunk + marker + tail,
    truncated: true,
    totalChars: total,
    offset: clampedOffset,
    hasMore,
    nextOffset: hasMore ? chunkEnd : null,
  };
}

export { DEFAULT_MAX_SNAPSHOT_CHARS, DEFAULT_SNAPSHOT_TAIL_CHARS };
