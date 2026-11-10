# Assistant runtime contracts

## Local processing and module boundaries

The assistant runs in the browser: Whistle recognizes speech, the retrieval encoder embeds
questions for matching against the reviewed index, and Paradee v1.1 synthesizes speech in a separate module worker. No hosted prompt or runtime answer generation is used.
Questions and microphone input stay on-device; initial asset/model downloads still need a
network connection. Whistle and the embedding runtime run single-threaded and do not require
`SharedArrayBuffer`. Speech input needs a secure context (HTTPS or localhost) and permission.

Keep vendor objects, types and resource lifecycles behind project-owned boundaries:

- `src/chat/stt/whistle` owns the pinned speech adapter/worker, not components.
- `src/chat/retrieval/encoder` owns the embedding runtime; `src/chat/tts/paradee` owns the
  Paradee ONNX runtime and phonemizer. Application/UI code must not import vendor packages.
- `src/chat/retrieval` selects a prepared answer from `resources/cv/facts.json`; the encoder
  embeds one trimmed question in a module worker. Stored vectors have 384 dimensions.
- The engine coordinates model loading, progress, selection, playback and interruption.
  Speech recognition, retrieval and speech output have focused modules; do not move their
  resource ownership into components. Components own presentation/interaction state only.
- The Paradee adapter synthesizes the text in immutable message plans without fetching clips.
  Replay uses the stored plan without another retrieval. Failed synthesis surfaces an error and
  never falls back to another voice. The older clip player is not used by the default engine.

Organize functionality under `src/chat`, `src/offline` and `src/page`, not generic type folders.
Use explicit project-owned progress/state types across boundaries and narrow vendor adapters.

Whistle's manual `names`, `medium` and `full` keyword presets split phrase terms on whitespace
and commas, then emit one word per line. Deduplication ignores case and preserves the first
spelling and order. Punctuation-only separators are omitted; technical tokens such as `C#`,
`.NET`, `Node.js` and `front-end` stay intact. `WHISTLE_KEYWORDS` selects the desired preset in
`src/chat/stt/whistle/assets.ts`; reload the page to apply changes to a fresh speech runtime.
These hints do not change retrieval or establish improved recognition.

## Consent and turn lifecycle

An explicit opener click or keyboard action opens/reopens unmuted live voice. Its name and
tooltip identify microphone and audio intent. This fresh consent action resumes audio, awaits
Paradee preparation, starts STT/microphone capture and speaks the stored greeting once through
the guarded voice-start path. If speech preparation fails, voice startup reports the failure and
typing remains available. Page load while closed does not resume audio, request the microphone or autoplay.
There is no mode picker or text Enable/Continue step. Typing is immediately usable during
loading, permission and startup, and when live voice or semantic matching fails. Safe notices
distinguish input and audio failures. Typed submissions use the existing answer flow. Live typed and spoken drafts instead request up
to three suggestions immediately from the reviewed index, without waiting for the encoder. Ranking
prioritizes keys (tags), then topic, then answer; within each field exact tokens precede prefixes
and fuzzy matches. Workplace, employment and ordinal query aliases match within those same fields,
weaker than literal exact matches and without promoting any particular card. When the encoder is ready, semantic scores can break lexical ties after a quiet
period. A single voice candidate is read after 400 ms. New input cancels pending suggestions and speech.
A completed voice entry with at least three letters or digits and one eligible candidate is spoken automatically; otherwise selecting a
suggestion shows its answer and requests speech, subject to mute.
Without audio approval, answers stay silent while retaining their stored Replay plan.

The greeting offers three distinct randomly sampled reviewed fact topics in the message area,
using the existing choice buttons (fewer only when fewer distinct topics are available). The
controller samples once per conversation; renders, progress, mute, greeting playback and an
unchanged close/reopen retain that offer. New chat may sample again. Selecting a starter or
starting a typed/spoken question dismisses starters. Lazy index completion cannot restore a
stale offer or replace newer clarification choices; unavailable topics leave typing usable.
Topic offers load only the reviewed index, not a model, microphone or speech output. The
engine/controller validates the exact offered card through the existing choice boundary,
without a score, another retrieval or variant selection. Its verbatim answer, source navigation
and immutable message-bound audio/Replay plan follow the ordinary selected-answer flow and
current consent/mute policy. Ordinary ambiguity still offers at most two scored choices.

Answer navigation uses the selected card's source ranges and the rendered CV heading positions.
It prefers the first cited content section (h2-h4), preserving source-reference order. A shared
name/title citation (h1) is only a fallback for identity/contact-only answers, not the primary
jump target when content is cited. If the selected content anchor is missing, do not jump to
the title or an unrelated section. Navigation does not reorder stored citations or change facts.

New chat clears messages, drafts, choices/retry and retrieval context, then repeats the intro
once in the retained mode/consent. Typed or muted resets stay silent. Already-consented,
unmuted live resets may restart capture and speak the intro after old-tail/currentness cleanup.
New chat never unmutes or silently switches mode. Closing stops capture/playback and invalidates
pending work; the next explicit opener action supplies fresh live-voice consent.

The inactive footer icon enables voice. Live/pending startup and pending/active typed Replay
expose master mute. Mute stops capture/output, invalidates late starts and blocks Replay while
keeping typing available. Explicit footer enable or opening/reopening restores unmuted live
voice through consent; reset alone never does. Unmuted Replay uses the exact stored plan
without another retrieval, even when live audio approval is absent.
New chat, Replay (play), Send and voice controls are accessible icon buttons with tooltips,
visible keyboard focus, decorative SVGs and targets of at least 44px.

Background model downloads are an owner-requested exception to explicit user initiation.
They must keep the page usable, respect metered connections and remain visible/cancellable
in effect. Report actual library lifecycle progress, not invented timer estimates. Distinguish
loading, ready, listening, thinking, speaking, failed and offline states. Render warnings where
a visitor can act on them. `?voiceDebug=1` is the diagnostic trace surface, not permission to
log secrets, raw transcripts/answers or unsafe model internals.

## Playback and interruption

The player attenuates waveform peaks above 0.8 to reduce clipping and acoustic leakage, without
boosting quieter audio. It rejects non-finite samples and adds zero-filled padding: 120 ms before and 200 ms
after, plus finite positive browser `baseLatency` and `outputLatency` on each side. Unsupported
readings retain the minimum padding. Padding does not fix missing recognition/audio or endpoint splits.

During generated playback, onset pauses output while capture stays live. After
200 ms, continuation requires the latest received 20-ms frame to have RMS at least 0.008
and receipt age 0–20 ms inclusive. Continued activity remains held until the utterance has
accumulated 450 ms of voiced frames, including across short pauses. The player can also hold
pending synthesis before a source exists. Quiet, absent, stale or sub-threshold activity rejects
the burst without decoder work or a question; the same source position resumes and capture
stays live. A qualifying utterance interrupts the reply and releases the retained pre-roll and
opening once. The 80-ms acoustic onset, one-second quiet end and basic browser echo cancellation
are unchanged. A finalized transcript with fewer than three letters or digits is silently discarded.
Cancel/close/mute/reset must invalidate late resume/start/tail work.

Microphone capture and speech output own separate AudioContexts. Suspending output must not
suspend input. Confirmed admission delivers the retained prefix once, in order, through decoder
calls of at most 16,000 samples; do not decode quiet pre-roll separately or duplicate the opening.
Flush the bounded decoder remainder and stop-reply tail before utterance-end; stale acoustic
owners may drain for cleanup but must not commit text or restart output.

Natural playback end preserves a current captured admission, but cannot resume ended playback.
Explicit cancellation invalidates the admission instead. Suspend/resume failures route through
a safe playback-specific notice, not a recognizer/vendor error dump or loss of the chosen answer
text. Keep failure/currentness ownership separate from normal end and from master mute/close.

This owner-accepted duration heuristic is not noise identification or proof of echo removal.
It may reject short real words or accept longer noise; scheduling jitter, batched/stalled
delivery and natural gaps can misclassify activity. Receipt time is not acoustic capture time.
The owner still reports missing first words/half-words, more often during interruption but
also while idle; the cause is unknown and no fix is claimed. Keep those limits visible in
[manual acceptance](manual-testing.md), not hidden by phrase filtering or timing claims.

## Static routes and pinned delivery

Site-absolute routes assume deployment at the domain root. GitHub Pages cannot set HTTP
headers. COI is a standing page/header policy, not a requirement of these single-threaded
engines. Vite dev/preview set COOP/COEP directly; the service worker adds them to production
same-origin responses. Worker runtime routes must carry the same isolation/CORP policy as
the page. A noncompliant response can fail in a cross-origin isolated page even if its model
does not use shared memory.

`scripts/model-assets.mjs` pins routes, sizes, SHA-256, sources and licenses. The
`model-assets-serve`/`model-assets-build` plugins in `vite.config.ts` map `/models/` and
`/fonts/` to the verified external cache, serving in dev and emitting in the build. The
`onnxruntime-assets-serve`/`onnxruntime-assets-build` plugins own `/ort/` and emit the locked
package's recorded pair, never a floating CDN runtime. See [third-party assets](third-party.md).

`needle.js`, `needle.wasm` and `whistle.cact` must ship byte-identical to their pinned sources.
Never bundle, minify, patch them in place or serve them from `public/` (Vite refuses public
URLs imported from source). Record upstream fixes instead. The Whistle worker reads its own
Cache Storage first and loads `needle.js` with `importScripts`. When touching these assets,
verify actual served bytes in dev and built routing and retain a real fake-microphone
transcription through the pinned runtime, not only a copied inventory comparison.

Paradee generates speech locally at runtime. The prerecorded corpus and facts/audio pair guard
are not used. The facts check remains required. See the [audio pipeline](audio-pipeline.md)
for runtime and smoke-check limitations.

## Cache and recovery ownership

`public/sw.js` alone owns service-worker header injection, cache naming/pruning and offline
fallback. Do not add recovery reload logic there or in application code: `public/sw-register.js`
owns recovery for first control and Chrome's offline reload, removes its cache-busting `?coi=`
parameter after isolation and limits reloads to three per tab session. The worker is skipped
on localhost unless `?sw=1` is present.

The worker caches the app shell, same-origin assets, Google Fonts and retrieval ONNX Runtime. Whistle's
`needle-models-v1` cache and the embedding owner's Cache Storage entry cache their models;
the worker must not duplicate these downloads. Paradee owns a revisioned cache for its pinned
config, tokenizer and model. Its worker verifies size and SHA-256 both before storing and when
reading those assets, then initializes ONNX from verified bytes. Background prefetch prepares
speech beside retrieval, except under Data Saver; explicit chat opening starts deferred preparation.
Speech readiness follows successful preparation, and a failed cold offline load reports that speech
is unavailable while typing remains usable. The ORT runtime and bundled phonemizer worker use the
same-origin asset cache. A warm speech model alone does not establish full offline readiness:
the shell, retrieval and speech-recognition assets must also be available and tested after reload.

Protect service-worker lifecycle, `clients.claim()`, first controlled load and Chrome's offline
reload behavior at this boundary. Dev, cached production and plain static serving differ;
changes to runtime loading/serving need both dev and built checks.

## Page motion and readable chat

Page colors and hero spread use existing CSS colors/keyframes on one scroll animation.
Native scroll timelines own progress when supported; otherwise the existing scroll/rAF,
resize/load/ResizeObserver lifecycle drives a paused CSS clock through `--page-progress`.
Do not add a second listener, JS color engine, palette inventory or global polyfill. Reduced
motion suppresses decorative spread and smooth navigation; print disables the animation.
Chat's local native black/white contrast switch and fixed readable unsupported fallback are
deliberate, not a fading gray text palette. Verify emitted CSS, not source support alone.

[Development checks](development.md) and [manual procedures](manual-testing.md) define the
workloads. Build/source or narrow headless UI results do not prove physical microphone,
mobile, offline, pronunciation or licensing acceptance.
