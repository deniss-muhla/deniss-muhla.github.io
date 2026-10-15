# Assistant runtime contracts

## Local processing and module boundaries

The assistant runs in the browser: Whistle recognizes speech, the retrieval encoder embeds
questions for matching against the reviewed index, and the answer-audio player fetches and
decodes prerecorded v2 MP3 references. No hosted prompt or runtime answer generation is used.
Questions and microphone input stay on-device; initial asset/model downloads still need a
network connection. Whistle and the embedding runtime run single-threaded and do not require
`SharedArrayBuffer`. Speech input needs a secure context (HTTPS or localhost) and permission.

Keep vendor objects, types and resource lifecycles behind project-owned boundaries:

- `src/chat/stt/whistle` owns the pinned speech adapter/worker, not components.
- `src/chat/retrieval/encoder` owns `@huggingface/transformers` and `onnxruntime-web` imports.
  Application/UI code must not import those packages. A model swap must not require UI edits.
- `src/chat/retrieval` selects a prepared answer from `resources/cv/facts.json`; the encoder
  embeds one trimmed question in a module worker. Stored vectors have 384 dimensions.
- The engine coordinates model loading, progress, selection, playback and interruption.
  Speech recognition, retrieval and speech output have focused modules; do not move their
  resource ownership into components. Components own presentation/interaction state only.
- `src/chat/answer-audio.ts` owns clip fetch/decode and accepts only source/text-bound v2
  references. Immutable message plans bind Replay/autoplay to the visible message; no TTS
  fallback or fresh retrieval on Replay is allowed. Valid stored-plan/cache reuse is expected;
  fresh-generation and whole-corpus installation rules belong to the audio pipeline.

Organize functionality under `src/chat`, `src/offline` and `src/page`, not generic type folders.
Use explicit project-owned progress/state types across boundaries and narrow vendor adapters.

## Consent and turn lifecycle

An explicit opener click or keyboard action opens/reopens unmuted live voice. Its name and
tooltip identify microphone and audio intent. This fresh consent action resumes audio, starts
STT/microphone capture and speaks the stored greeting once through the guarded voice-start
path. Page load while closed does not resume audio, request the microphone or autoplay.
There is no mode picker or text Enable/Continue step. Typing is immediately usable during
loading, permission and startup, and when live voice or semantic matching fails. Safe notices
distinguish input and audio failures. Typed and spoken questions use the same retrieval and
turn cleanup; typed answers follow current audio consent/mute, not a separate typed mode.
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

The player preserves decoded samples and adds zero-filled padding: 120 ms before and 200 ms
after, plus finite positive browser `baseLatency` and `outputLatency` on each side. Unsupported
readings retain the minimum padding. Padding neither changes clip bytes nor fixes missing
recognition/audio or endpoint splits.

During actual prerecorded playback, onset pauses output while capture stays live. After
200 ms, continuation requires the latest received 20-ms frame to have RMS at least 0.008
and receipt age 0–20 ms inclusive. Continued activity stops the paused reply and admits the
complete retained pre-roll/opening window once. Quiet, absent or stale activity rejects the
burst: no question, the same source position/clip order resumes and microphone capture stays
live. Idle/preparing/inference onset interrupts immediately. Ordinary 80-ms onset, one-second
quiet end and basic browser echo cancellation are unchanged. Cancel/close/mute/reset must
invalidate late resume/start/tail work.

Microphone capture and speech output own separate AudioContexts. Suspending output must not
suspend input. Confirmed admission delivers the retained prefix once, in order, through decoder
calls of at most 16,000 samples; do not decode quiet pre-roll separately or duplicate the opening.
Flush the bounded decoder remainder and stop-reply tail before utterance-end; stale acoustic
owners may drain for cleanup but must not commit text or restart output.

Natural final-clip end preserves a current captured admission, but cannot resume ended playback.
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

Kitten is external preparation only. The [stage command](audio-pipeline.md) requires explicit
pinned facts/runtime/stage/workspace inputs and never loads Vite/CV generation or writes public
audio. Runtime models, caches and weights stay outside Git.

## Cache and recovery ownership

`public/sw.js` alone owns service-worker header injection, cache naming/pruning and offline
fallback. Do not add recovery reload logic there or in application code: `public/sw-register.js`
owns recovery for first control and Chrome's offline reload, removes its cache-busting `?coi=`
parameter after isolation and limits reloads to three per tab session. The worker is skipped
on localhost unless `?sw=1` is present.

The worker caches the app shell, same-origin assets, Google Fonts and retrieval ONNX Runtime. Whistle's
`needle-models-v1` cache and the embedding owner's Cache Storage entry cache their models;
the worker must not duplicate these downloads. After shell load, it warms the complete
validated audio manifest and content-hashed clips in a dedicated cache, separate from shared
asset eviction. Observed verified counts/bytes drive progress and Ready, not completed jobs.

Data Saver skips automatic audio warming. Incomplete/error/offline states stay visible with
retry/reconnection fetching only missing clips; valid completed clips remain. Completion has
a concise accessible hint, not a verbose visible count row. All reviewed clips are verified
before Ready, without needing to play them online first. Audio Ready alone does not mean the
shell, retrieval model or speech runtime is cached. Offline acceptance must exercise the
controlled reload and needed models, not infer readiness from one cache.

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
