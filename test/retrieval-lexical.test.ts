/**
 * The labeled lexical fallback.
 *
 * The rule is strict on purpose: a card is returned only when it covers every meaningful
 * term of the question, so an inadequate match is a rephrase request rather than the
 * closest wording that happened to share a word.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { findLexicalMatch } from "../src/chat/retrieval/lexical.ts";
import { syntheticIndex } from "./retrieval-fixtures.ts";

test("a question whose words appear in topic, tags or answer finds that card", () => {
  const index = syntheticIndex();

  assert.equal(findLexicalMatch(index, "calendar")?.cardId, "synthetic-calendar");
  assert.equal(findLexicalMatch(index, "scheduling")?.cardId, "synthetic-calendar");
  assert.equal(findLexicalMatch(index, "ledger")?.cardId, "synthetic-ledgers");
  assert.equal(findLexicalMatch(index, "codecs")?.cardId, "synthetic-codecs");
});

test("match words are found in the topic, the tags and the answer alike", () => {
  const index = syntheticIndex();

  // `scheduling` is a tag only, `codecs` appears in the topic and the answer.
  assert.equal(findLexicalMatch(index, "scheduling")?.cardId, "synthetic-calendar");
  assert.equal(findLexicalMatch(index, "codecs")?.cardId, "synthetic-codecs");
  assert.equal(findLexicalMatch(index, "audio")?.cardId, "synthetic-codecs");
});

test("punctuation and case do not change the outcome", () => {
  const index = syntheticIndex();

  assert.equal(findLexicalMatch(index, "  CALENDAR, scheduling!  ")?.cardId, "synthetic-calendar");
});

test("an incomplete match is not a limited match", () => {
  const index = syntheticIndex();

  // Every one of these terms must be covered; none of them is.
  assert.equal(findLexicalMatch(index, "calendar payments"), null);
  assert.equal(findLexicalMatch(index, "ledger codec calendar"), null);
  assert.equal(findLexicalMatch(index, "kubernetes"), null);
});

test("a question of only question words and stopwords finds nothing", () => {
  const index = syntheticIndex();

  assert.equal(findLexicalMatch(index, "what is it"), null);
  assert.equal(findLexicalMatch(index, "where did he work"), null);
  assert.equal(findLexicalMatch(index, ""), null);
  assert.equal(findLexicalMatch(index, "  ?  "), null);
});

test("matching is deterministic when several cards cover the question", () => {
  const index = syntheticIndex();

  // "synthetic" is in every fixture answer, so the id order decides; it must not vary.
  assert.deepEqual(
    [0, 1, 2].map(() => findLexicalMatch(index, "synthetic")?.cardId),
    ["synthetic-calendar", "synthetic-calendar", "synthetic-calendar"],
  );
});

test("the matched terms are reported for the returned card", () => {
  const match = findLexicalMatch(syntheticIndex(), "synthetic audio codecs");

  assert.equal(match?.cardId, "synthetic-codecs");
  assert.deepEqual(match?.matchedTerms, ["synthetic", "audio", "codecs"]);
});