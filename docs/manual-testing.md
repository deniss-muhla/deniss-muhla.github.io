# Manual browser testing

## Owner final checklist

For current interaction testing, the owner starts `pnpm dev` and uses its reported localhost
URL. No agent preview is promised or required. This dev check is not production/offline
acceptance: use a separately authorized complete built/static root with `?sw=1` for that.
Verify the actual artifact/server before testing. The owner accepts the existing 200-ms
playback heuristic as good enough.
The owner may test their own microphone; operator automation needs separate authority and
must never attach to an owner profile or record input by default.

1. **Consent, typed chat and Replay:** Before opening, no audio resume, microphone, STT
   capture or autoplay. Check the opener's microphone/audio name and tooltip. Click or use
   the keyboard to open/reopen: this fresh action starts unmuted live voice and the stored
   greeting once, with no mode picker or text Enable/Continue step. Type immediately during
   loading/permission/startup or failure. Typed answers follow current consent/mute; Replay
   uses the message's stored answer plan, not new selection.
2. **New chat:** Reset during a reply or pending work. Messages/draft, choices/retry and
   follow-up context clear; intro appears once. Mode/consent remain: typed/muted resets stay
   silent, already-consented unmuted live resets may restart capture/speak after cleanup.
   Reset never unmutes. No old answer, recognition tail or late start should return.
3. **Mute and enable:** Opening offers master mute, including during pending live startup,
   listening or pending/active Replay. Mute stops input/output, blocks Replay and leaves
   typing usable. New chat never unmutes. Explicit footer enable or a fresh opener action
   after close restores unmuted live capture through consent.
4. **Sustained input, bursts and close:** During actual playback, onset pauses output while
   capture continues. Activity still present at 200 ms confirms interruption with the buffered
   beginning; an ended burst resumes the same clip position/order without a question.
   Idle/preparing/inference onset remains immediate. Close during the window and after a
   reply: no late capture, playback or question may return. Include natural quiet gaps.
5. **Known opening-word limit:** Compare idle and interruption speech. Missing first words
   or half-words remain owner-reported, more often during interruption; cause unknown.
   No transport/pre-roll/recognition fix is claimed. Short words may fail the heuristic and
   longer noise may pass. Duration filtering is not noise identification or echo removal.
6. **Motion, colors, focus and layout:** Scroll through the dark/middle/light transition,
   reverse and resize. Check text/icons/focus/opener readability and local native contrast
   or fixed readable fallback. At 390px, no horizontal overflow; usable composer and all
   four icon controls have names/tooltips, visible keyboard focus and at least 44px targets.
   Check reduced motion and print in each tested browser; do not infer unsupported results.
7. **Offline after Ready:** Wait for the accessible completed-audio hint, with shell and
   needed retrieval/speech model/runtime assets also cached. Disconnect and reload the
   controlled built root; check typed answers and explicit stored Replay. Partial caching
   stays labelled incomplete and leaves typing usable. Audio Ready alone is not model Ready.

Keep reports content-free: pass/fail booleans, counts, durations and fixed failure labels,
not CV/answer/transcript text, screenshots or recordings. Record host/browser, artifact,
workload and cleanup. If a separately approved visual check needs a transient screenshot,
do not retain it or add it to reports/repository history.

Narrow UI checks observed continuous emitted-CSS motion/reverse, keyboard focus and 390px
controls/layout in native-timeline Chrome and actual unsupported Firefox. Chrome reduced
motion and print were checked; Firefox media emulation was unsupported, so its reduced-motion
and print paths remain untested. These headless UI results are not owner visual, Safari,
physical mobile, speech, model, offline or pronunciation acceptance. Older native pause/resume
checks prove neither PCM delivery on physical devices nor microphone quality. Independent
source review and legal/publication acceptance are separate from implementation checks.

## Normal full-site preview

Normal local Page/CV/PDF build and serving are approved for the final full-site workflow.
Use the ordinary root entry and complete artifact, loopback port 5192, correct MIME/no-cache
and the normal service worker. Do not inject static isolation headers, substitute a QA entry
or omit normal assets for this final test. Preserve a previous artifact when replacement is
in scope; back up a replaced generated PDF externally and compare the canonical CV hash
before/after. Local preview approval does not authorize source-content edits or publication.

Use the [development guide](development.md) for build commands and the distinction between
Vite preview and plain static service-worker recovery. Verify loopback binding and server
ownership, not just the logged URL. Close only owned test servers/browsers through supported
lifecycle controls. The conditional isolation recipe below is for tasks that explicitly
restrict generation/content, not a blanket prohibition on normal builds or CV/PDF checks.

## Use Pi computer-use tools

When available and approved, activate `window`; activate `browser` for owned Chrome/Edge
protocol access and `diagnostics` for owned process/server state. Find the owned PID, call
`list_windows(pid)`, then `get_window_state(pid, window_id)` with the returned id. Prefer
window-scoped capture over desktop coordinates on multi-monitor systems. Bound/filter UI
trees and disable screenshots or trees when unnecessary. Use current element tokens; new
snapshots invalidate old ones. Coordinates must use that screenshot's `capture_id`.

If Wayland Firefox returns no addressable window, an isolated X11 session is a known option:

```bash
temp_root="$(node -p 'require("node:fs").realpathSync(require("node:os").tmpdir())')"
profile_dir="$(mktemp -d "$temp_root/firefox-manual.XXXXXX")"
env MOZ_ENABLE_WAYLAND=0 GDK_BACKEND=x11 /usr/bin/firefox --no-remote --profile "$profile_dir" about:blank
```

Verify the executable exists and the fresh profile is external. Never reuse a logged-in
profile; close only this Firefox before removing its temporary profile. Explicitly approved
Chrome/Edge may serve voice/protocol checks. Do not attach to unrelated sessions. If background
typing times out, retry only that action with foreground delivery; do not persistently raise
an unrelated window. For content-restricted checks, narrow the query to a control name and
set `include_screenshot: false`. Verify a known synthetic draft in memory as a boolean, not
with a page-text dump.

## Restricted artifact checks

Only use this recipe when the task explicitly forbids CV/PDF generation or serving. Before
starting any manual Vite server, verify the normal commands cannot violate that restriction:

- Set `OFFLINE_CHAT_QA_ONLY=1` before loading config; verify no `cv-artifacts` plugin.
- Create the server with `configFile: false`.
- Use an external temporary `publicDir` with only `favicon.svg`, `sw.js`, `sw-register.js`.
- Deny `/public` and `/downloads`, plus `/audio` for STT-only checks. If playback is explicitly
  approved, allow only the validated manifest and exact content-hashed clips, not arbitrary
  public-tree paths.

For restricted BUILT, verify the same plugin exclusion; use `configFile: false`, `publicDir:
false`, `copyPublicDir: false` and external output. Copy only those three shell files and serve
an emitted-file allowlist on a fresh local port. Do not run a normal build, request/inspect/copy
a protected PDF or serve the repository public tree. Stop if these restrictions cannot be
verified. This procedure is not the full-site final preview and is not technical enforcement.

## Triage browser messages

An extension's `content.js` error is not by itself an app error. A Vite connection-lost message
may mean the server stopped/restarted. Repeat in a clean owned temporary profile and verify
server lifecycle before blaming the app. Reports use fixed labels, browser/OS, workload,
server state and observed result, not raw private errors.

## Synthetic speech input

Use headed Chrome or explicitly approved Edge with external synthetic audio for operator STT
checks. Firefox visual checks do not prove synthetic recognition. `scripts/voice-qa.mjs`
has fake-capture flags/redaction but its voice workload currently fails closed before browser
launch: it still assumes footer-only consent and silent typed reopening. Do not use it until
that workload is updated under separate approval. Retrieval QA is unaffected. The harness
does not create the restricted QA-only server/build; do not run its normal site setup unchanged
under a restricted-content task.

Launch a fresh owned external profile with these flags before opening the page:

```text
--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream
--use-file-for-fake-audio-capture=<canonical-external-synthetic-wav>%noloop
```

Create licensed/synthetic media outside the repo. With `espeak-ng`, resample with `ffmpeg`
to 48 kHz mono and add leading/trailing silence. Keep fixture text out of logs. Do not use an
owner recording, `question.txt` or a real microphone for automation without explicit authority.
`%noloop` prevents repeated fixture playback; EOF does not stop the live capture track. Do not
disable capture, force a flush or alter AEC/VAD to manufacture a successful turn. If no turn
settles, record observed capture/utterance labels and fail the requested check.

Use the owned Playwright/Puppeteer browser or attach only to its verified PID/tab/window.
Automation authority covers setup and content-free observations, not another browser profile.
Exercise real UI actions, not internal `ensureStt()` calls that hide startup dependencies.

### Speech workflow

1. Select normal or restricted setup according to the approved scope; never mix their claims.
2. Observe closed-page silence before the opener, not afterward. Set up synthetic-only
   capture/permission before opening. Open with the assistant button: audio/STT/microphone
   startup begins, with greeting text, immediately usable composer and footer `Mute voice`
   icon. Check accessible names/tooltips and 44px targets. Loading must not block typing.
3. Type/send a synthetic question without a mode choice; answer speech follows current
   consent/mute. Check silent fallback without audio approval and exact stored-plan Replay
   without another query/selection. Mute blocks Replay; explicit enable also starts live voice.
4. Close/reopen using the opener as fresh live consent, not a second footer click. Greeting
   uses its stored plan without duplicating the visible intro or already-played greeting;
   capture remains active during playback so sustained speech can interrupt it.
5. Confirm interim and committed recognition with in-memory synthetic comparisons. One
   continuous utterance becomes one question after an audio pause, not a decoder-update gap.
   Later silence does not repeat it, and repeating the phrase remains valid.
6. Type an independent draft while recognition continues; voice must not overwrite it.
   Check reset/mute/close races and retained New chat consent as in the final checklist.
   Closing invalidates pending starts; the explicit opener supplies fresh consent on reopen.
7. Exercise DEV and BUILT separately when asset serving changes. Verify served speech assets
   against `scripts/model-assets.mjs`, not just paths. A cold first static load may not yet
   be isolated; record the value and first-control recovery rather than claiming readiness.
8. Close owned browsers/servers and remove only owned external profiles/public/output trees.

Record artifact, browser/host, worker error labels, recognition/draft booleans, capture counts,
pinned digest results and cleanup. This is not physical microphone or pronunciation proof.
Exercise several transcript updates before rendering and delayed consumption when testing
stream delivery. The allocator/load contract is `_malloc`/`_free` with nonnegative speech-model
load success; retain real pinned-runtime recognition evidence for changes at that boundary.

## Playback and cut-off triage

See [runtime timing](assistant-runtime.md#playback-and-interruption) for padding and the
200-ms continuation policy; do not duplicate or tune those constants during a UI check.
With synthetic silent input and validated audio routes, explicitly open/enable voice or Replay.
Check greeting and an approved answer in DEV and BUILT. Typed turns follow current audio
consent/mute; both autoplay and Replay use the visible message's same immutable plan. Compare
decoded/padded samples in memory, retaining only equality booleans/frame counts. Input stays open. Close during leading
and trailing padding; sources stop/disconnect once. Natural completion disconnects without
an explicit stop.

For onset checks, quiet/absent/stale continuation resumes the same position/order without a
question. Sustained fresh frames confirm one buffered question; close/mute/reset must prevent
late resume/capture. Verify real output lifecycle, not only a mocked timer. Native output
checks do not prove physical echo cancellation, speaker delivery or complete-catalog quality.
If output stops mid-sentence, compare source-stop, expected buffer-end and recognition events
before adding delay. Distinguish cut-off recognized questions from cut-off spoken replies.
Do not claim padding recovers missing audio or fixes a speech endpoint split.

## Live microphone diagnosis

Use live input only under a new explicit owner request/recording approval. Historical approvals
are not standing authority. For Edge CDP, launch an isolated non-default profile with loopback
debugging, inspect only the owned app tab and use trusted input events to check audio activation;
a synthetic DOM click is not proof of user gesture. Never copy/attach to/close an owner profile.

Input begins only after explicit opener/enable consent and permission, remains active during
greeting/answers and stops on close. The request uses basic boolean echo cancellation, not enhanced `all` mode.
Inspect the granted setting: `true` is browser-mode confirmation, not proof of cancelled
assistant playback. Missing/false/non-boolean settings are unconfirmed; headphones can reduce
leakage. Do not add phrase blacklists, word suppression or forced capture pauses as workarounds.

If recording is explicitly approved, use an external private directory and owner-only file/
directory permissions. Keep processed audio private; event logs contain timestamped capture,
echo-setting, worker/playback and UI-turn labels, never CV/answer/transcript text, screenshots,
cookies or device identifiers. Do not upload or store recordings anywhere inside the public
repo. Cap each recording at five minutes and the owned debug session at twenty minutes; stop
recording on close. Isolate Vite dependency caches externally too. Close owned resources and
keep recordings only for that approved diagnosis. A playback-overlapping short burst alone
does not identify leakage/noise; granted AEC or joined pre-roll does not prove the cause fixed.

## Motion, controls and offline cache

Use a complete normal build and isolated browser/profile. Inspect emitted CSS through the
9–15% transition, intermediate positions, reverse scroll and resize remeasurement in native
and actually unsupported timeline browsers. Do not simulate unsupported support only by
source inspection. Check reduced-motion spread/smooth-navigation suppression and print
animation removal where browser media tooling works; report unsupported emulation as untested.
Preserve the local readable black/white chat switch instead of fading text through gray.

At 390px, verify no overflow, composer usability, keyboard Tab focus, names/tooltips and
44px targets for New chat, play/Replay, Send and voice. Completed audio uses a concise accessible
hint with no verbose visible count row; active progress and incomplete/error/data-saving/
offline/retry states remain actionable. The [focused unit command](development.md#choose-checks-for-the-changed-boundary)
is model-free and does not replace browser/voice/offline acceptance.

For caching, use the controlled built root, not a DEV widget missing `sw-register.js`.
Check audio status independently of STT/retrieval model readiness. Confirm actual verified
counts/bytes progress to the manifest's item count, and completion only after the manifest's
facts/greeting/catalog hashes match the compiled identity and every hashed clip verifies.
Caching itself must not start greeting, microphone or autoplay. Data Saver skips warming;
offline stops new requests and shows incomplete status; reconnection/retry fetch only missing
clips while retaining valid ones. Ready cannot come from completed jobs alone.

After Ready and needed models/shell are cached, close, disconnect and reload through ordinary
service-worker recovery. Confirm Ready, usable shell, typed retrieval and explicit stored Replay.
For partial cache, verify missing/unfinished status and usable typing. Older built receipts
are not final-artifact acceptance. None of these procedures grants publication or legal clearance.
