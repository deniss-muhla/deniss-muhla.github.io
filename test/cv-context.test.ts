import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";
import { createServer } from "vite";

// Frozen instruction copy: intentional changes to the prompt must update this expectation explicitly.
const expectedInstructions = [
  "You are the voice assistant on Deniss Muhla's public CV website.",
  "Use only the CV facts below; never invent details and never mention anything that is not in the CV.",
  "Speak about Deniss in the third person and start the answer directly with 'He'.",
  "Answer in ONE short sentence of at most 25 words, as plain spoken text.",
  "Never use lists, numbers, headings, markdown, quotation marks or emoji.",
  "Do not repeat the question and do not add a preamble such as 'At If, Deniss does the following'.",
  "If the CV does not contain the answer, say in one sentence that it is not in the CV.",
  "The user message may come from speech recognition with missing punctuation; interpret it charitably.",
].join(" ");

// Historical, reviewed-public snapshot only. The canonical source remains the current CV.
const canonicalCvUrl = new URL("../resources/cv/source/cv.md", import.meta.url);
const snapshotUrl = new URL("./cv-context.public-cv.snapshot.md", import.meta.url);
const frozenCvSha256 = "93bc0ecaeafad56e0d199b8b634ea3d45b5636d3e3a603fdfe7f2bac2bd3fb92";

function assertCvSourceFresh(source: Buffer) {
  assert.equal(createHash("sha256").update(source).digest("hex"), frozenCvSha256);
}

async function loadPromptModule() {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, logLevel: "error" });
  try {
    return {
      module: await server.ssrLoadModule("/src/chat/cv-context.ts"),
      close: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

test("the raw canonical CV and historical snapshot match the frozen fingerprint", async () => {
  assertCvSourceFresh(await readFile(canonicalCvUrl));
  assertCvSourceFresh(await readFile(snapshotUrl));
});

test("the CV freshness check rejects a fact edit and trailing whitespace", async () => {
  const source = await readFile(canonicalCvUrl);
  assertCvSourceFresh(source);

  const factEdit = Buffer.from(source.toString("utf8").replace(/(?<=^# )\S+/m, "Changed"));
  assert.ok(!factEdit.equals(source), "simulated fact edit must change source bytes");
  assert.throws(() => assertCvSourceFresh(factEdit), assert.AssertionError);

  const trailingWhitespace = Buffer.concat([source, Buffer.from(" ")]);
  assert.ok(trailingWhitespace.toString("utf8").trim() === source.toString("utf8").trim(),
    "trailing-whitespace edit must leave normalized prompt text unchanged");
  assert.throws(() => assertCvSourceFresh(trailingWhitespace), assert.AssertionError);
});

test("the default production prompt matches frozen instructions and the complete historical CV", async () => {
  const { module: { buildPromptMessages }, close } = await loadPromptModule();
  try {
    const snapshot = (await readFile(snapshotUrl, "utf8")).trim();
    assert.ok(isDeepStrictEqual(buildPromptMessages("test question"), [
      { role: "system", content: `${expectedInstructions}\n\n--- CV ---\n${snapshot}` },
      { role: "user", content: "test question" },
    ]), "default prompt differs from frozen instructions and full historical snapshot");
  } finally {
    await close();
  }
});
