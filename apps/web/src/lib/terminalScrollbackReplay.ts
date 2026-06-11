export interface ResolveScrollbackReplayInput {
  readonly scrollback: string | null;
  readonly resultOffset: number | null;
  readonly reset: boolean;
  readonly sinceOffset: number | undefined;
  readonly lastServerOffset: number;
}

export interface ResolvedScrollbackReplay {
  readonly scrollback: string | null;
  readonly nextLastServerOffset: number;
}

/**
 * Resolve which part of a server scrollback response still needs replay.
 *
 * Reattach can time out and start accepting live output before the async
 * scrollback delta returns. In that case the terminal cache offset may already
 * be ahead of the response. Never replay already-written text and never move
 * the cache offset backwards.
 */
export function resolveScrollbackReplay(
  input: ResolveScrollbackReplayInput,
): ResolvedScrollbackReplay {
  const resultOffset = input.resultOffset;
  const currentOffset = input.lastServerOffset;

  if (
    input.reset &&
    input.sinceOffset != null &&
    resultOffset != null &&
    resultOffset <= currentOffset
  ) {
    return { scrollback: "", nextLastServerOffset: currentOffset };
  }

  if (input.reset || input.sinceOffset == null || resultOffset == null) {
    return {
      scrollback: input.scrollback,
      nextLastServerOffset:
        resultOffset != null ? Math.max(currentOffset, resultOffset) : currentOffset,
    };
  }

  if (resultOffset <= currentOffset) {
    return { scrollback: "", nextLastServerOffset: currentOffset };
  }

  const scrollback = input.scrollback;
  if (!scrollback) {
    return { scrollback, nextLastServerOffset: resultOffset };
  }

  const responseStartOffset = resultOffset - scrollback.length;
  const missingStartOffset = Math.max(input.sinceOffset, currentOffset);

  if (missingStartOffset <= responseStartOffset) {
    return { scrollback, nextLastServerOffset: resultOffset };
  }

  if (missingStartOffset >= resultOffset) {
    return { scrollback: "", nextLastServerOffset: currentOffset };
  }

  return {
    scrollback: scrollback.slice(missingStartOffset - responseStartOffset),
    nextLastServerOffset: resultOffset,
  };
}
