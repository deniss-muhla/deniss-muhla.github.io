/**
 * The only failure the retrieval module reports.
 *
 * A reason is this module's own vocabulary, never a vendor message and never an index
 * value, so a rejected index cannot carry card text into a log, a trace or the chat.
 * Retrieval refuses to answer from a state it could not verify instead of degrading
 * into a partial answer.
 */
export class RetrievalError extends Error {
  readonly reason: string;
  /** A field or coordinate name, never a field value. */
  readonly field: string | null;

  constructor(reason: string, field: string | null = null) {
    super(field === null ? `retrieval:${reason}` : `retrieval:${reason}:${field}`);
    this.name = "RetrievalError";
    this.reason = reason;
    this.field = field;
  }
}