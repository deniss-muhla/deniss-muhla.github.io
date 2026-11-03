import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  QaDeadlineError,
  RETRIEVAL_QA_LIMITS,
  cleanupReportingFailure,
  createCleanupLedger,
  qaLimits,
  withDeadline,
  withOwnedDeadline,
  type CleanupLedger,
  type CleanupRecord,
} from "../scripts/qa-deadlines.ts";

/** Stands in for a browser call that never answers. */
function stalled<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

test("the declared limits are the recorded 120 s load and 10 s per-query bounds", () => {
  assert.deepEqual(RETRIEVAL_QA_LIMITS, { loadMs: 120_000, queryMs: 10_000, runMs: 600_000 });
});

test("limits can be injected so a test does not sleep the real ones", () => {
  assert.deepEqual(qaLimits({ loadMs: 25 }), { loadMs: 25, queryMs: 10_000, runMs: 600_000 });
  assert.deepEqual(qaLimits({ loadMs: 0, queryMs: 0, runMs: 0 }), { loadMs: 0, queryMs: 0, runMs: 0 });
  assert.deepEqual(qaLimits(), RETRIEVAL_QA_LIMITS);
});

test("a stalled load fails with its own label instead of hanging", async () => {
  const limits = qaLimits({ loadMs: 25 });
  const startedAt = Date.now();

  await assert.rejects(withDeadline("model-load", limits.loadMs, stalled<void>()), (error: unknown) => {
    assert.ok(error instanceof QaDeadlineError);
    assert.equal(error.reason, "qa/deadline");
    assert.equal(error.label, "model-load");
    assert.equal(error.limitMs, 25);
    return true;
  });

  assert.ok(Date.now() - startedAt < 2_000, "the deadline fired instead of waiting for the page");
});

test("a stalled query is bounded by the per-query limit, not the load limit", async () => {
  const limits = qaLimits({ loadMs: 600_000, queryMs: 20 });
  const startedAt = Date.now();

  await assert.rejects(withDeadline("query:case-3", limits.queryMs, stalled<void>()), {
    name: "QaDeadlineError",
    message: "qa-deadline:query:case-3:20ms",
  });

  assert.ok(Date.now() - startedAt < 2_000);
});

test("work that settles first keeps its value and leaves no pending deadline", async () => {
  assert.equal(await withDeadline("fast", 5_000, Promise.resolve("resolved")), "resolved");

  // A deadline that never fires must not reject later, which a left timer would do.
  await withDeadline("fast", 30, Promise.resolve("resolved"));
  await new Promise((done) => setTimeout(done, 60));
});

test("a rejection from the work passes through unchanged", async () => {
  const failure = new QaDeadlineError("inner", 1);

  await assert.rejects(withDeadline("outer", 5_000, Promise.reject(failure)), (error: unknown) => {
    assert.equal(error, failure);
    return true;
  });
});

test("a deadline that loses the race leaves the abandoned promise harmless", async () => {
  const abandoned = withDeadline<never>("slow", 20, stalled<never>());

  await assert.rejects(abandoned);

  // The browser call that lost settles afterwards; its rejection must stay handled.
  const late = new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late failure")), 40));
  await assert.rejects(withDeadline("first", 10, late));
});

test("cleanup closes later registrations first and records each outcome", async () => {
  const ledger = createCleanupLedger(200);
  const order: string[] = [];

  ledger.register("server", () => {
    order.push("server");
  });
  ledger.register("browser", async () => {
    order.push("browser");
  });

  assert.deepEqual(ledger.pending(), ["server", "browser"]);

  const records = await ledger.drain();

  assert.deepEqual(order, ["browser", "server"]);
  assert.deepEqual(records, [
    { name: "browser", closed: true, detail: "closed" },
    { name: "server", closed: true, detail: "closed" },
  ]);
  assert.deepEqual(ledger.pending(), []);
});

test("a resource that never closes is recorded as unconfirmed and does not block the rest", async () => {
  const closeMs = 25;
  const ledger = createCleanupLedger(closeMs);
  let serverClosed = false;

  ledger.register("server", () => {
    serverClosed = true;
  });
  ledger.register("browser", () => stalled<void>());

  const startedAt = Date.now();
  const records = await ledger.drain();
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(records, [
    { name: "browser", closed: false, detail: "not-confirmed-after-25ms" },
    { name: "server", closed: true, detail: "closed" },
  ]);
  // A timer is allowed to fire a little early, so the bound is read with a millisecond of slack.
  assert.ok(elapsed >= closeMs - 1 && elapsed < 2_000, `the stalled close was bounded, it took ${elapsed}ms`);
  assert.equal(serverClosed, true);
  assert.deepEqual(ledger.pending(), []);
});

test("a failing close is recorded instead of thrown, so the run still ends", async () => {
  const ledger = createCleanupLedger(200);

  ledger.register("server", () => {
    throw new Error("synthetic close failure");
  });

  assert.deepEqual(await ledger.drain(), [{ name: "server", closed: false, detail: "close-failed" }]);
});

test("draining twice is a no-op, so success and failure paths can both call it", async () => {
  const ledger = createCleanupLedger(200);

  ledger.register("server", () => undefined);

  assert.equal((await ledger.drain()).length, 1);
  assert.deepEqual(await ledger.drain(), []);
});

test("two drain callers join one close of each resource", async () => {
  const ledger = createCleanupLedger(5_000);
  let closes = 0;

  ledger.register("browser", async () => {
    await new Promise((done) => setTimeout(done, 30));
    closes += 1;
  });

  const first = ledger.drain();
  // A second caller while the first close is still running, which is what a run unwinding
  // into its own drain looks like while the whole-run deadline drains the same ledger.
  const second = ledger.drain();

  assert.equal(second, first, "an overlapping drain joins the drain already running");
  assert.deepEqual(ledger.pending(), ["browser"], "the name being closed is not closed yet");

  const expected = [{ name: "browser", closed: true, detail: "closed" }];

  assert.deepEqual(await first, expected);
  assert.deepEqual(await second, expected, "both callers await the outcome of the one close");
  assert.equal(closes, 1, "the handle was closed once");
});

/**
 * The cases below drive the whole-run runner with the browser and the server a QA run owns
 * standing in as close handles, and a page call that never answers. Registering the handles
 * and draining the ledger in `finally`, without deciding from how much is left, mirrors what
 * `main()` does around its work.
 */
test("the whole-run deadline closes the run's own handles before the runner rejects", async () => {
  const closedAt: string[] = [];
  const reported: CleanupRecord[] = [];

  const run = async (cleanup: CleanupLedger): Promise<unknown> => {
    cleanup.register("server", () => {
      closedAt.push("server");
    });
    // A close that takes real time, so a deadline that did not wait for cleanup could not
    // pass this by accident.
    cleanup.register("browser", async () => {
      await new Promise((done) => setTimeout(done, 15));
      closedAt.push("browser");
    });

    try {
      return await stalled<unknown>();
    } finally {
      reported.push(...(await cleanup.drain()));
    }
  };

  await assert.rejects(withOwnedDeadline("whole-run", 40, run, { onCleanup: (records) => reported.push(...records) }), (error: unknown) => {
    assert.ok(error instanceof QaDeadlineError);
    assert.equal(error.label, "whole-run");
    assert.equal(error.limitMs, 40);
    assert.deepEqual(closedAt, ["browser", "server"], "the owned handles closed before the runner settled");
    return true;
  });

  assert.deepEqual(reported, [
    { name: "browser", closed: true, detail: "closed" },
    { name: "server", closed: true, detail: "closed" },
  ]);
});

test("a handle is closed once even though the abandoned work still drains the same ledger", async () => {
  const closedAt: string[] = [];
  const reported: CleanupRecord[] = [];

  const run = async (cleanup: CleanupLedger): Promise<unknown> => {
    cleanup.register("server", () => {
      closedAt.push("server");
    });

    try {
      // A stalled page call that gives up on its own bound after the run has already ended,
      // so the work unwinds into its own drain after the deadline's drain.
      return await withDeadline("model-load", 120, stalled<unknown>());
    } finally {
      await cleanup.drain();
    }
  };

  await assert.rejects(withOwnedDeadline("whole-run", 40, run, { onCleanup: (records) => reported.push(...records) }), {
    name: "QaDeadlineError",
    message: "qa-deadline:whole-run:40ms",
  });

  // The abandoned work's own deadline fires later; its drain must find nothing left.
  await new Promise((done) => setTimeout(done, 200));

  assert.deepEqual(closedAt, ["server"]);
  assert.deepEqual(reported, [{ name: "server", closed: true, detail: "closed" }]);
});

test("a load or query deadline inside the run keeps its own error and still closes once", async () => {
  const limits = qaLimits({ runMs: 5_000, loadMs: 25 });
  const closedAt: string[] = [];
  const reported: CleanupRecord[] = [];

  const run = async (cleanup: CleanupLedger): Promise<unknown> => {
    cleanup.register("server", () => {
      closedAt.push("server");
    });
    cleanup.register("browser", () => {
      closedAt.push("browser");
    });

    try {
      return await withDeadline("model-load", limits.loadMs, stalled<unknown>());
    } finally {
      await cleanup.drain();
    }
  };

  await assert.rejects(withOwnedDeadline("whole-run", limits.runMs, run, { onCleanup: (records) => reported.push(...records) }), {
    name: "QaDeadlineError",
    message: "qa-deadline:model-load:25ms",
  });

  assert.deepEqual(closedAt, ["browser", "server"]);
  assert.deepEqual(reported, []);
});

test("a close that never returns is bounded and reported beside the deadline, not in place of it", async () => {
  const reported: CleanupRecord[] = [];

  await assert.rejects(
    withOwnedDeadline(
      "whole-run",
      40,
      (cleanup) => {
        cleanup.register("browser", () => stalled<void>());

        return stalled<unknown>();
      },
      { closeMs: 25, onCleanup: (records) => reported.push(...records) },
    ),
    (error: unknown) => {
      // The deadline stays the error the run fails with; the unconfirmed close is separate
      // evidence reported beside it.
      assert.ok(error instanceof QaDeadlineError);
      assert.equal(error.label, "whole-run");
      return true;
    },
  );

  assert.deepEqual(reported, [{ name: "browser", closed: false, detail: "not-confirmed-after-25ms" }]);
});

test("a completed run keeps its result, closes once and reports nothing twice", async () => {
  const closedAt: string[] = [];
  const reported: CleanupRecord[] = [];

  const run = async (cleanup: CleanupLedger): Promise<string> => {
    cleanup.register("browser", () => {
      closedAt.push("browser");
    });

    const value = await Promise.resolve("report-written");
    reported.push(...(await cleanup.drain()));

    return value;
  };

  assert.equal(await withOwnedDeadline("whole-run", 5_000, run, { onCleanup: (records) => reported.push(...records) }), "report-written");
  assert.deepEqual(closedAt, ["browser"]);
  // The run's own drain reported the close, so the runner's drain of the same ledger finds
  // nothing left to close and reports no second copy of it.
  assert.deepEqual(reported, [{ name: "browser", closed: true, detail: "closed" }]);
});

test("a run with no reporter still closes what it owns", async () => {
  const closedAt: string[] = [];

  // Nothing reports the outcome here, which must not switch the cleanup off: a close the
  // run started is still owed whether or not anyone is listening for the result.
  const run = async (cleanup: CleanupLedger): Promise<unknown> => {
    cleanup.register("server", () => {
      closedAt.push("server");
    });
    cleanup.register("browser", async () => {
      await new Promise((done) => setTimeout(done, 15));
      closedAt.push("browser");
    });

    return await stalled<unknown>();
  };

  await assert.rejects(withOwnedDeadline("whole-run", 40, run), {
    name: "QaDeadlineError",
    message: "qa-deadline:whole-run:40ms",
  });

  assert.deepEqual(closedAt, ["browser", "server"]);
});

test("the runner waits for the drain the work already started instead of settling beside it", async () => {
  const closedAt: string[] = [];
  const reported: CleanupRecord[] = [];
  let browserCloses = 0;

  // `main()`'s shape: a run that finishes its work and unwinds into its own drain, with a
  // browser close slower than the whole-run deadline, so the deadline fires mid-drain.
  const run = async (cleanup: CleanupLedger): Promise<string> => {
    cleanup.register("server", () => {
      closedAt.push("server");
    });
    cleanup.register("browser", async () => {
      browserCloses += 1;
      await new Promise((done) => setTimeout(done, 150));
      closedAt.push("browser");
    });

    try {
      await new Promise((done) => setTimeout(done, 25));
      return "first-case-answered";
    } finally {
      reported.push(...(await cleanup.drain()));
    }
  };

  const startedAt = Date.now();

  await assert.rejects(withOwnedDeadline("whole-run", 40, run, { closeMs: 5_000, onCleanup: (records) => reported.push(...records) }), (error: unknown) => {
    assert.ok(error instanceof QaDeadlineError);
    assert.equal(error.label, "whole-run");
    assert.deepEqual(closedAt, ["browser", "server"], "the close in flight had finished before the runner settled");
    return true;
  });

  assert.ok(Date.now() - startedAt >= 150, "the runner waited for the close that was running");
  assert.equal(browserCloses, 1, "the handle was closed once for both callers");
  // The run and the runner awaited the same drain, so each reports the close it confirmed.
  assert.deepEqual(reported, [
    { name: "browser", closed: true, detail: "closed" },
    { name: "server", closed: true, detail: "closed" },
    { name: "browser", closed: true, detail: "closed" },
    { name: "server", closed: true, detail: "closed" },
  ]);
});

test("a reporter that throws keeps the run's own error and records the reporting failure", async () => {
  const failure = new Error("synthetic work failure");
  const closedAt: string[] = [];

  const run = async (cleanup: CleanupLedger): Promise<never> => {
    cleanup.register("browser", () => {
      closedAt.push("browser");
    });

    throw failure;
  };

  const thrown = await withOwnedDeadline("whole-run", 5_000, run, {
    onCleanup: () => {
      throw new Error("synthetic reporting failure");
    },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.equal(thrown, failure, "the run's own error propagates, not the reporter's");
  assert.equal(cleanupReportingFailure(thrown)?.message, "synthetic reporting failure");
  assert.deepEqual(closedAt, ["browser"], "cleanup ran before the reporter was called");

  // The same protection holds when the deadline, not the work, is what failed the run.
  const deadlineFailure = await withOwnedDeadline(
    "whole-run",
    30,
    async (cleanup) => {
      cleanup.register("browser", () => undefined);
      return await stalled<never>();
    },
    {
      onCleanup: () => {
        throw new Error("synthetic reporting failure");
      },
    },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.ok(deadlineFailure instanceof QaDeadlineError);
  assert.equal(deadlineFailure.label, "whole-run");
  assert.equal(cleanupReportingFailure(deadlineFailure)?.message, "synthetic reporting failure");
});

test("a reporter that throws after a successful run is itself the run's failure", async () => {
  const closedAt: string[] = [];

  await assert.rejects(
    withOwnedDeadline(
      "whole-run",
      5_000,
      async (cleanup) => {
        cleanup.register("browser", () => {
          closedAt.push("browser");
        });

        return "report-written";
      },
      {
        onCleanup: () => {
          throw new Error("synthetic reporting failure");
        },
      },
    ),
    { message: "synthetic reporting failure" },
  );

  assert.deepEqual(closedAt, ["browser"]);
});

/**
 * The cases below own a resource the run is still acquiring, the way `main()` owns the server
 * and the browser before either handle exists. The whole-run deadline can then reach an
 * acquisition that never answers, report it as unresolved ownership, and still close a handle
 * that arrives afterwards.
 */
test("an acquisition that resolves after the whole-run deadline is reported unresolved, closed once and starts nothing", async () => {
  const closeMs = 25;
  const reported: CleanupRecord[] = [];
  const late: CleanupRecord[] = [];
  const started: string[] = [];
  let closes = 0;
  let arrive: ((handle: { origin: string }) => void) | undefined;

  const run = async (cleanup: CleanupLedger): Promise<unknown> => {
    const server = await cleanup.registerAcquisition(
      "server",
      () =>
        new Promise<{ origin: string }>((resolve) => {
          arrive = resolve;
        }),
      (handle) => {
        closes += 1;
        assert.equal(handle.origin, "http://127.0.0.1:1");
      },
      (record) => late.push(record),
    );

    // `main()`'s guard: nothing is started from a handle the run no longer needs. Without it
    // this would enter the next operation, which is the work the deadline already gave up on.
    if (cleanup.ended()) return "unwound";

    started.push(`wait-for-server:${server.origin}`);
    return await withDeadline("wait-for-server", 5_000, stalled<unknown>());
  };

  const settledAt = Date.now();

  await assert.rejects(withOwnedDeadline("whole-run", 40, run, { closeMs, onCleanup: (records) => reported.push(...records) }), {
    name: "QaDeadlineError",
    message: "qa-deadline:whole-run:40ms",
  });

  assert.ok(Date.now() - settledAt < 2_000, "the unresolved acquisition cost one bounded close");
  assert.deepEqual(reported, [{ name: "server", closed: false, detail: "acquisition-unresolved-after-25ms" }], "ownership was reported unresolved, not closed");
  assert.deepEqual(started, [], "no operation is entered from a handle that arrived after the run ended");
  assert.equal(closes, 0, "nothing existed to close while the server was still starting");

  // The server finishes starting after the runner has settled and given up on it.
  arrive?.({ origin: "http://127.0.0.1:1" });
  await new Promise((done) => setTimeout(done, 50));

  assert.equal(closes, 1, "the handle that arrived late is closed once");
  assert.deepEqual(late, [{ name: "server", closed: true, detail: "closed" }]);
});

test("a rejected acquisition is observed and reported instead of becoming an unhandled rejection", async () => {
  const closeMs = 25;
  const reported: CleanupRecord[] = [];
  const late: CleanupRecord[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  const failure = new Error("synthetic acquisition failure");
  let fail: ((error: Error) => void) | undefined;

  process.on("unhandledRejection", onUnhandled);

  try {
    const run = async (cleanup: CleanupLedger): Promise<unknown> => {
      await cleanup.registerAcquisition(
        "server",
        () =>
          new Promise<never>((_resolve, reject) => {
            fail = reject;
          }),
        () => undefined,
        (record) => late.push(record),
      );

      return "unreached";
    };

    await assert.rejects(withOwnedDeadline("whole-run", 40, run, { closeMs, onCleanup: (records) => reported.push(...records) }), {
      message: "qa-deadline:whole-run:40ms",
    });

    assert.deepEqual(reported, [{ name: "server", closed: false, detail: "acquisition-unresolved-after-25ms" }]);

    // The server that never started fails after the runner settled. Its rejection is read, so
    // it is reported as what happened instead of surfacing as an unhandled rejection.
    fail?.(failure);
    await new Promise((done) => setTimeout(done, 50));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(late, [{ name: "server", closed: false, detail: "acquisition-failed" }]);
  assert.deepEqual(unhandled, []);
});

test("a late close that fails or is not confirmed in time is reported within the close bound", async () => {
  const closeMs = 25;
  const late: CleanupRecord[] = [];
  const arrive: Record<string, (handle: unknown) => void> = {};

  const run = async (cleanup: CleanupLedger): Promise<unknown> => {
    // Both acquisitions start, so the deadline owns both before either has a handle.
    await Promise.all([
      cleanup.registerAcquisition(
        "browser",
        () =>
          new Promise((resolve) => {
            arrive.browser = resolve;
          }),
        () => {
          throw new Error("synthetic close failure");
        },
        (record) => late.push(record),
      ),
      cleanup.registerAcquisition(
        "server",
        () =>
          new Promise((resolve) => {
            arrive.server = resolve;
          }),
        () => stalled<void>(),
        (record) => late.push(record),
      ),
    ]);

    return "unreached";
  };

  await assert.rejects(withOwnedDeadline("whole-run", 40, run, { closeMs }), { message: "qa-deadline:whole-run:40ms" });

  const startedAt = Date.now();

  arrive.browser?.("browser-context");
  arrive.server?.("server-handle");
  await new Promise((done) => setTimeout(done, 150));
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(late, [
    { name: "browser", closed: false, detail: "close-failed" },
    { name: "server", closed: false, detail: "not-confirmed-after-25ms" },
  ]);
  assert.ok(elapsed < 2_000, `the late closes were bounded, they took ${elapsed}ms`);
});

test("a handle the run's own drain closed is not closed again when the run ends", async () => {
  const late: CleanupRecord[] = [];
  let closes = 0;

  const run = async (cleanup: CleanupLedger): Promise<string> => {
    const server = await cleanup.registerAcquisition(
      "server",
      () => Promise.resolve({ origin: "http://127.0.0.1:4173" }),
      (handle) => {
        closes += 1;
        assert.equal(handle.origin, "http://127.0.0.1:4173");
      },
      (record) => late.push(record),
    );

    try {
      return `served-by-${server.origin}`;
    } finally {
      await cleanup.drain();
    }
  };

  assert.equal(await withOwnedDeadline("whole-run", 5_000, run, { closeMs: 200 }), "served-by-http://127.0.0.1:4173");
  assert.equal(closes, 1, "the handle that arrived in time is closed by the run's own drain");
  assert.deepEqual(late, [], "a handle the drain closed is neither closed nor reported twice");
});

test("the retrieval entry runs the whole-run deadline against the ledger it owns", () => {
  const script = readFileSync(new URL("../scripts/retrieval-qa.mjs", import.meta.url), "utf8");

  // The entry has to reach the deadline through the owned runner, not through a bare race:
  // the run's browser and server are registered into the ledger `main()` is given.
  assert.match(script, /withOwnedDeadline\("whole-run", limits\.runMs, run, \{ closeMs, onCleanup \}\)/);
  assert.match(script, /await boundRetrievalQaRun\(\(cleanup\) => main\(cleanup\)\)/);
  assert.match(script, /async function main\(cleanup\)/);
  // The entry waits for its own drain to finish rather than deciding from how much is left,
  // which would let the run settle while a close was still running.
  assert.match(script, /reportCleanup\(await cleanup\.drain\(\)\)/);
  assert.doesNotMatch(script, /pending\(\)\.length/);
  assert.doesNotMatch(script, /withDeadline\("whole-run"/);

  // Ownership is taken before the handles exist, so the deadline reaches a server or a browser
  // that is still starting, and each acquisition is followed by the guard that keeps a late
  // handle from starting the rest of the run.
  assert.match(script, /cleanup\.registerAcquisition\("server", start, \(handle\) => stopServer\(handle\.child\)/);
  assert.match(script, /browser = await cleanup\.registerAcquisition\(/);
  // The guards: one after each acquisition, and the one that reports work unwinding after the
  // deadline instead of reporting its failure again.
  assert.equal((script.match(/if \(cleanup\.ended\(\)\) \{/g) ?? []).length, 3, "both acquisitions are guarded");
  assert.doesNotMatch(script, /cleanup\.register\("(server|browser)"/);
});