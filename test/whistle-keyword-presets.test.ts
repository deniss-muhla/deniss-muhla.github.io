import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  WHISTLE_KEYWORDS,
  WHISTLE_KEYWORD_PRESETS,
} from "../src/chat/stt/whistle/assets.ts";

const normalize = (value: string): string => value.trim().toLowerCase();
const lines = (preset: string): string[] => preset.split("\n");
const selectedPreset = (["names", "medium", "full"] as const)
  .find((name) => WHISTLE_KEYWORDS === WHISTLE_KEYWORD_PRESETS[name]);

test("installed tag phrases become unique keyword words without changing technical tokens", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "whistle-fact-tags-"));
  try {
    const modulePath = path.join(workspace, "src/chat/stt/whistle/assets.ts");
    const factsPath = path.join(workspace, "resources/cv/facts.json");
    await mkdir(path.dirname(modulePath), { recursive: true });
    await mkdir(path.dirname(factsPath), { recursive: true });
    await writeFile(modulePath, await readFile(new URL("../src/chat/stt/whistle/assets.ts", import.meta.url)));
    await writeFile(factsPath, JSON.stringify({
      cards: [{ tags: [
        " Synthetic\treviewed tag ", "synthetic REVIEWED tag",
        " C#\t.NET\nNode.js front-end ", "Latvia, EU", " / - , ", "", "   ",
      ] }],
    }));

    const isolated = await import(pathToFileURL(modulePath).href) as typeof import("../src/chat/stt/whistle/assets.ts");
    const full = lines(isolated.WHISTLE_KEYWORD_PRESETS.full);
    for (const word of ["Synthetic", "reviewed", "tag"]) {
      assert.ok(full.includes(word), "full follows new facts-tag words without a preset source edit");
      assert.equal(full.filter((term) => normalize(term) === normalize(word)).length, 1);
    }
    const firstNewWord = full.indexOf("Synthetic");
    assert.deepEqual(full.slice(firstNewWord, firstNewWord + 3), ["Synthetic", "reviewed", "tag"], "first spelling and word order are preserved");
    for (const word of ["c#", ".net", "node.js", "front-end", "latvia", "eu"]) {
      assert.equal(full.filter((term) => normalize(term) === word).length, 1, `${word} stays intact and unique`);
    }
    assert.ok(full.every((word) => !/[\s,]/u.test(word) && /[\p{L}\p{N}]/u.test(word)), "empty and punctuation-only separators are not keywords");
    assert.equal(isolated.WHISTLE_KEYWORD_PRESETS.names, WHISTLE_KEYWORD_PRESETS.names);
    assert.equal(isolated.WHISTLE_KEYWORD_PRESETS.medium, WHISTLE_KEYWORD_PRESETS.medium);
    assert.ok(selectedPreset, "the active keywords select a named manual preset");
    assert.equal(isolated.WHISTLE_KEYWORDS, isolated.WHISTLE_KEYWORD_PRESETS[selectedPreset]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("manual Whistle word presets are newline-safe subsets and cover current fact-tag words", async () => {
  const names = lines(WHISTLE_KEYWORD_PRESETS.names);
  const medium = lines(WHISTLE_KEYWORD_PRESETS.medium);
  const full = lines(WHISTLE_KEYWORD_PRESETS.full);
  const nameSet = new Set(names.map(normalize));
  const mediumSet = new Set(medium.map(normalize));
  const fullSet = new Set(full.map(normalize));

  for (const preset of [names, medium, full]) {
    assert.ok(preset.every((word) => word.length > 0 && !/\s/u.test(word)), "one word per line");
    assert.equal(new Set(preset.map(normalize)).size, preset.length, "case-folded terms are unique");
  }
  assert.ok([...nameSet].every((term) => mediumSet.has(term)));
  assert.ok([...mediumSet].every((term) => fullSet.has(term)));
  assert.ok(medium.length < full.length);
  assert.ok(selectedPreset, "names, medium and full remain manually selectable");
  assert.equal(WHISTLE_KEYWORDS, WHISTLE_KEYWORD_PRESETS[selectedPreset]);

  for (const required of [
    "Deniss", "Denis", "Muhla", "IF", "P&C", "Insurance", "Stream", "Labs",
    "Geidans", "Solutions", "DiatomEnterprises", "Leaselink", "MultiProbe",
  ]) assert.ok(nameSet.has(normalize(required)), `missing required proper-name word: ${required}`);
  for (const required of [
    "Latvia", "Riga", "Daugavpils", "Scandinavia", "Baltics", "EU", "GitHub", "LinkedIn",
    "Copilot", "Microsoft", "MCPS", "MCPD", "IELTS", "Certified", "Professional",
    "Web", "Developer", "General", "Training", "Linux",
  ]) assert.ok(nameSet.has(normalize(required)), `missing CV name: ${required}`);
  for (const required of [
    "software", "development", "engineering", "programming", "front-end", "back-end",
    "full-stack", "JavaScript", "TypeScript", "React", "Node.js", "HTML", "CSS", ".NET",
    "SQL", "API", "REST", "GraphQL", "database", "version", "control", "repository",
    "CI/CD", "deployment", "unit", "integration", "testing", "debugging", "refactoring",
    "architecture", "component", "accessibility", "security", "Docker", "Git", "Agile",
    "algorithms", "data", "structures", "system", "design", "SDLC", "QA", "monitoring",
    "authentication", "authorization", "Kubernetes", "Python", "Java", "C++", "Go", "Rust",
  ]) assert.ok(mediumSet.has(normalize(required)), `missing software development term: ${required}`);
  assert.ok(["email", "address", "phone"].every((word) => !nameSet.has(word)));
  assert.ok(!names.some((term) => term.includes("@") || /https?:\/\//i.test(term)));

  const facts = JSON.parse(await readFile(new URL("../resources/cv/facts.json", import.meta.url), "utf8")) as {
    cards: { tags?: string[] }[];
  };
  const tagWords = new Set(facts.cards.flatMap((card) => card.tags ?? [])
    .flatMap((tag) => tag.split(/[\s,]+/u)).map(normalize).filter((word) => /[\p{L}\p{N}]/u.test(word)));
  assert.ok([...tagWords].every((word) => fullSet.has(word)), "full covers the words in current facts.cards[].tags");

  const loader = await readFile(new URL("../src/chat/stt/whistle/loader.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/chat/stt/whistle/worker.ts", import.meta.url), "utf8");
  assert.match(loader, /keywords:\s*WHISTLE_KEYWORDS/);
  assert.match(worker, /keywords\s*=\s*message\.keywords/);
  assert.match(worker, /\[pcm,\s*samples\.length,\s*language\s*\|\|\s*null,\s*keywords\s*\|\|\s*null,\s*out,\s*OUT_CAP\]/);
});
