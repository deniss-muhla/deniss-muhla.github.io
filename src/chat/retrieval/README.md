# Retrieval

Selecting a prepared answer for a visitor's question. Everything in `src/chat/retrieval`
reads `resources/cv/facts.json`; nothing here writes, rewrites or summarizes an answer, and
nothing here embeds the CV into a prompt.

## Modules

- `index.ts` validates the imported artifact into `ReviewedIndex` and refuses an identity,
  dimension or vector it cannot verify. `reviewed-index.ts` holds the one normal Vite import
  and reads it once.
- `scoring.ts` embeds nothing. It takes one query vector and returns every card with its
  cosine, ranked by score then card id. There is no keyword or alias pre-filter, so the
  caller sees the full candidate set.
- `selection.ts` applies the relevance floor, the confidence threshold and the margin in the
  order of design decision 9. The three constants are calibrated once against the named
  synthetic cases from the external probe and are recorded next to them.
- `lexical.ts` is the fallback for loading and failed states. It matches words in a card's
  topic, tags and answer and requires full term coverage, so a partial overlap asks for a
  rephrase instead of answering.
- `controller.ts` joins the two paths. It receives an encoder per call and never creates one,
  which is what lets the engine decide when a model request is allowed. Only the current
  request may update pending clarification choices; superseded and cancelled work is not a
  lexical failure. It also keeps the conversation's last answered card: an ordinal that
  names a reviewed topic word (`second workplace`) picks that position of the topic group
  straight from the index without an embedding, and a question of at most three tokens
  embeds with the last answered topic appended. Both need a previous answered turn;
  without one the question takes the ordinary path unchanged, and an ordinal past the end
  of its group asks for a rephrase instead of offering a choice with no score.
- `errors.ts` holds `RetrievalError`, whose reason is this module's own vocabulary and never
  an index value.

## `encoder/`

The query side of the index, and the only place that knows the embedding library exists.

- `client.ts` is the page's handle on the worker. Construction is free: no worker exists and
  no request is made until `load` or `embed` is called, which is how a metered session can
  choose never to load. `embed` satisfies the controller's `QuestionEncoder` seam. A new
  question supersedes the pending one, and a result that arrives for it afterwards is
  discarded rather than rendered. A retry after a failed load ends the failed worker and asks a
  fresh one, because the library's rejected session-initialisation chain stays rejected for the
  life of a worker, and anything the ended worker still says is ignored.
- `worker.ts` runs inference in one module worker so the page stays responsive. It requests
  the pinned model at its literal revision, dtype `q8`, on single-threaded WebAssembly with
  no proxy worker and no GPU, and it refuses a question over the 256-token cap instead of
  truncating it. It is the only module in the project that imports
  `@huggingface/transformers`, and it silences that library's console with its public
  `env.logLevel`, because a failed inference would otherwise print the visitor's own tokenized
  question.
- `protocol.ts` is the boundary. Plain structured-cloneable data both ways, validated on
  arrival, with classified reasons instead of vendor messages. A request carries one trimmed
  question and nothing else, so no card vector can be generated here.
- `pooling.ts` is the pinned pooling and the model-identity guards, as pure functions so the
  browser-free suite can run them. It mirrors the generator's masked mean pooling and
  normalization; `test/retrieval-encoder-pooling.test.ts` runs both over the same input so the
  copies cannot drift.
- `runtime-assets.ts` records the pinned `onnxruntime-web` version, the two runtime files with
  their digests, the same-origin route that serves them and the single-thread settings. The
  `onnxruntime-assets-serve` and `onnxruntime-assets-build` plugins in `vite.config.ts` are the
  only writers of that route; nothing else serves those files.

The model files are fetched from the pinned Hugging Face commit, not from this repository.
The browser cache keeps them across visits, so a warm load re-requests no model bytes.

## Answer kinds

`controller.ask` returns one of:

- `answer` with `matching: "semantic"` or `matching: "limited"`, the latter carrying a
  `limitedCause`. The chat labels a limited answer; the module never reports readiness.
- `clarify` with at most two offered `cardId` values. `chooseClarification` resolves one of
  them without a second embedding, and any new question drops the pending choice.
- `rephrase`, and `ask-question` for empty input.
- `shorten` with the classified `query/too-long` reason, so the chat can request a shorter
  question without treating it as an embedding failure.
- `cancelled` for cancelled embedding work and `superseded` when a newer question replaces
  an in-flight request. Neither result carries a prepared answer.

`WEAK_MATCH_CUE` is the uncertainty prefix for a weak semantic match. It is returned
separately so the prepared answer text is served unchanged.

## Checking the encoder in a real browser

`node scripts/voice-qa.mjs --qa=retrieval --routing=dev` and `--routing=built` drive a private page in
headed Chrome, in both routings the site ships. Running `node scripts/retrieval-qa.mjs --routing=dev`
directly calls the same run. The built run needs
`RETRIEVAL_QA=1 pnpm build` first, because a production build only includes that page when it
is asked for. The run embeds one sampled input, then the frozen synthetic cases from the
accepted external probe, and reports only case ids, card ids, scores, dimensions, norms,
timings, digests and outcomes. The probe workspace path comes from `PROBE_DIR`; the browser
profile, both servers and the report stay outside the repository.

The built routing also proves the runtime delivery cache. It reads Cache Storage for the two
`/ort/` files and reports the cache name, the stored status, headers, byte count and SHA-256 of
each, then replays those two URLs with the browser context offline and records the bytes and
digest that come back, the isolation headers they carry and whether a controller was present.
The gate compares the stored bytes with the digests in `runtime-assets.ts` and with the bytes
this browser consumed, and it fails on a missing entry, a wrong size or digest, an unisolated
or unanswered replay, or a missing controller. Stored `cache-control` is recorded but never
judged, because the worker re-adds the isolation headers when it serves a stored response. The
replay is its own phase, counted separately from the encoder load and from query timings, and it
covers two cached runtime files only: it says nothing about offline model weights, the chat path
or speech. An earlier gate asked the page's headers object for a resource-timing field it never
carried, which failed every built run for a reason unrelated to the cache;
`test/retrieval-qa-cache.test.ts` pins the byte-based gate, including that input, with synthetic
records.

The run's own final gate judges what the workload reported, not only what it recorded. Every
guard has to refuse, the older of two superseding questions has to have lost with
`embed/superseded`, and the newer one has to have produced the producer's own `resolved`, so a
failed, superseded or unreported outcome fails the run. Each answer path has to report the
metadata its own purpose produces: the loaded controller probe a semantic match, and the
null-encoder lexical probe a limited match that names `model-unavailable`. Metadata that is well
formed but belongs to the other path is refused as well as metadata that is malformed or absent.
`test/retrieval-qa-orchestration.test.ts` drives these through the run's own report and gate.
