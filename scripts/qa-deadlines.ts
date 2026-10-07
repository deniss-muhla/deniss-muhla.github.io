/**
 * Harness-side deadlines and cleanup for the QA entry points.
 *
 * A browser call can stop answering without failing: `page.evaluate` waits on the page's
 * reply and gives up only when the page goes away, so a stalled load or query would hang
 * the run before it could report the failure and close what it started. These helpers
 * bound the wait from this process instead, which is the only side that can always
 * report.
 *
 * The limits are values a check can inject, so a regression test exercises a stalled
 * load and a stalled query with millisecond bounds instead of the real ones.
 */

export interface QaLimits {
  /** The model load: the pinned graph over a metered connection. */
  readonly loadMs: number;
  /** One question, embedding and pooling included. */
  readonly queryMs: number;
  /** The whole run, so a run that leaks a wait still ends. */
  readonly runMs: number;
}

export const RETRIEVAL_QA_LIMITS: QaLimits = Object.freeze({
  loadMs: 120_000,
  queryMs: 10_000,
  runMs: 600_000,
});

/** How long one resource's close may take before it is recorded as unconfirmed. */
const DEFAULT_CLOSE_MS = 10_000;

export function qaLimits(overrides: Partial<QaLimits> = {}): QaLimits {
  return Object.freeze({
    loadMs: overrides.loadMs ?? RETRIEVAL_QA_LIMITS.loadMs,
    queryMs: overrides.queryMs ?? RETRIEVAL_QA_LIMITS.queryMs,
    runMs: overrides.runMs ?? RETRIEVAL_QA_LIMITS.runMs,
  });
}

export class QaDeadlineError extends Error {
  /** This module's own classified reason, like the rest of the project's refusals. */
  readonly reason = "qa/deadline";
  readonly label: string;
  readonly limitMs: number;

  constructor(label: string, limitMs: number) {
    super(`qa-deadline:${label}:${limitMs}ms`);
    this.name = "QaDeadlineError";
    this.label = label;
    this.limitMs = limitMs;
  }
}

/**
 * Fails with {@link QaDeadlineError} when `work` has not settled in `limitMs`.
 *
 * The timer is independent of the awaited promise and is always cleared, so a deadline
 * that the work beats leaves nothing pending, and a deadline that fires does not leave an
 * unhandled rejection behind when the abandoned promise settles later.
 */
export async function withDeadline<T>(label: string, limitMs: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new QaDeadlineError(label, limitMs)), limitMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface CleanupRecord {
  readonly name: string;
  readonly closed: boolean;
  readonly detail: string;
}

/** One registered resource. An acquisition carries the state a handle does not have yet. */
interface RegisteredResource {
  readonly name: string;
  close: () => Promise<unknown> | unknown;
  /** True once a handle exists: at once for a registered handle, later for an acquisition. */
  acquired: boolean;
  /** The handle an acquisition produced, once it has one. */
  handle: unknown;
  /** True once a drain has popped this registration. */
  dropped: boolean;
  /** True while a close owns this registration, so nothing closes it twice. */
  claimed: boolean;
  /** Set for an acquisition: closes a handle that arrives after a drain gave up on it. */
  lateClose?: () => void;
}

export interface CleanupLedger {
  /** Registers a resource this run owns. Later registrations close first. */
  register(name: string, close: () => Promise<unknown> | unknown): void;
  /**
   * Registers ownership of a resource the run is still acquiring, before its handle exists.
   *
   * The drain closes it like any other registration and gives up after `closeMs`, so an
   * acquisition that never answers costs one bounded close instead of holding the run open,
   * and it is recorded as unresolved ownership rather than as a closed resource. A handle
   * that arrives after that is closed on arrival, bounded and once, and reported to
   * `onLate`: the run that started it owns it even though its own work has stopped.
   */
  registerAcquisition<T>(
    name: string,
    acquire: () => Promise<T>,
    close: (handle: T) => Promise<unknown> | unknown,
    onLate?: (record: CleanupRecord) => void,
  ): Promise<T>;
  /**
   * Closes everything still registered, once, and resolves with what it could confirm.
   *
   * A drain that arrives while another one is running joins that drain instead of starting
   * a second one, so a resource is closed once and both callers settle on the outcome of
   * the close that actually ran.
   */
  drain(): Promise<readonly CleanupRecord[]>;
  /** The names whose close has not settled yet, the one in flight included. */
  pending(): readonly string[];
  /**
   * True once the run's own outcome is known: its work settled or the whole-run deadline
   * ended it. A resource that arrives after this must not start the next operation, because
   * nothing is left of the run to use it.
   */
  ended(): boolean;
  /** Records that the run's own outcome is known. {@link withOwnedDeadline} calls it. */
  end(): void;
}

/** What one failed close means, which differs while a handle is still being acquired. */
function failureDetail(entry: RegisteredResource, error: unknown, closeMs: number): string {
  if (error instanceof QaDeadlineError) {
    return entry.acquired ? `not-confirmed-after-${closeMs}ms` : `acquisition-unresolved-after-${closeMs}ms`;
  }

  return entry.acquired ? "close-failed" : "acquisition-failed";
}

/**
 * Closes the resources one run owns, in reverse order, each under its own deadline.
 */
export function createCleanupLedger(closeMs = DEFAULT_CLOSE_MS): CleanupLedger {
  const registered: RegisteredResource[] = [];
  let closing: string | undefined;
  let active: Promise<readonly CleanupRecord[]> | undefined;
  let runEnded = false;

  /**
   * Closes each registration once, in reverse order, one bounded close at a time.
   *
   * A close that never returns is recorded as not closed rather than holding the run
   * open, and a name is dropped from the ledger either way so one stuck resource cannot
   * block the rest.
   */
  async function closeEach(): Promise<readonly CleanupRecord[]> {
    const records: CleanupRecord[] = [];

    while (registered.length > 0) {
      const entry = registered.pop();

      if (entry === undefined) break;

      // The name leaves the registered list before its close is awaited, so `closing` is
      // what still reports it as open until that close settles.
      closing = entry.name;
      // A popped registration belongs to this close, so a handle that arrives while the
      // close is running is closed by this close instead of by a second one.
      entry.dropped = true;
      entry.claimed = true;

      try {
        await withDeadline(`cleanup:${entry.name}`, closeMs, Promise.resolve().then(() => entry.close()));
        records.push({ name: entry.name, closed: true, detail: "closed" });
      } catch (error) {
        // This close gives the registration up, so a handle that has not arrived yet is
        // still closed when it does.
        entry.claimed = false;
        entry.lateClose?.();
        records.push({ name: entry.name, closed: false, detail: failureDetail(entry, error, closeMs) });
      } finally {
        closing = undefined;
      }
    }

    return records;
  }

  return {
    register(name, close) {
      registered.push({ name, close, acquired: true, handle: undefined, dropped: false, claimed: false });
    },
    registerAcquisition,
    pending() {
      const queued = registered.map((entry) => entry.name);

      // A close in flight is not a closed resource: without its name here, a caller reading
      // `pending()` mid-drain would take an unfinished close for nothing left to do.
      return closing === undefined ? queued : [closing, ...queued];
    },
    drain() {
      if (active !== undefined) return active;

      const drain = closeEach();

      active = drain;
      // The gate opens once this drain settles, so the next call starts a new pass.
      void drain.then(endDrain, endDrain);

      return drain;
    },
    ended() {
      return runEnded;
    },
    end() {
      runEnded = true;
    },
  };

  function endDrain(): void {
    active = undefined;
  }

  /**
   * Owns a resource the run is still acquiring, so the run's deadline can reach it before it
   * has a handle to close.
   */
  function registerAcquisition<T>(
    name: string,
    acquire: () => Promise<T>,
    close: (handle: T) => Promise<unknown> | unknown,
    onLate?: (record: CleanupRecord) => void,
  ): Promise<T> {
    const entry: RegisteredResource = {
      name,
      close: () => undefined,
      acquired: false,
      handle: undefined,
      dropped: false,
      claimed: false,
    };
    const acquisition: Promise<T> = Promise.resolve().then(acquire);
    let closeStarted: Promise<unknown> | undefined;

    /** Closes the handle once and bounded, whichever caller gets there first. */
    const closeOnce = (handle: T): Promise<unknown> => {
      const started = (closeStarted ??= withDeadline(`late-cleanup:${name}`, closeMs, Promise.resolve().then(() => close(handle))));

      // A close this ledger's own bound abandons can have no other reader, so its rejection
      // is observed here instead of surfacing as an unhandled rejection.
      void started.catch(() => undefined);

      return started;
    };

    const report = (record: CleanupRecord): void => {
      if (onLate === undefined) return;

      try {
        onLate(record);
      } catch {
        // A reporter cannot take the process down on the late path either.
      }
    };

    entry.close = async () => {
      const handle = await acquisition;

      entry.acquired = true;
      entry.handle = handle;

      await closeOnce(handle);
    };

    entry.lateClose = () => {
      // The run's own drain closes a handle that arrives before it gives this registration
      // up, and a close that already started keeps it, so only a handle nothing owns yet is
      // closed here.
      if (!entry.dropped || entry.claimed || !entry.acquired || closeStarted !== undefined) return;

      entry.claimed = true;
      void closeOnce(entry.handle as T).then(
        () => report({ name, closed: true, detail: "closed" }),
        (error: unknown) => report({ name, closed: false, detail: failureDetail(entry, error, closeMs) }),
      );
    };

    registered.push(entry);

    // Both outcomes are read here: a handle that arrives late is closed, and a rejected
    // acquisition is observed instead of becoming an unhandled rejection.
    void acquisition.then(
      (handle) => {
        entry.acquired = true;
        entry.handle = handle;
        entry.lateClose?.();
      },
      () => {
        if (!entry.dropped || entry.claimed) return;

        report({ name, closed: false, detail: "acquisition-failed" });
      },
    );

    return acquisition;
  }
}

/** A cleanup reporter's failure, kept beside the error the run still fails with. */
const reportingFailures = new WeakMap<object, Error>();

/**
 * The failure from a cleanup reporter that threw while the run was already failing.
 *
 * The run's own error is the one that propagates, so the reporting failure stays a
 * separate fact instead of replacing it. Pass the value the runner threw to read it.
 */
export function cleanupReportingFailure(error: unknown): Error | undefined {
  return typeof error === "object" && error !== null ? reportingFailures.get(error) : undefined;
}

export interface OwnedDeadlineOptions {
  /** One resource's close bound, as in {@link createCleanupLedger}. */
  readonly closeMs?: number;
  /**
   * Receives what cleanup could confirm, separately from the error that propagates. It runs
   * on every path once the run's own resources are closed; an empty list means the run
   * closed them itself and there was nothing left to confirm.
   */
  readonly onCleanup?: (records: readonly CleanupRecord[]) => void;
}

/** How the run ended, so cleanup can protect that outcome from its own failures. */
type RunOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * Runs a whole run under a deadline that reaches the cleanup the run owns.
 *
 * {@link withDeadline} is a race and nothing more: the caller settles while the work keeps
 * running, so work stalled inside one of its waits never reaches its own `finally` and the
 * browser and the server it started stay open. Here the deadline drains the run's own
 * ledger before it settles, on every path: the work's own drain then finds nothing left, so
 * a name is closed once by the run that registered it, and a name the work registers after
 * that point is still closed when the work unwinds.
 *
 * That drain is unconditional and not something the reporter can switch off: closing what
 * the run owns is what the runner owes the process, and `onCleanup` only decides what is
 * reported about it. A resource the run is still acquiring is owned through
 * {@link CleanupLedger.registerAcquisition} instead of {@link CleanupLedger.register}, so the
 * deadline reaches a server or a browser that has not finished starting, and {@link CleanupLedger.ended}
 * tells a handle that arrives afterwards that the run no longer needs it.
 *
 * The error that propagates is always the work's own error, or the deadline error when the
 * deadline won, and a reporter that throws does not take that outcome away: on a failing run
 * its failure is kept beside the error through {@link cleanupReportingFailure}, while a
 * reporter that throws after a successful run is itself the run's failure. Cleanup evidence
 * goes to `onCleanup` and never replaces an error, so a timed-out wait and an unconfirmed
 * close stay two separate facts.
 */
export async function withOwnedDeadline<T>(
  label: string,
  limitMs: number,
  work: (ledger: CleanupLedger) => Promise<T>,
  options: OwnedDeadlineOptions = {},
): Promise<T> {
  const ledger = createCleanupLedger(options.closeMs ?? DEFAULT_CLOSE_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: RunOutcome<T>;

  // The outcome is captured instead of thrown straight through, because the cleanup below
  // has to know whether the run already failed before it can protect that failure.
  try {
    outcome = {
      ok: true,
      value: await Promise.race([
        work(ledger),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new QaDeadlineError(label, limitMs)), limitMs);
          timer.unref?.();
        }),
      ]),
    };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // The run's outcome is known here, including when the deadline won while the work kept
    // running, so a resource that arrives from behind can tell that no operation follows it.
    ledger.end();
  }

  // This runs while the work may still be running, so a deadline that won still closes what
  // the run owns before the caller sees it. A drain the work already started is joined
  // rather than raced, so this waits for the closes that are running instead of settling
  // next to them.
  const records = await ledger.drain();

  if (options.onCleanup !== undefined) {
    try {
      options.onCleanup(records);
    } catch (reportingError) {
      // Nothing here can let a reporter's failure stand in for the run's result: a run that
      // was already failing keeps its own error, and one that succeeded has only this
      // failure to fail with.
      if (outcome.ok) throw reportingError;
      if (typeof outcome.error === "object" && outcome.error !== null) {
        reportingFailures.set(outcome.error, reportingError as Error);
      }
    }
  }

  if (!outcome.ok) throw outcome.error;

  return outcome.value;
}
