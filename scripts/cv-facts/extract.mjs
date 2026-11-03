/**
 * Source-unit extraction for `cv:facts prepare`, following design decision 5.
 *
 * Sections, paragraphs, bullets and GFM table rows become units. An employer heading with
 * its pipe-separated header line carries the paragraphs, bullets and stack below it, so a
 * card can name the employer, and each technology row stays its own unit. Nothing is
 * inferred: a grouping this parser cannot read stops preparation with a source coordinate
 * instead of a guess about a date, a role or an employer.
 *
 * This is extraction for one known markdown document, not a general resume schema. The
 * only parser dependencies are the repository's existing `remark` and `remark-gfm`.
 */
import { remark } from "remark";
import remarkGfm from "remark-gfm";

import { CvFactsError } from "./errors.mjs";

/** Design decision 5 coverage areas. Every emitted unit names exactly one of them. */
export const COVERAGE_AREAS = Object.freeze([
  "identity",
  "role",
  "location",
  "contact",
  "profile",
  "focus",
  "employment",
  "strengths",
  "technology",
  "languages",
  "certificates",
  "interests",
]);

const SECTION_AREAS = new Map([
  ["profile", "profile"],
  ["current focus", "focus"],
  ["experience", "employment"],
  ["strengths", "strengths"],
  ["core expertise", "strengths"],
  ["technology stack", "technology"],
  ["language", "languages"],
  ["certificates", "certificates"],
  ["interests", "interests"],
]);

const EMPLOYER_FIELD_COUNT = 4;
/** A period must state both ends. Anything else would mean inferring a date. */
const PERIOD_PATTERN = /\b(?:[a-z]{3,}\s+)?\d{4}\s*-\s*(?:[a-z]{3,}\s+)?(?:present|\d{4})\s*$/i;
const STACK_PREFIX = /^\s*\**\s*stack\s*:\s*/i;
const BLOCK_JOIN_TYPES = new Set(["blockquote", "list", "listItem"]);
const SUPPORTED_TOP_LEVEL = new Set([
  "heading",
  "paragraph",
  "blockquote",
  "list",
  "table",
  "thematicBreak",
]);

function normalizeHeading(text) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function linesOf(node) {
  return { start: node.position.start.line, end: node.position.end.line };
}

function nodeText(node) {
  if (!node) return "";
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "break") return "\n";
  if (node.type === "html") return node.value ?? "";
  if (!Array.isArray(node.children)) return "";
  const separator = BLOCK_JOIN_TYPES.has(node.type) ? "\n" : "";
  return node.children.map(nodeText).join(separator);
}

function listItemTexts(list) {
  return list.children.map((item) => nodeText(item).trim());
}

/** Splits a hard-break-separated paragraph into rows that keep their own line coordinates. */
function paragraphRows(paragraph) {
  const rows = [];
  let current = null;

  for (const child of paragraph.children) {
    if (child.type === "break") {
      if (current) rows.push(current);
      current = null;
      continue;
    }

    current ??= { text: "", start: child.position.start.line, end: child.position.end.line };
    current.text += nodeText(child);
    current.end = child.position.end.line;
  }

  if (current) rows.push(current);

  return rows.filter((row) => row.text.trim() !== "");
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseEmployerHeader(text, lines) {
  const fields = text.split("|").map((field) => field.trim());

  if (fields.length !== EMPLOYER_FIELD_COUNT || fields.some((field) => field === "")) {
    throw new CvFactsError("extract/employer-header-malformed", { lines });
  }

  const [employer, role, location, period] = fields;

  if (!PERIOD_PATTERN.test(period)) {
    throw new CvFactsError("extract/employer-period-unreadable", { lines });
  }

  return { employer, role, location, period };
}

function parseStack(text, lines) {
  const items = text
    .replace(STACK_PREFIX, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (items.length === 0) throw new CvFactsError("extract/stack-unreadable", { lines });

  return items;
}

/**
 * @param {string} markdown the raw canonical markdown
 * @returns {{ units: object[], omissions: object[], coverage: Record<string, { units: number }> }}
 */
export function extractSourceUnits(markdown) {
  const root = remark().use(remarkGfm).parse(markdown);
  const units = [];
  const omissions = [];
  let section = null;
  let employer = null;
  let sawTitle = false;
  let profileStatementCount = 0;

  const pushUnit = (unit) => {
    units.push(unit);
    return unit;
  };

  const flushEmployer = () => {
    if (!employer) return;
    employer.unit.lines = { start: employer.unit.lines.start, end: employer.unit.lastLine };
    employer = null;
  };

  for (const node of root.children) {
    if (!SUPPORTED_TOP_LEVEL.has(node.type)) {
      throw new CvFactsError("extract/unsupported-node", { lines: linesOf(node) });
    }

    if (node.type === "heading") {
      flushEmployer();
      const text = nodeText(node).trim();

      if (node.depth === 1) {
        if (sawTitle || section !== null) {
          throw new CvFactsError("extract/unexpected-title", { lines: linesOf(node) });
        }

        sawTitle = true;
        pushUnit({
          area: "identity",
          kind: "title",
          cardId: "identity-name",
          label: text,
          lines: linesOf(node),
          text,
        });
        continue;
      }

      if (node.depth !== 2) {
        if (section?.area !== "employment") {
          throw new CvFactsError("extract/unexpected-subheading", { lines: linesOf(node) });
        }

        const header = parseEmployerHeader(text, linesOf(node));
        const lines = linesOf(node);
        const unit = {
          area: "employment",
          kind: "employer",
          cardId: `employment-${slug(header.employer) || slug(text)}`,
          label: header.employer,
          header,
          lines,
          lastLine: lines.end,
          context: [],
          items: [],
          stack: [],
        };

        pushUnit(unit);
        employer = { unit };
        continue;
      }

      if (!sawTitle) throw new CvFactsError("extract/missing-title", { lines: linesOf(node) });

      const area = SECTION_AREAS.get(normalizeHeading(text));

      if (!area) throw new CvFactsError("extract/unknown-section", { lines: linesOf(node) });

      section = { area };
      continue;
    }

    if (node.type === "thematicBreak") {
      omissions.push({ kind: "thematic-break", reason: "format-only", lines: linesOf(node) });
      continue;
    }

    if (node.type === "blockquote") {
      if (section !== null || employer !== null) {
        throw new CvFactsError("extract/unexpected-block", { lines: linesOf(node) });
      }

      pushUnit({
        area: "profile",
        kind: "quote",
        cardId: "profile",
        label: "profile",
        lines: linesOf(node),
        text: nodeText(node).trim(),
      });
      continue;
    }

    if (node.type === "paragraph") {
      if (employer) {
        const text = nodeText(node).trim();

        if (STACK_PREFIX.test(text)) {
          employer.unit.stack = parseStack(text, linesOf(node));
        } else {
          employer.unit.context.push(text);
        }

        employer.unit.lastLine = node.position.end.line;
        continue;
      }

      if (section === null) {
        const rows = paragraphRows(node);

        if (rows.length < 2) {
          throw new CvFactsError("extract/identity-block-incomplete", { lines: linesOf(node) });
        }

        // The canonical CV states the title, then the role, then the location, then contact
        // fields. Position is the only thing read here; nothing is inferred from the wording.
        const areas = ["role", "location"];
        rows.forEach((row, index) => {
          const area = areas[index] ?? "contact";
          pushUnit({
            area,
            kind: "identity-row",
            cardId: index < 2 ? `identity-${area}` : `identity-contact-${index}`,
            label: area,
            lines: { start: row.start, end: row.end },
            text: row.text.trim(),
          });
        });
        continue;
      }

      if (section.area !== "profile") {
        throw new CvFactsError("extract/unexpected-block", { lines: linesOf(node) });
      }

      profileStatementCount += 1;
      pushUnit({
        area: "profile",
        kind: "note",
        cardId: profileStatementCount === 1 ? "profile-statement" : `profile-statement-${profileStatementCount}`,
        label: "profile statement",
        lines: linesOf(node),
        text: nodeText(node).trim(),
      });
      continue;
    }

    if (node.type === "list") {
      if (employer) {
        employer.unit.items.push(...listItemTexts(node));
        employer.unit.lastLine = node.position.end.line;
        continue;
      }

      if (section === null) throw new CvFactsError("extract/unexpected-block", { lines: linesOf(node) });

      // Employment content only reads as a card when an employer heading groups it. Without
      // one there is no employer, role or period to cite, so the document stops here instead
      // of becoming a card that names nothing.
      if (section.area === "employment") {
        throw new CvFactsError("extract/employer-grouping-missing", { lines: linesOf(node) });
      }

      const items = listItemTexts(node);
      const label = `${section.area} list`;

      pushUnit({
        area: section.area,
        kind: "group",
        cardId: section.area,
        label,
        lines: linesOf(node),
        items,
      });
      continue;
    }

    // node.type === "table"
    if (section?.area !== "technology" || employer !== null) {
      throw new CvFactsError("extract/unexpected-table", { lines: linesOf(node) });
    }

    const [header, ...rows] = node.children;

    if (!header || header.type !== "tableRow") {
      throw new CvFactsError("extract/table-header-unreadable", { lines: linesOf(node) });
    }

    omissions.push({ kind: "table-header", reason: "format-only", lines: linesOf(header) });
    const levelColumn = header.children.findIndex((cell) => normalizeHeading(nodeText(cell)) === "level");

    for (const row of rows) {
      const cells = row.children.map((cell) => nodeText(cell).trim());
      const [label] = cells;

      if (!label) throw new CvFactsError("extract/technology-row-unreadable", { lines: linesOf(row) });

      pushUnit({
        area: "technology",
        kind: "row",
        cardId: `technology-${slug(label) || slug(row.children.map((cell) => nodeText(cell)).join("-"))}`,
        label,
        lines: linesOf(row),
        items: cells,
        ...(levelColumn >= 0 ? { level: cells[levelColumn] ?? "" } : {}),
      });
    }
  }

  flushEmployer();

  if (!sawTitle) throw new CvFactsError("extract/missing-title", { lines: { start: 1, end: 1 } });
  if (units.length === 0) throw new CvFactsError("extract/no-units", { lines: { start: 1, end: 1 } });

  // Scaffold identifiers must be unique and stable, because a card id is what a source
  // review, an embedding run and the offline check all refer to.
  const seenIds = new Set();
  for (const unit of units) {
    if (seenIds.has(unit.cardId)) {
      throw new CvFactsError("extract/duplicate-card-id", { lines: unit.lines });
    }

    seenIds.add(unit.cardId);
  }

  const blankLines = markdown.split("\n").filter((line) => line.trim() === "").length;

  if (blankLines > 0) {
    omissions.push({ kind: "blank-lines", reason: "blank", count: blankLines });
  }

  const coverage = Object.fromEntries(COVERAGE_AREAS.map((area) => [area, 0]));

  for (const unit of units) coverage[unit.area] += 1;

  return { units, omissions, coverage };
}