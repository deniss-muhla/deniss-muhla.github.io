# Development and checks

## Normal site commands

Run commands from the validated repository root. Use the locked pnpm version in
`package.json`; `.npmrc` disables peer auto-installation, including Oxlint's optional Vite+
integration. Normal Vite dev/build uses the CV artifact plugin and can refresh the derived
PDF. `cv:build` runs that pipeline explicitly, not answer/audio generation.

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test                 # browser-free unit tests
pnpm build                # typecheck, installed facts/audio checks, production build and CV/PDF
pnpm preview:site
```

`build:site` has the same checks/build as `build`. `test:browser` is an optional headless
fake-engine integration check, not microphone/model acceptance. Missing verified model/font
assets fail the build with setup guidance. `node scripts/fetch-model-assets.mjs` is a deliberate
network/setup command, not a read-only check; pinned assets remain in the external cache.
Do not download/setup models implicitly during a docs-only or model-free task.

For current chat interaction testing, the owner starts `pnpm dev` and uses its reported URL.
Explicit opening/reopening starts microphone/audio and unmuted live voice; closed page load
stays silent. Typing remains available during startup/failure and follows current audio
consent/mute. See the [owner checklist](manual-testing.md#owner-final-checklist). This dev path
is not production/offline acceptance and needs no retained preview on port 5192.

For CV edits, follow the [CV-update skill](../.github/skills/cv-update/SKILL.md), not just these
build commands. Offline checks do not author or source-review answers. For a restricted task
that forbids CV/PDF generation or serving, use the conditional isolated procedure in
[manual testing](manual-testing.md#restricted-artifact-checks).

## Choose checks for the changed boundary

Choose only checks relevant to the change; the recipes below are options, not a checklist
to run in full. Reuse matching existing evidence and state any unrun acceptance criteria.

Assess the criterion, likely regression and coverage gap before adding a test. Expected
outcomes must come from acceptance criteria, not copies of helper output. A bug regression
must fail before and pass after the fix. Keep valuable existing tests; a one-time docs/link
check does not need a shipping framework. Do not duplicate the full CV into test fixtures.

- Presentation/controls: `node --test test/page-motion.test.ts test/voicechat-lifecycle.test.ts test/cv-navigation.test.ts`.
  Inspect emitted CSS and actual browser scroll/reverse/resize, keyboard focus and compact layout.
- Facts shape/source/embedding identity: `pnpm cv:facts:check`; candidate options and author/review
  semantics belong to the [facts skill](../.github/skills/cv-facts/SKILL.md).
- Installed audio identities/bytes/coverage: `pnpm cv:audio:check`; it runs no model and writes nothing.
  External generation is only the [explicit stage](audio-pipeline.md#external-kitten-stage).
- Streaming: exercise interim transcripts, several updates before a render and delayed consumption,
  not just a large final value. Keep typed/live selection and cleanup parity under consent.
- Runtime asset changes: verify both Vite dev and built/static delivery, actual emitted bytes and
  headers. Speech asset changes require a real fake-microphone transcription through the pinned
  `needle.js`/`needle.wasm`/`whistle.cact`, not only an inventory comparison.

A bounded CPU retrieval smoke is technical metadata, not answer quality. It walks source,
index, startup, model-load and query, checks the reviewed index and pinned encoder assets,
and reports redacted digests/identities, bytes, durations, URLs and fixed enums. Failures identify
one of those five stages; model-load may need initial downloads or a stated warm cache.

```bash
timeout --signal=TERM --kill-after=5s 400s pnpm cv:smoke
```

Sample any new/slow workload first and inspect its duration/output before scaling. Keep
timeouts/output bounds and close only owned browsers/servers. Record host, artifact, workload,
observation and cleanup. Type/build success is not runtime, offline or physical-device evidence.

## Browser and voice harnesses

Use headed Chrome for voice/model/offline checks; headless checks cannot establish microphone
or WebGPU behavior. `scripts/voice-qa.mjs --redacted` uses an owned browser and suppresses answer,
transcript/error content, evaluation IDs, debug traces and screenshots. The voice workload needs
an already-served production build; unlike the retrieval workload, it does not own that server.
The voice command is currently blocked with a nonzero pre-launch notice because its workload
still assumes footer-only consent and silent typed reopening. The following recipes remain
for a separately approved harness update, not current passing checks. `--qa=retrieval` is
unchanged. For routine interaction testing use owner-started `pnpm dev`.

After that update, supply an explicit URL for the verified normal full-site loopback root
(the example port is not a promise of an active server):

```bash
BASE_URL=http://127.0.0.1:5192/?sw=1 node scripts/voice-qa.mjs --redacted
BASE_URL=http://127.0.0.1:5192/?sw=1 VOICE_WAV=/external/synthetic-question.wav node scripts/voice-qa.mjs --redacted
```

The full-site loopback server must serve the normal artifact with correct MIME/no-cache and
no injected static COOP/COEP headers so the ordinary service worker owns production recovery.
Use an owned, verified loopback server and stop it with its supported lifecycle. The existing
`scripts/serve-dist.mjs` is a no-COI static helper, but does not explicitly bind loopback;
do not assume its URL log proves loopback-only exposure. `pnpm preview:site` injects headers
and is not the same service-worker recovery check. Do not replace the normal root with a QA
entry/config for final site acceptance. See [manual setup](manual-testing.md#normal-full-site-preview).

The retained, currently blocked voice workload covers readiness/greeting, typed retrieval
(resolving clarification), resize to 414x800 and back, message scrolling, exit, controlled
offline reload with cached models/stored Replay, and metered download behavior. It previously
requested a fake-microphone turn and typed/live parity with `VOICE_WAV`, skipping only those
steps without that input. The current entry blocks all voice runs, not a passing or skipped
workload; requested failed steps must not be relabelled skipped.
The follow-up must move consent observations before the explicit opener and set up synthetic
capture/permissions before opening, never use a real microphone by default, and require a new
user message plus completed non-greeting reply. Typed answers follow current consent/mute.
Silent fallback retains Replay, mute blocks it, and explicit re-enable also starts live voice.
Reopening is fresh unmuted live consent. Revise offline/metered entry assumptions separately
without weakening their acceptance or treating old receipts as passes for this contract.
Non-redacted mode can print answers and retain screenshots, so use it only under explicit
content authority. After harness maintenance, run DEV separately when runtime delivery changes:

```bash
BASE_URL=http://localhost:5173/ node scripts/voice-qa.mjs --redacted
```

The voice-loop offline workload uses a built artifact. Neither it nor a cached-audio hint proves
a cold model can load offline. The separate first-turn harness below covers controlled DEV.

## First typed turn after offline refresh

```bash
report_dir="$(node -p 'require("node:fs").realpathSync(require("node:os").tmpdir())')"
run_id="$(node -p 'require("node:crypto").randomUUID()')"
OFFLINE_CHAT_QA_REPORT="$report_dir/offline-chat-preflight-$run_id.json" node scripts/offline-chat-qa.mjs --preflight
OFFLINE_CHAT_QA_REPORT="$report_dir/offline-chat-dev-$run_id.json" node scripts/offline-chat-qa.mjs --routing=dev
OFFLINE_CHAT_QA_REPORT="$report_dir/offline-chat-built-$run_id.json" node scripts/offline-chat-qa.mjs --routing=built
```

The report parent must exist and canonicalize outside the repository; the harness does not
create it. Do not assume unchecked `XDG_CACHE_HOME` is external. Each runtime report filename
must be new: exclusive creation, mode `0600`, no existing files/symlinks/hardlinks. Choose a new
run id per run. Without the variable, the harness chooses a unique canonical-system-temp path.
Preflight validates the parent without opening/creating a report; it loads QA Vite config but
starts no server, build or browser.

Runtime routes use headed Chrome, wait for service-worker control without an online question,
stop only owned Vite servers, refresh offline and send the first typed turn. BUILT uses an
isolated temporary artifact. QA config omits CV generation, uses a temporary allowlisted public
directory and blocks audio. Reports contain only fixed labels/booleans. This restricted harness
is not the normal full-site final preview or evidence that a cold embedding model loads offline.

## Retrieval-only headed QA

```bash
node scripts/voice-qa.mjs --qa=retrieval --routing=dev
RETRIEVAL_QA=1 pnpm build
node scripts/voice-qa.mjs --qa=retrieval --routing=built
```

`node scripts/retrieval-qa.mjs --routing=dev` calls the same workload. The retrieval workload
owns its browser/server. BUILT requires the explicitly requested private QA page; ordinary
production builds do not include it. This build remains a normal CV/PDF-capable build unless
an approved restricted harness config explicitly omits that pipeline.

## Skill loading

GitHub Copilot project skills use `.github/skills/<name>/SKILL.md` with lowercase hyphenated
names and `name`/`description` frontmatter. References/scripts resolve relative to the skill.
See [GitHub's skill guidance](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-skills).
Do not add shell auto-approval frontmatter or silently change host agent settings.

Pi natively discovers `.agents/skills/`, not arbitrary `.github/skills/`. Load these skills
explicitly through their files or use separately approved explicit Pi skill configuration;
this move does not claim automatic Pi discovery. Do not create duplicate old skills or aliases.
