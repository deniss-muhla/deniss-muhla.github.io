/**
 * The pinned Whistle runtime and model routes, and the byte counts download progress is
 * measured against.
 *
 * The bytes live in the external asset cache and are emitted into `dist/` by the
 * `model-assets-*` plugins; the manifest that pins them is `scripts/model-assets.mjs`,
 * which a browser-free test keeps equal to this table. Progress is summed over the three
 * real byte counts here, so the ring the visitor sees comes from the fetch streams and
 * never from a timer (AGENTS rule 11).
 *
 * The routes are site-absolute, which assumes the site is served from the domain root.
 */

import facts from "../../../../resources/cv/facts.json" with { type: "json" };

export const WHISTLE_RUNTIME_ROUTE = "/models/cactus-needle/wasm/needle.js";
export const WHISTLE_WASM_ROUTE = "/models/cactus-needle/wasm/needle.wasm";
export const WHISTLE_MODEL_ROUTE = "/models/cactus-needle/whistle/whistle.cact";

/** Pinned size of each download, in bytes. */
export const WHISTLE_ASSET_BYTES = Object.freeze({
  runtime: 63_072,
  wasm: 923_348,
  model: 16_919_407,
});

/** Everything `load` downloads before the engine can transcribe. */
export const WHISTLE_DOWNLOAD_TOTAL =
  WHISTLE_ASSET_BYTES.runtime +
  WHISTLE_ASSET_BYTES.wasm +
  WHISTLE_ASSET_BYTES.model;

function wordPreset(terms: readonly string[]): string {
  const seen = new Set<string>();
  return terms
    .flatMap((term) => term.split(/[\s,]+/u))
    .filter((word) => {
      const key = word.toLowerCase();
      if (!/[\p{L}\p{N}]/u.test(word) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n");
}

const WHISTLE_NAMES = [
  "Deniss",
  "Muhla",
  "IF",
  "P&C",
  "Insurance",
  "Insurance",
  "Stream",
  "Labs",
  "Geidans",
  "Solutions",
  "DiatomEnterprises",
  "Leaselink",
  "MultiProbe",
  "Latvia",
  "Riga",
  "Daugavpils",
  "EU",
  "GitHub",
  "Copilot",
  "Microsoft",
  "Certified",
  "Professional",
  "MCPD",
  "Web",
  "Developer",
  "IELTS",
  "General",
  "Training",
] as const;

const WHISTLE_TERMS = [
  "Senior Front-end Engineer",
  "Senior Front-end JavaScript Application Developer",
  "Senior Front-end Developer",
  "Team Lead",
  "Tech Lead",
  "Software Developer",
  "System Integration Engineer",
  "JavaScript",
  "TypeScript",
  "React",
  "Web Components",
  "Vite",
  "HTML",
  "CSS",
  "Node.js",
  "C#",
  ".NET",
  "Framework",
  "Lit",
  "Next.js",
  "Redux",
  "redux-saga",
  "MS",
  "SQL",
  "SQL",
  "Server",
  "Agent",
  "Git",
  "GitLab",
  "Jira",
  "TFS",
  "Azure",
  "DevOps",
  "Docker",
  "Cypress",
  "BrowserStack",
  "Package",
  "managers",
  "design",
  "systems",
  "design-system",
  "UI",
  "scalable",
  "architecture",
  "component",
  "developer",
  "experience",
  "skills",
  "MCP",
  "LLM",
  "context",
  "orchestration",
  "agentic",
  "coding",
  "AI-assisted",
  "engineering",
  "workflows",
  "product",
  "delivery",
  "technical",
  "leadership",
  "cross-team",
  "communication",
  "collaboration",
  "maintainability",
  "architecture",
  "integration",
  "API",
  "services",
  "service",
  "refactoring",
  "release",
  "processes",
  "functional",
  "tests",
  "regressions",
  "delivery",
  "under",
  "constraints",
] as const;

const WHISTLE_FACT_TAG_TERMS = facts.cards.flatMap((card) => card.tags);

/**
 * Deliberate owner-requested manual presets of unique newline-separated words. These only
 * supply local-engine biasing; they do not change capture, selection or gating, or claim
 * improved recognition. Select `.names`, `.medium` or `.full` in WHISTLE_KEYWORDS below.
 */
export const WHISTLE_KEYWORD_PRESETS = Object.freeze({
  names: wordPreset(WHISTLE_NAMES),
  medium: wordPreset([...WHISTLE_NAMES, ...WHISTLE_TERMS]),
  full: wordPreset([
    ...WHISTLE_NAMES,
    ...WHISTLE_TERMS,
    ...WHISTLE_FACT_TAG_TERMS,
  ]),
});

export const WHISTLE_KEYWORDS = WHISTLE_KEYWORD_PRESETS.full;

/** The one language the site transcribes. */
export const WHISTLE_LANGUAGE = "en";
