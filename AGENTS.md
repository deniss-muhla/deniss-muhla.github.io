# Agent rules

These rules define the default decision-making principles for agents working on this
repository: Deniss Muhla's public CV and portfolio site, plus the career vault it publishes
from and the on-device voice assistant embedded in the page.

## 1. Prefer simplicity

- Do not make a solution more complex than necessary.
- If the same result can be achieved with a simpler approach, prefer the simpler approach.
- Avoid adding abstractions, dependencies, architectural layers, or generalized mechanisms
  unless they solve a concrete problem or provide clear value. A static site does not need a
  framework, a store, or a backend.
- Prefer plain files and platform features over dependencies: markdown for content, CSS for
  presentation, the service worker API for offline support.

## 2. Use constraints deliberately

- Constraints are useful. This project has hard ones and they shape every decision:
  - the repository is **public**, so nothing private may enter it or its history;
  - GitHub Pages serves static files and **cannot set HTTP headers**;
  - speech recognition needs `SharedArrayBuffer`, which needs cross-origin isolation;
  - the answer model needs WebGPU, which may be absent;
  - visitors may be on mobile networks and metered connections.
- Treat explicit constraints as design tools. Work toward the boundaries they define rather
  than bypassing them with unnecessary complexity.
- When evaluating a solution, ask whether the constraints can help produce a simpler, clearer,
  or more focused result.

## 3. Prefer modular, loosely coupled solutions

- Keep modules focused and connect them through explicit contracts rather than each other's
  internal details.
- Keep vendor details behind one project-owned boundary. The voice engine is that boundary for
  Moonshine, WebLLM and Pocket TTS: application and UI code must not import those packages
  directly, and swapping a model must not require touching the chat UI.
- Keep high-level modules dependent on project-owned types such as the engine's progress and
  state values, not on vendor objects, configuration shapes, or lifecycles.
- A reader should understand a module's scope from its directory, file name, exports and nearby
  documentation. Normal navigation must not require a separate architecture map.
- Treat paths, repository layout, development setup and process environment as validated
  inputs rather than embedded assumptions. Site-absolute paths assume the site is served from
  the domain root; state that assumption where it matters.
- When coupling is necessary, keep it narrow, explicit, and justified by a concrete
  requirement.

## 4. Keep code and project memory truthful

- Treat code as the primary source of truth for behavior, contracts and invariants. Keep
  behavior-defining knowledge in code whenever practical.
- The career vault is memory with a publication contract. Every claim in `resources/` must be
  either directly published professional information or a clearly attributed source.
- Keep the current CV (`resources/cv/source/cv.md`) and its derived PDF as the single source
  for CV content; do not duplicate CV text into components or notes.
- Prefer updating an existing document over adding a parallel one. Do not keep a stale copy of
  a fact in two files.
- Put explanations next to the implementation they clarify. Prefer precise TypeScript names and
  types first, focused comments for hidden contracts, and a README only when a module needs
  usage or lifecycle guidance.
- Prefer self-explanatory code over routine comments. Add a comment only when it records a
  non-obvious invariant, external constraint, compatibility rule, or reason the code cannot
  show directly. The existing comments about Moonshine minification, the offline reload race
  and the Pocket TTS buffer are the expected level.
- Keep each repository skill and document aligned with the interfaces it covers. When a
  change alters a command, workflow or contract that a document describes, update that
  document in the same change.

## 5. Verify changes for lasting value

- Every change requires verification; keep it minimal and fast while covering the relevant
  behavior and meaningful options.
- Prefer checks that retain regression value. Type checking and a production build are the
  floor, not the goal.
- For interactive changes, verify what the user actually experiences in a real browser, not
  only the final state. Check loading, greeting, listening, answering, interruption, resize,
  scrolling, offline and exit where relevant.
- Headless browsers cannot prove microphone or WebGPU behavior reliably. Use the Playwright
  harness in `scripts/voice-qa.mjs` with a headed Chrome for voice, model and offline checks,
  and record the host, artifact, workload and observation.
- Runtime assets are served differently in each environment: Vite serves and transforms modules
  in dev, the service worker serves cached responses in production, and a plain static server
  emulates GitHub Pages. When a change touches how a runtime asset is loaded or served, check
  the dev server `and` the production build before claiming it works. The Moonshine runtime and
  the isolation headers are the known failure point.
- Exercise the delivery pattern as well as the data size. For streaming paths, test interim
  transcripts, several updates before one render, and delayed consumption.
- When a real issue is fixed, retain regression knowledge. The minification failure of the
  Moonshine runtime is the standing example: the fix is the vendored runtime, and the check is
  a real transcription from the fake microphone. State that check in the change that touches
  the runtime.
- For a bug fix, the regression check must fail before the fix and pass after it.
- Keep prompt fixtures frozen so instruction changes are visible in tests. One reviewed-public,
  historical, non-authoritative full-CV snapshot is allowed only for the default prompt test;
  check its raw-byte fingerprint against the current canonical CV and review the source, snapshot
  and frozen prompt expectations together when it changes. Do not copy the full CV into other tests.
- Do not add one-off checks that consume resources afterward, unless they protect an enduring
  contract.

## 6. Keep peer groups consistent

- Give files, classes, values and documentation at the same conceptual level a coherent naming
  and structural pattern so peers are immediately comparable.
- Keep the `resources/` notes in the same shape as each other, and the `scripts/` entry points
  in the same shape as each other.
- Preserve meaningful semantic differences, but remove accidental drift rather than forcing
  false uniformity.

## 7. Split source files at cohesive boundaries

- When a source file grows beyond a few screens and contains separable responsibilities, split
  it into focused, cohesive modules.
- Do not split purely by line count or add indirection without a clear responsibility boundary.
- Organize the source tree by product functionality and each feature's logical role, not by
  generic technical type. `src/chat`, `src/offline` and `src/page` are the intended example.
- The voice engine currently holds speech recognition, speech output and the answer model in
  one module. Splitting those three behind the existing project-owned interface is welcome once
  a change touches them, provided the chat UI contract stays unchanged.

## 8. Keep change easy and extensible

- Prefer code that is straightforward to use, maintain and evolve, with clear boundaries that
  keep the cost and scope of change low.
- Prefer designs where new capabilities can be added without changing existing ones, such as
  substituting the answer model or the speech voice behind the engine boundary.
- Avoid premature abstraction, but favor extensibility when it comes naturally.
- Add abstraction or flexibility for a concrete need, not for speculative future extension.
- Separate required fixes from optional optimizations. Measure the corrected baseline before
  adding caches, invalidation state or another abstraction.

## 9. Make consequential state changes explicit

- Do not let defaults or convenience inputs automatically create or change things.
- Before a consequential user-facing change, make the intended target and result clear and
  require explicit confirmation. The microphone starts only from an explicit click on the
  assistant button, and the chat opens only from an explicit action; keep it that way.
- Background model downloads are a deliberate exception requested by the owner. They must stay
  cancellable in effect by keeping the page usable, must respect metered connections, and must
  be visible in the interface.
- Provide cancel or back navigation, and report missing or invalid inputs clearly. Closing the
  panel stops listening and playback.

## 10. Keep user workflows actionable

- Describe user-facing actions in terms of the user's goal rather than internal paths or
  implementation mechanics.
- When an action has a prerequisite, provide a clear path to satisfy it instead of a passive or
  dead-end state. When live voice or the answer model is unavailable, the chat must still accept
  typed questions and explain what is missing.
- Keep equivalent workflows on shared behavior. Typed and spoken questions must produce the same
  answers, the same cleanup and the same spoken output.

## 11. Make long-running work observable

- Show meaningful activity from actual lifecycle events rather than invented progress or
  elapsed time alone. Model download progress must come from the libraries, not from a timer.
- Distinguish loading, ready, listening, thinking, speaking, failed and offline states.
- Keep observability state separate from credentials and unsafe internals. The `?voiceDebug=1`
  trace is the sanctioned diagnostic surface; keep secrets, personal data and model internals
  out of logs.
- Surface warnings where the user can act on them, not in state that is never rendered.

## 12. Minimize third-party contact

- Integrate an external library through the smallest documented public API that satisfies the
  concrete requirement.
- Prefer one focused project-owned adapter or wrapper when vendor behavior crosses a module
  boundary, owns resources, or would otherwise spread vendor types through the project.
- Make that boundary the one place to update or replace the dependency.
- Wrap only the behavior the project uses. Do not mirror an entire vendor API or build a generic
  replacement framework.
- Keep vendor types and lifecycles inside the boundary.
- For actively developed dependencies, prefer deliberate locked upgrades. Update the dependency
  first, reread its current documentation, adapt the narrow boundary, and protect it with a
  check. Do not use floating runtime versions for code that is vendored, cached, or whose exact
  bytes matter.
- Moonshine is served from the package's `dist/` through the `moonshine-runtime-serve` and
  `moonshine-runtime-build` plugins in `vite.config.ts`, which stream it at `/moonshine/` in dev
  and emit it into the build output. That runtime must stay unminified and byte-identical to the
  installed package. Do not bundle it, minify it, patch it in place, or serve it from `public/`
  (Vite refuses to load `public/` URLs from source), and record any needed upstream fix instead.

## 13. Keep the career vault publishable and current

- `resources/` is public. It contains reviewed professional facts, skills, credentials and
  source notes only.
- Never add contracts, invoices, rates or salaries, banking details, signatures, identity
  numbers, credential verification codes, residential addresses, private correspondence,
  family details, travel bookings, third-party photos, or authenticated browser captures.
- Do not store private originals in a git-ignored directory inside this repository. Detailed
  material belongs in an external private document store.
- A document's existence does not make its contents public. A logged-in profile view can contain
  owner-only panels; only public professional fields may be summarized.
- Keep claims source-qualified. Historical dates, proficiency labels and experience totals must
  not be inferred from filenames or automated summaries. Conflicting dates stay visible in the
  timeline instead of being silently resolved.
- When the CV changes, check the career notes and `resources/cv/cv-gaps.md` for facts that are
  now stale, contradicted or newly relevant.

## 14. Keep runtime boundaries in one place each

- The service worker owns caching and cross-origin isolation. Header injection, cache naming,
  cache pruning and the offline fallback live in `public/sw.js` only.
- The registration script owns the recovery reload. Do not add reload logic anywhere else.
- The engine owns model loading, progress, generation, speech and interruption. Components own
  presentation and interaction state only.
- The `moonshine-runtime-serve` and `moonshine-runtime-build` plugins own the `/moonshine/`
  route. Nothing else serves or writes that runtime.
- The dev route and the production route must send the same isolation headers. Serving the
  runtime without them breaks nested workers in a cross-origin isolated page.
- Keep browser-runtime assumptions explicit and tested at their boundary: service worker
  lifecycle, `clients.claim()`, the first controlled load, and Chrome's offline reload behavior
  are all real cases that have caused defects here.

## 15. Keep writing plain and current

- Apply this style to every new or edited document, including this file, README files, notes,
  commit messages and user-facing text.
- Use sentence-case headings, straight quotes, active voice and concrete terms. Do not use em
  dashes, promotional phrasing, generic conclusions, or technical-sounding words where a plain
  term is more exact.
- Check claims against current code and the deployed behavior. Remove stale behavior, status,
  command, path and dependency claims instead of polishing them.
- When a decision changes, reconcile the applicable documents in the same change. Keep one
  source of truth at each level rather than repeating full designs.
- Check local markdown links, formatting and contradictions before finishing a documentation
  change.

## 16. Write task handoffs for implementation

- Store implementation plans in durable repository files rather than leaving them in chat
  history. Keep unrelated work in separate files when the planning format supports it.
- After completing an individual task, record a short handoff directly below it: implemented
  behavior, important files or contracts, checks and results, remaining limits or blockers, and
  the next task.
- Write each block for an implementer who has no conversation history and will not infer omitted
  work. State the goal, scope, prerequisites, settled decisions, relevant contracts,
  implementation sequence, checks, failure cases, acceptance criteria and stop conditions.
- Keep each block small enough to implement, verify and hand off in one session.
- Update a task file when implementation discovers a false assumption. If the evidence changes
  approved behavior or scope, stop and reconcile the design before continuing.

## 17. Keep implementation claims honest

- Check a task only after every clause is implemented and its named checks have passed in the
  current worktree.
- Verify a contract against an independent source of truth. Comparing one hand-copied list with
  another does not prove compatibility with the installed API.
- Classify review findings as reproduced defects, supported risks, measured optimization
  opportunities, or cleanup suggestions. State user impact and evidence separately from the
  proposed solution.
- When behavior comes from generated output, vendored runtimes or cached assets, test the value
  that actually ships, not the source text or a copied inventory.
- A replacement is complete only when shipping code, defaults, fallback branches and runtime
  composition cannot reach the old implementation.
- Before marking work complete, inspect `git status --short` and confirm that every new file
  belongs to the intended change set, including untracked files.
- Claim offline, mobile or browser support only after the relevant check has run in that
  environment against the shipped artifact. A production build is not runtime evidence.
- Do not change checks to accept behavior that contradicts the stated rules. Reconcile the rule
  or the design first.

## 18. Use subagents with clear ownership

- Always delegate bounded implementation, investigation and independent review tasks to
  subagents when the task is eligible and the execution environment permits it. Check available
  tools, permissions and limits first. If delegation is unavailable, stop and ask before doing
  the delegated work directly. Follow higher-priority tool and runtime policies.
- Keep the parent responsible for scope, decisions, coordination and final acceptance. Use a
  stronger reasoning model for the parent than for bounded workers when model choice permits it.
- Give each child one cohesive deliverable with the goal, working directory, baseline revision,
  allowed edits, relevant contracts, acceptance checks, stop conditions and expected handoff in
  the established planning format. Keep scratch outside shipping files. Preserve existing dirty
  files; never stage, revert or overwrite work outside the assigned scope.
- Allow only one writer per checkout. Before assigning a writer, check cross-session task and
  process evidence; an empty task list does not prove another writer has exited. Use separate
  worktrees for parallel writers, and keep independent reviewers read-only. Prefer background
  execution with completion notifications over blocking polls when the execution tool supports it.
- Require a checkpoint in that handoff before a worker's timeout listing changed files, check
  results, unfinished work, owned processes, temporary resources and the next task. Treat
  timeouts, crashes, cancellations and missing results as incomplete: inspect the partial diff,
  untracked files and last checks; confirm the previous writer has exited before narrowing or
  retrying through supported delegation. Never silently switch tools to continue the work.
- Keep substantial implementation and independent review separate. Reviewer findings are
  preliminary; the parent reads the actual artifacts, checks completeness, order, contradictions
  and evidence, reuses valid check evidence, resolves findings and reruns affected checks. Inspect
  the final diff and status, verify every new file and resource cleanup, report check evidence
  and remaining risks, and confirm no unrelated files were staged or changed. Do not attribute
  changes merely to a running application.
- Never terminate unrelated processes. Stop owned browsers and servers with the supported
  mechanism after the work is done. Direct process termination requires explicit authorization
  and a fresh identity check.

## 19. Keep fixtures and generated assets out of version control

- Large binaries and generated trees stay out of Git: model weights other than the
  exact verified TRLM deployment pair below, the vendored Moonshine runtime, the
  generated CV PDF, browser profiles and build output.
- Only the verified browser-deployment pair for `Shekswess/trlm-135m` at revision
  `eb6adefde3066b2555a4f88aae9843fcb528d87a` may be added under
  `public/models/trlm-135m/`, and only after candidate stages 3.1.1-3.1.4, 3.2
  and 3.3 pass. The exception covers converted MLC parameter shards, matching
  config/tokenizer, compatible WebGPU library, and required license/attribution
  notices and concise provenance. Before copying, verify source/tool/output
  provenance, hashes and sizes, redistribution rights, and a successful headed
  Chrome/WebGPU load of the exact pair in WebLLM 0.2.85. Keep each file under
  GitHub's 100 MiB limit and the total within current Pages site-size limits. Use
  MLC-supported sharding if needed; never use Git LFS as a Pages delivery
  workaround. Keep the 269,062,856-byte BF16 source checkpoint and the pinned
  Python/MLC/TVM/Emscripten toolchain in an isolated external environment; do
  not add these tools to the frontend manifest or install them as root or
  system-wide. Keep caches, profiles and all intermediates/build trees outside
  Git. This exception does not cover other models or private originals and does
  not authorize staging, committing, pushing, publishing or archiving.
- For generated artifacts without a documented exception, keep the generator and
  its inputs in the repository, and document the exact command that recreates
  the artifact.
- Store test media such as the fake microphone WAV outside the repository, and document how to
  create it. Do not commit large audio or image fixtures.
- Other model downloads are browser caches, not repository assets. A check that needs a
  model must either tolerate a cold cache or state the required warm state explicitly.
- Third-party content used in checks must be public-domain or licensed, with its source
  recorded, and kept outside the repository when large.

## 20. Bound and sample shell commands

- Run a new or slow command on the smallest meaningful input first, inspect its output, and note
  how long it took. Only then start the full workload.
- Always set a reasonable timeout on a command that can hang or take minutes. Treat the timeout
  as a failure with evidence instead of rerunning blindly.
- Cap captured output, and read the sampled run's log before starting the long run.
- After a timeout, abort or kill, check for leftover child processes and temporary files you
  own, then clean them up before retrying. Browser instances, dev servers and static servers
  started for a check must be closed by the check that started them.
