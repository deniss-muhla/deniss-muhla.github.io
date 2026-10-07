import assert from "node:assert/strict";
import test from "node:test";

import { checkQaScriptGraph, observeDeliveryPhase, waitForDeliveryControl } from "../scripts/retrieval-qa.mjs";
import type { DeliveryPage, DeliveryPhase, DeliveryState } from "../scripts/retrieval-qa.mjs";
import { guardedTest, qaArtifacts, skipLedgerMarker } from "./build-preconditions.ts";

/**
 * The startup delivery barrier with a stub page, so its control flow is exercised without a
 * browser, a server and a model. The stub plays the one thing the barrier has to survive: a
 * main-frame navigation that destroys the context a probe answered from.
 */

/** The private QA entry in the built routing, as the harness navigates to it. */
const PAGE_URL = "https://qa.example/qa/retrieval.html?sw=1";

/** A first document that has the page's API and no delivery: the state that must not resolve. */
const UNCONTROLLED: DeliveryState = { controlled: false, isolated: false, coiSeen: true, ready: true };

/** The document the production routing needs: API, controller and isolation together. */
const DELIVERED: DeliveryState = { controlled: true, isolated: true, coiSeen: true, ready: true };

/** The stub adds the one call a real page does not have: navigating its own main frame. */
interface StubPage extends DeliveryPage {
  navigate(): StubPage;
}

/** A page that answers probes from a script and can navigate its own main frame. */
function stubPage(script: Array<DeliveryState | Error>, onLostContext: () => void = () => {}): StubPage {
  const listeners = new Map<string, Array<(frame: unknown) => void>>();
  const mainFrame = { url: () => PAGE_URL };
  let call = 0;

  const page: StubPage = {
    mainFrame: () => mainFrame,
    on(event: string, handler: (frame: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return page;
    },
    navigate() {
      for (const handler of listeners.get("framenavigated") ?? []) handler(mainFrame);
      return page;
    },
    async evaluate() {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;

      if (step instanceof Error) {
        onLostContext();
        throw step;
      }

      return step;
    },
  };

  return page;
}

/** The limits a barrier gets in a check that must not spend the real 120 seconds. */
const SHORT_LOAD_MS = 1;

/** A load bound long enough that a timer fires, but still a fraction of the run's own 600. */
const HUNG_LOAD_MS = 25;

/**
 * A load bound that has to outlast one delivery poll.
 *
 * The barrier sleeps between probes and never sleeps past its own bound, so a check that
 * expects a second probe after a startup navigation needs a bound longer than that poll. A
 * bound shorter than the poll no longer measures what the test is about; it measures the
 * bound refusing to overrun, which {@link HUNG_LOAD_MS} and {@link SHORT_LOAD_MS} already do.
 */
const NAVIGATION_LOAD_MS = 400;

/**
 * Resolves with what the barrier settles to, or reports that it is still waiting.
 *
 * A barrier that never settles would hang the check that runs it, so the sentinel is the
 * outer observation: it can only win if the barrier's own bound does not.
 */
function settleOrReport(work: Promise<unknown>, sentinelMs = HUNG_LOAD_MS * 100): Promise<"still-waiting" | string> {
  return Promise.race([
    work.then(
      () => "resolved",
      (error: Error) => error.message,
    ),
    sleep(sentinelMs).then(() => "still-waiting" as const),
  ]);
}

/** A page whose probe never answers, which is the stall the load bound has to end. */
function stalledPage(): StubPage {
  const mainFrame = { url: () => PAGE_URL };
  const page: StubPage = {
    mainFrame: () => mainFrame,
    on: () => page,
    evaluate: () => new Promise<DeliveryState>(() => {}),
    navigate: () => page,
  };

  return page;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("the built barrier does not accept an uncontrolled first document that has the API", async () => {
  const page = stubPage([UNCONTROLLED]);
  const startup: DeliveryPhase = observeDeliveryPhase(page);
  page.navigate();

  await assert.rejects(
    waitForDeliveryControl(page, { loadMs: SHORT_LOAD_MS }, { routing: "built", observation: startup }),
    (error: Error) => error.message.startsWith("delivery-control-timeout:") && /"controlled":false/.test(error.message),
  );
});

test("the built barrier waits through the startup navigation and finishes on a controlled document", async () => {
  let page: StubPage;
  page = stubPage(
    [new Error("Execution context was destroyed, most likely because of a navigation"), DELIVERED],
    () => page.navigate(),
  );
  const startup = observeDeliveryPhase(page);
  // The first document commits, then the registration reload replaces it.
  page.navigate();

  const state = await waitForDeliveryControl(page, { loadMs: NAVIGATION_LOAD_MS }, { routing: "built", observation: startup });

  assert.deepEqual(state, DELIVERED);
  assert.equal(startup.navigations, 2);
  assert.equal(startup.path, "/qa/retrieval.html");
});

test("the dev barrier accepts readiness on its own, which the existing rule allows", async () => {
  const page = stubPage([UNCONTROLLED]);
  const startup = observeDeliveryPhase(page);

  const state = await waitForDeliveryControl(page, { loadMs: 50 }, { routing: "dev", observation: startup });

  assert.deepEqual(state, UNCONTROLLED);
});

test("a page that is never controlled fails on its own bound and names the state it last saw", async () => {
  const page = stubPage([UNCONTROLLED]);
  const startup = observeDeliveryPhase(page);
  page.navigate();

  const failure = await waitForDeliveryControl(page, { loadMs: SHORT_LOAD_MS }, { routing: "built", observation: startup }).then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.ok(failure instanceof Error, "the barrier must reject instead of resolving");
  const { message } = failure as Error;
  assert.match(message, /^delivery-control-timeout:/);
  assert.match(message, /"phase":"startup"/);
  assert.match(message, /"controlled":false/);
  assert.match(message, /"isolated":false/);
  assert.match(message, /"path":"\/qa\/retrieval\.html"/);
  assert.ok(!message.includes("sw=1"), "the query must not reach the diagnostic");
  assert.ok(!message.includes("qa.example"), "the origin must not reach the diagnostic");
});

test("an evaluation failure that no navigation explains keeps its own error", async () => {
  const page = stubPage([new Error("delivery probe failed")]);
  const startup = observeDeliveryPhase(page);

  await assert.rejects(
    waitForDeliveryControl(page, { loadMs: 50 }, { routing: "built", observation: startup }),
    (error: Error) => error.message === "delivery probe failed",
  );
});

test("a probe the page never answers fails on the same load bound instead of holding the run", async () => {
  const page = stalledPage();
  const startup = observeDeliveryPhase(page);
  page.navigate();

  const outcome = await settleOrReport(
    waitForDeliveryControl(page, { loadMs: HUNG_LOAD_MS }, { routing: "built", observation: startup, startedAt: Date.now() }),
  );

  assert.notEqual(outcome, "still-waiting", "the barrier must settle on the load bound it was given");
  assert.match(outcome as string, /^delivery-control-timeout:/);
});

test("an unrelated evaluation failure during the startup navigation keeps its own error", async () => {
  let page: StubPage;
  page = stubPage(
    [UNCONTROLLED, new Error("delivery probe failed")],
    () => page.navigate(),
  );
  const startup = observeDeliveryPhase(page);

  await assert.rejects(
    waitForDeliveryControl(page, { loadMs: NAVIGATION_LOAD_MS }, { routing: "built", observation: startup }),
    (error: Error) => error.message === "delivery probe failed",
  );
});

test("a destroyed context that no navigation explains keeps its own error", async () => {
  const page = stubPage([new Error("Execution context was destroyed, most likely because of a navigation")]);
  const startup = observeDeliveryPhase(page);

  await assert.rejects(
    waitForDeliveryControl(page, { loadMs: HUNG_LOAD_MS }, { routing: "built", observation: startup }),
    (error: Error) => error.message.startsWith("Execution context was destroyed"),
  );
});
/**
 * The script-graph refusal, against synthetic build trees outside the repository.
 *
 * The pre-fix failure was a chunk layout: the built QA document reached the site entry's
 * chunk through a shared interop module, the entry mounted into `#root` the QA document does
 * not have, and the module graph threw before the page API appeared. These fixtures recreate
 * that layout (fail-before) and the isolated layout the `manualChunks` fix produces
 * (pass-after), so the refusal keeps regression value without shipping a dist fixture.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The mount literal the refusal looks for in a built chunk. */
const MOUNT = "getElementById(`root`)";

/** A synthetic dist tree in the OS temp directory, with a removal bound to the test. */
function buildTree(files: Record<string, string>): { dist: string; remove: () => void } {
  const dist = mkdtempSync(join(tmpdir(), "qa-script-graph-"));
  for (const [path, text] of Object.entries(files)) {
    const file = join(dist, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return { dist, remove: () => rmSync(dist, { recursive: true, force: true }) };
}

const SITE_HTML = '<script type="module" src="/assets/site-entry-a1b2c3.js"></script>';
const QA_HTML = '<script type="module" src="/assets/qa-retrieval-x.js"></script>';
const MOUNTED_ENTRY = `createRoot(document.getElementById(\`root\`)).render(page);`;

test("the pre-fix layout is refused: the QA graph reaches the site entry's script target", (t) => {
  const { dist, remove } = buildTree({
    "index.html": SITE_HTML,
    "qa/retrieval.html": QA_HTML,
    "assets/qa-retrieval-x.js": 'import"./shared-interop.js";',
    "assets/shared-interop.js": 'import"./site-entry-a1b2c3.js";',
    "assets/site-entry-a1b2c3.js": MOUNTED_ENTRY,
  });
  t.after(remove);

  const result = checkQaScriptGraph(dist);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "qa-graph-reaches-site-entry");
  assert.equal(result.ok === false && result.detail, join("assets", "site-entry-a1b2c3.js"));
});

test("a reachable chunk that carries the mount but is not index.html's target is refused", (t) => {
  const { dist, remove } = buildTree({
    "index.html": '<script type="module" src="/assets/main-a1b2c3.js"></script>',
    "qa/retrieval.html": QA_HTML,
    "assets/main-a1b2c3.js": 'export const boot = 1;',
    "assets/qa-retrieval-x.js": 'import"./shared-interop.js";',
    "assets/shared-interop.js": 'import"./legacy-site-chunk.js";',
    "assets/legacy-site-chunk.js": MOUNTED_ENTRY,
  });
  t.after(remove);

  const result = checkQaScriptGraph(dist);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "qa-graph-contains-site-mount");
  assert.equal(result.ok === false && result.detail, join("assets", "legacy-site-chunk.js"));
});

test("the isolated layout passes while the site entry keeps its mount", (t) => {
  const { dist, remove } = buildTree({
    "index.html": SITE_HTML,
    "qa/retrieval.html": QA_HTML,
    "assets/qa-retrieval-x.js": 'import"./shared-interop.js";',
    "assets/shared-interop.js": 'export const shared = 1;',
    "assets/site-entry-a1b2c3.js": MOUNTED_ENTRY,
  });
  t.after(remove);

  const result = checkQaScriptGraph(dist);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.scripts, 2);
});

guardedTest(
  qaArtifacts(),
  "the built QA document's script graph carries no site mount",
  () => {
    const dist = join(REPO_ROOT, "dist");
    const result = checkQaScriptGraph(dist);
    assert.equal(result.ok, true);

    // The refusal above only means something if the mount exists somewhere it belongs.
    const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
    const siteScripts = [...indexHtml.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) =>
      join(dist, match[1].replace(/^\//, "")),
    );
    assert.ok(
      siteScripts.some((file) => existsSync(file) && readFileSync(file, "utf8").includes(MOUNT)),
      "the site entry must still carry the top-level mount",
    );
  },
);

skipLedgerMarker();
