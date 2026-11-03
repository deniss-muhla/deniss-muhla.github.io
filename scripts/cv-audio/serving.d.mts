import type { IncomingMessage, ServerResponse } from "node:http";
export function createDevPairGuard(options: {
  factsPath: string;
  audioDirectory: string;
  checkFacts: () => Promise<unknown>;
}): () => Promise<void>;
export function createDevPairMiddleware(assertCompletePair: () => Promise<void>): (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;
