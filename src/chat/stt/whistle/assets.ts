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
  "Baltics",
  "Certified",
  "Copilot",
  "Daugavpils",
  "Denis",
  "Developer",
  "DiatomEnterprises",
  "EU",
  "Geidans",
  "General",
  "GitHub",
  "IELTS",
  "IF",
  "Insurance",
  "Labs",
  "Latvia",
  "Leaselink",
  "LinkedIn",
  "Linux",
  "MCPD",
  "MCPS",
  "Microsoft",
  "Muhla",
  "MultiProbe",
  "P&C",
  "Professional",
  "Riga",
  "Scandinavia",
  "Solutions",
  "Stream",
  "Training",
  "Web",
] as const;

const WHISTLE_TERMS = [
  ".NET Framework",
  "Accessibility",
  "Agent",
  "Agentic",
  "Agile",
  "AI-assisted coding",
  "Algorithms",
  "Angular",
  "API",
  "Application development",
  "Architecture",
  "Authentication",
  "Authorization",
  "Automated testing",
  "Automation",
  "Azure DevOps",
  "Back-end development",
  "Back-end",
  "Branch",
  "Browser performance",
  "Browser",
  "BrowserStack",
  "Build system",
  "bun",
  "Bundler",
  "C#",
  "C++",
  "Caching",
  "CI/CD",
  "Cloud computing",
  "Code review",
  "Codebase",
  "Coding agents",
  "Coding",
  "Collaboration",
  "Commit",
  "Component architecture",
  "Constraints",
  "Containerization",
  "Context",
  "Continuous delivery",
  "Continuous integration",
  "Cross-team communication",
  "CSS",
  "Cypress",
  "Data structures",
  "Database",
  "Debugging",
  "Delivery",
  "Deployment",
  "Design patterns",
  "Design system",
  "Developer tools",
  "DevOps",
  "Docker",
  "Encryption",
  "End-to-end testing",
  "Framework",
  "Front-end development",
  "Front-end",
  "Full-stack",
  "Functional programming",
  "Git",
  "GitHub",
  "GitLab",
  "Go",
  "GraphQL",
  "HTML",
  "HTTP",
  "Integration tests",
  "Java",
  "JavaScript",
  "Jira",
  "JSON",
  "Kanban",
  "Kubernetes",
  "Library",
  "Lit",
  "LLM",
  "Logging",
  "Maintainability",
  "MCP",
  "Microservices",
  "Monitoring",
  "MS SQL",
  "Next.js",
  "Node.js",
  "npm",
  "Object-oriented programming",
  "Observability",
  "Orchestration",
  "Package manager",
  "Performance",
  "PHP",
  "pnpm",
  "Product",
  "Programming",
  "Pull request",
  "Python",
  "QA",
  "Quality assurance",
  "React",
  "redux-saga",
  "Redux",
  "Refactoring",
  "Regression testing",
  "Release process",
  "Repository",
  "Responsive design",
  "REST API",
  "Reusable components",
  "Runtime",
  "Rust",
  "Scalability",
  "Scrum",
  "SDLC",
  "Security",
  "Senior Front-end Developer",
  "Senior Front-end Engineer",
  "Senior Front-end JavaScript Application Developer",
  "Server",
  "Service",
  "Software architecture",
  "Software Developer",
  "Software development life cycle",
  "Software development",
  "Software engineering",
  "Source code",
  "SQL Server Agent",
  "SQL Server",
  "SQL",
  "Svelte",
  "System design",
  "System Integration Engineer",
  "System integration",
  "Team Lead",
  "Tech Lead",
  "Technical leadership",
  "Terraform",
  "Test automation",
  "Testing",
  "TFS",
  "TypeScript",
  "UI",
  "Unit tests",
  "UX",
  "Version control",
  "Vite",
  "Vue",
  "Web application",
  "Web Components",
  "Web development",
  "Workflows",
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
