export interface CvSourceRange {
  startLine: number;
  endLine: number;
}

export interface CvHeadingPosition {
  level: number;
  line: number;
}

export interface CvSectionRange {
  startLine: number;
  endLine: number;
  anchorId: string;
}

export function cvHeadingId(line: number): string {
  return `cv-line-${line}`;
}

/** Builds inclusive section ranges from rendered Markdown heading positions. */
export function buildCvSectionRanges(
  headings: readonly CvHeadingPosition[],
  markdownLineCount: number,
): CvSectionRange[] {
  if (!Number.isInteger(markdownLineCount) || markdownLineCount < 1) return [];

  const lines = [...new Set(
    headings
      .filter(({ level, line }) =>
        Number.isInteger(level) && level >= 1 && level <= 4 &&
        Number.isInteger(line) && line >= 1 && line <= markdownLineCount,
      )
      .map(({ line }) => line),
  )].sort((left, right) => left - right);

  return lines.map((line, index) => ({
    startLine: line,
    endLine: lines[index + 1] === undefined ? markdownLineCount : (lines[index + 1] ?? line) - 1,
    anchorId: cvHeadingId(line),
  }));
}

/** Returns the first covered section in source-reference order only when its real anchor exists. */
export function resolveCvAnchor(
  sourceRefs: readonly CvSourceRange[],
  sections: readonly CvSectionRange[],
  hasAnchor: (id: string) => boolean,
): string | null {
  for (const sourceRef of sourceRefs) {
    const section = sections.find(
      ({ startLine, endLine }) => sourceRef.startLine <= endLine && sourceRef.endLine >= startLine,
    );
    if (section === undefined) continue;
    if (!hasAnchor(section.anchorId)) return null;

    return section.anchorId;
  }

  return null;
}
