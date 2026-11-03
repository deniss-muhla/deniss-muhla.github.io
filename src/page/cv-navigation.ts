export interface CvSourceRange {
  startLine: number;
  endLine: number;
}

export interface CvHeadingPosition {
  level: number;
  line: number;
}

export interface CvSectionRange {
  level: number;
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

  const positions = [...new Map(
    headings
      .filter(({ level, line }) =>
        Number.isInteger(level) && level >= 1 && level <= 4 &&
        Number.isInteger(line) && line >= 1 && line <= markdownLineCount,
      )
      .map((heading) => [heading.line, heading] as const),
  ).values()].sort((left, right) => left.line - right.line);

  return positions.map(({ level, line }, index) => {
    const nextLine = positions[index + 1]?.line;
    return {
      level,
      startLine: line,
      endLine: nextLine === undefined ? markdownLineCount : nextLine - 1,
      anchorId: cvHeadingId(line),
    };
  });
}

/** Prefers cited content in reference order; shared identity context is only a title fallback. */
export function resolveCvAnchor(
  sourceRefs: readonly CvSourceRange[],
  sections: readonly CvSectionRange[],
  hasAnchor: (id: string) => boolean,
): string | null {
  let titleSection: CvSectionRange | undefined;
  for (const sourceRef of sourceRefs) {
    for (const section of sections) {
      if (!(sourceRef.startLine <= section.endLine && sourceRef.endLine >= section.startLine)) continue;
      if (section.level === 1) {
        titleSection ??= section;
        continue;
      }

      return hasAnchor(section.anchorId) ? section.anchorId : null;
    }
  }

  return titleSection !== undefined && hasAnchor(titleSection.anchorId) ? titleSection.anchorId : null;
}
