// Types for the sibling `.mjs` module, so the typechecked browser-free suite sees them.
export class CvFactsError extends Error {
  // The range is accepted untyped because callers pass candidate data; the constructor keeps
  // it only when both ends are plain line numbers.
  constructor(
    reason: string,
    detail?: { lines?: { start: unknown; end: unknown }; option?: string },
  );
  readonly reason: string;
  readonly lines?: { start: number; end: number };
  readonly option?: string;
}

export function describeFailure(error: unknown): string[];
