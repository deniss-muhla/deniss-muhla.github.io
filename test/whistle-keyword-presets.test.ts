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

test("a new installed facts tag reaches full using the unchanged preset module", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "whistle-fact-tags-"));
  try {
    const modulePath = path.join(workspace, "src/chat/stt/whistle/assets.ts");
    const factsPath = path.join(workspace, "resources/cv/facts.json");
    await mkdir(path.dirname(modulePath), { recursive: true });
    await mkdir(path.dirname(factsPath), { recursive: true });
    await writeFile(modulePath, await readFile(new URL("../src/chat/stt/whistle/assets.ts", import.meta.url)));
    await writeFile(factsPath, JSON.stringify({
      cards: [{ tags: [" Synthetic reviewed tag ", "synthetic REVIEWED tag", "", "   "] }],
    }));

    const isolated = await import(pathToFileURL(modulePath).href) as typeof import("../src/chat/stt/whistle/assets.ts");
    assert.ok(lines(isolated.WHISTLE_KEYWORD_PRESETS.full).includes("Synthetic reviewed tag"), "full follows the new facts tag without a preset source edit");
    assert.equal(lines(isolated.WHISTLE_KEYWORD_PRESETS.full).filter((term) => normalize(term) === "synthetic reviewed tag").length, 1);
    assert.ok(lines(isolated.WHISTLE_KEYWORD_PRESETS.full).every((term) => term.length > 0 && term === term.trim()));
    assert.equal(isolated.WHISTLE_KEYWORD_PRESETS.names, WHISTLE_KEYWORD_PRESETS.names);
    assert.equal(isolated.WHISTLE_KEYWORD_PRESETS.medium, WHISTLE_KEYWORD_PRESETS.medium);
    assert.equal(isolated.WHISTLE_KEYWORDS, isolated.WHISTLE_KEYWORD_PRESETS.names);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("manual Whistle keyword presets are newline-safe subsets and cover current fact tags", async () => {
  const names = lines(WHISTLE_KEYWORD_PRESETS.names);
  const medium = lines(WHISTLE_KEYWORD_PRESETS.medium);
  const full = lines(WHISTLE_KEYWORD_PRESETS.full);
  const nameSet = new Set(names.map(normalize));
  const mediumSet = new Set(medium.map(normalize));
  const fullSet = new Set(full.map(normalize));

  for (const preset of [names, medium, full]) {
    assert.ok(preset.every((term) => term.length > 0 && term === term.trim()));
    assert.equal(new Set(preset.map(normalize)).size, preset.length, "case-folded terms are unique");
  }
  assert.ok([...nameSet].every((term) => mediumSet.has(term)));
  assert.ok([...mediumSet].every((term) => fullSet.has(term)));
  assert.ok(medium.length < full.length);
  assert.equal(WHISTLE_KEYWORDS, WHISTLE_KEYWORD_PRESETS.names, "default selects names only");

  for (const required of [
    "Deniss Muhla",
    "Denis Muhla",
    "IF P&C Insurance",
    "Stream Labs",
    "Geidans Solutions",
    "DiatomEnterprises",
    "Leaselink",
    "MultiProbe",
  ]) assert.ok(nameSet.has(normalize(required)), `missing required proper-name term: ${required}`);
  assert.ok(!nameSet.has("email address") && !nameSet.has("phone"));
  assert.ok(!names.some((term) => term.includes("@") || /https?:\/\//i.test(term)));

  const facts = JSON.parse(await readFile(new URL("../resources/cv/facts.json", import.meta.url), "utf8")) as {
    cards: { tags?: string[] }[];
  };
  const tags = new Set(facts.cards.flatMap((card) => card.tags ?? []).map(normalize).filter(Boolean));
  assert.ok([...tags].every((tag) => fullSet.has(tag)), "full preset covers every current facts.cards[].tags keyword");

  const loader = await readFile(new URL("../src/chat/stt/whistle/loader.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/chat/stt/whistle/worker.ts", import.meta.url), "utf8");
  assert.match(loader, /keywords:\s*WHISTLE_KEYWORDS/);
  assert.match(worker, /keywords\s*=\s*message\.keywords/);
  assert.match(worker, /\[pcm,\s*samples\.length,\s*language\s*\|\|\s*null,\s*keywords\s*\|\|\s*null,\s*out,\s*OUT_CAP\]/);
});
