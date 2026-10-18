// Types for the sibling `.mjs` module, so the typechecked browser-free suite sees them.
export const COVERAGE_AREAS: readonly string[];

export interface SourceUnit {
  area: string;
  kind: string;
  cardId: string;
  label: string;
  lines: { start: number; end: number };
  text?: string;
  items?: string[];
  level?: string;
  header?: { employer: string; role: string; location: string; period: string };
  context?: string[];
  stack?: string[];
}

export interface ExtractionOmission {
  kind: string;
  reason: string;
  lines?: { start: number; end: number };
  count?: number;
}

export function extractSourceUnits(markdown: string): {
  units: SourceUnit[];
  omissions: ExtractionOmission[];
  coverage: Record<string, number>;
};
