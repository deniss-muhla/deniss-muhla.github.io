/**
 * The only failure vocabulary `cv:facts` reports, and the only place a failure is rendered.
 *
 * Every rejection is a rule id from this project's own list. A failure never carries a
 * vendor message, a source line, a card's text or an unchecked identifier, because the
 * commands run against source material and against candidate files that an authoring
 * agent wrote. Source coordinates are kept only when both ends of the range are plain line
 * numbers, so a candidate cannot smuggle text into a coordinate, and a raw exception is
 * never printed, so a vendor message cannot reach the output either.
 */

/** Coordinates beyond this are not line numbers of any document, so they are not printed. */
const MAX_COORDINATE = 1_000_000_000;

function safeLines(lines) {
  const start = lines?.start;
  const end = lines?.end;

  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end < start || start > MAX_COORDINATE || end > MAX_COORDINATE) return null;

  return { start, end };
}

export class CvFactsError extends Error {
  /**
   * @param {string} reason rule id, for example `embed/card-token-cap`
   * @param {{ lines?: { start: number, end: number }, option?: string }} [detail]
   */
  constructor(reason, detail = {}) {
    super(`cv-facts/${reason}`);
    this.name = "CvFactsError";
    this.reason = reason;

    const lines = safeLines(detail.lines);

    if (lines) this.lines = lines;
    if (detail.option) this.option = detail.option;
  }
}

/**
 * The stderr lines for one failure: its classified rule id, and the source coordinates when
 * the range survived `safeLines`. An adapter contract refusal is this project's own
 * vocabulary too, so it crosses the boundary intact; anything else stays an internal
 * failure carrying nothing of the original error.
 *
 * @param {unknown} error
 * @returns {string[]}
 */
export function describeFailure(error) {
  const reason =
    error instanceof CvFactsError
      ? error.reason
      : error?.constructor?.name === "AdapterContractError" && typeof error.reason === "string"
        ? `embed/${error.reason}`
        : "internal-failure";
  const lines = [`[cv] cv-facts/${reason}`];

  if (error instanceof CvFactsError && error.lines) {
    lines.push(`[cv] source coordinates ${error.lines.start}-${error.lines.end}`);
  }

  return lines;
}