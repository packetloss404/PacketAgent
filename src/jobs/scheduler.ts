import type { JobRecord } from "../packetagent-store.js";
import {
  cancelJobAsync,
  claimNextJobAsync,
  enqueueRecurringJobAsync,
  findJobAsync,
  maintainScheduledAgentJobsAsync,
  sweepStaleRunningJobsAsync,
  updateJobAsync,
} from "./store.js";
import { nextAfter, nextAfterInTimezone } from "./cron.js";
import { redactedErrorMessage } from "../security/redaction.js";
import type { SchedulerLeaderLock } from "./scheduler-lock.js";
import { noopLeaderLock } from "./scheduler-lock.js";
import { recordJobRun, type JobMetricStatus } from "./scheduler-metrics.js";
import {
  recordSchedulerStart,
  recordSchedulerStop,
  recordTickEnd,
  recordTickStart,
} from "./scheduler-heartbeat.js";
import { __setSchedulerLeaderProbe } from "../operations-status.js";
import {
  WORKER_OPERATOR_CANCEL_REASON,
  WORKER_SCHEDULER_SHUTDOWN_REASON,
} from "../workers/runtime/supervisor.js";

export interface JobHandlerContext {
  signal: AbortSignal;
}

export interface JobHandler {
  type: string;
  handle(job: JobRecord, ctx: JobHandlerContext): Promise<unknown>;
}

export interface SchedulerReconciler {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<unknown>;
}

export class JobDeferredError extends Error {
  readonly retryAt: string;

  constructor(message: string, retryAt: Date) {
    super(message);
    this.name = "JobDeferredError";
    this.retryAt = retryAt.toISOString();
  }
}

export class JobReleasedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobReleasedError";
  }
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt - 1), BACKOFF_CAP_MS);
}

/**
 * Identifies the fail-closed error thrown by the HTTP leader coordinator on a
 * 401/403 (see scheduler-http-coordinator.ts). That error is raised deliberately
 * so the scheduler does NOT treat an auth failure as "I am the leader". We must
 * never swallow it silently.
 */
function isCoordinatorAuthError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith("scheduler leader coordinator returned ")
  );
}

export class JobScheduler {
  private handlers = new Map<string, JobHandler>();
  private reconcilers = new Map<string, SchedulerReconciler & { lastStartedAt: number }>();
  private polling = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = new Map<string, AbortController>();
  private pollIntervalMs: number;
  private cancelWatchMs: number;
  private leaderLock: SchedulerLeaderLock;

  constructor(
    opts: {
      pollIntervalMs?: number;
      cancelWatchMs?: number;
      leaderLock?: SchedulerLeaderLock;
    } = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.cancelWatchMs = opts.cancelWatchMs ?? 500;
    this.leaderLock = opts.leaderLock ?? noopLeaderLock();
  }

  register(handler: JobHandler): void {
    this.handlers.set(handler.type, handler);
  }

  registerReconciler(reconciler: SchedulerReconciler): void {
    if (
      !reconciler.name.trim() ||
      !Number.isSafeInteger(reconciler.intervalMs) ||
      reconciler.intervalMs < 1_000
    ) {
      throw new Error("Scheduler reconciler requires a name and an interval of at least 1000ms.");
    }
    this.reconcilers.set(reconciler.name, {
      ...reconciler,
      lastStartedAt: 0,
    });
  }

  start(): void {
    if (this.polling) return;
    for (const reconciler of this.reconcilers.values()) {
      reconciler.lastStartedAt = 0;
    }
    this.polling = true;
    void maintainScheduledAgentJobsAsync().catch(() => undefined);
    void sweepStaleRunningJobsAsync().catch(() => undefined);
    __setSchedulerLeaderProbe(() => this.leaderLock.isHeld());
    recordSchedulerStart();
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const ctrl of this.inFlight.values()) ctrl.abort(WORKER_SCHEDULER_SHUTDOWN_REASON);
    if (this.leaderLock.isHeld()) {
      try {
        await this.leaderLock.release();
      } catch {
        /* ignore */
      }
    }
    const cutoff = Date.now() + 30_000;
    while (this.inFlight.size > 0 && Date.now() < cutoff) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    __setSchedulerLeaderProbe(null);
    recordSchedulerStop();
  }

  private scheduleNext(ms: number): void {
    if (!this.polling) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    if (!this.polling) return;
    recordTickStart();
    try {
      try {
        const isLeader = await this.leaderLock.acquire();
        if (!isLeader) {
          this.scheduleNext(this.pollIntervalMs);
          return;
        }
        await this.runDueReconcilers();
        const job = await claimNextJobAsync(new Date());
        if (job) {
          void this.runJob(job).catch((error) => {
            console.warn(
              `scheduler: unhandled error running job ${job.id} (${redactedErrorMessage(error)})`,
            );
          });
          this.scheduleNext(0);
          return;
        }
      } catch (error) {
        // Surface outages and coordinator failures instead of silently spinning.
        // The HTTP leader coordinator intentionally throws on 401/403 so that an
        // auth failure does NOT fail-open to "everyone is leader"; make it loud.
        if (isCoordinatorAuthError(error)) {
          console.error(
            `scheduler: leader coordinator authentication failed; refusing to fail open (${redactedErrorMessage(error)})`,
          );
        } else {
          console.warn(`scheduler: tick failed (${redactedErrorMessage(error)})`);
        }
      }
      this.scheduleNext(this.pollIntervalMs);
    } finally {
      recordTickEnd();
    }
  }

  private async runDueReconcilers(): Promise<void> {
    const timestamp = Date.now();
    for (const reconciler of this.reconcilers.values()) {
      if (timestamp - reconciler.lastStartedAt < reconciler.intervalMs) {
        continue;
      }
      reconciler.lastStartedAt = timestamp;
      try {
        await reconciler.run();
      } catch (error) {
        console.warn(
          `scheduler: reconciler ${reconciler.name} failed (${redactedErrorMessage(error)})`,
        );
      }
    }
  }

  private async runJob(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.type);
    const ctrl = new AbortController();
    this.inFlight.set(job.id, ctrl);
    const cancelWatcher = setInterval(() => {
      void findJobAsync(job.id)
        .then((fresh) => {
          if (fresh?.cancelRequested) ctrl.abort(WORKER_OPERATOR_CANCEL_REASON);
        })
        .catch(() => undefined);
    }, this.cancelWatchMs);
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const recordTerminal = (status: JobMetricStatus): void => {
      recordJobRun({
        type: job.type,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        status,
      });
    };
    try {
      if (!handler) {
        recordTerminal("failed");
        await updateJobAsync(job.id, {
          status: "failed",
          error: `no handler registered for type "${job.type}"`,
          completedAt: new Date().toISOString(),
        });
        return;
      }
      const result = await handler.handle(job, { signal: ctrl.signal });
      if (ctrl.signal.aborted) {
        if (ctrl.signal.reason === WORKER_SCHEDULER_SHUTDOWN_REASON) {
          await this.releaseJob(job);
          return;
        }
        recordTerminal("canceled");
        await cancelJobAsync(job.id);
        await updateJobAsync(job.id, { status: "canceled", completedAt: new Date().toISOString() });
        return;
      }
      recordTerminal("success");
      await updateJobAsync(job.id, {
        status: "success",
        result,
        completedAt: new Date().toISOString(),
      });
      if (job.cron) {
        let next: Date;
        try {
          const timezone =
            job.type === "worker.activate.cron" && typeof job.payload.timezone === "string"
              ? job.payload.timezone
              : undefined;
          next = timezone
            ? nextAfterInTimezone(job.cron, new Date(), timezone)
            : nextAfter(job.cron, new Date());
        } catch (cronError) {
          // Invalid cron expression: stop recurring (terminal, not transient).
          console.warn(
            `scheduler: stopping recurrence for job ${job.id}; invalid cron expression (${redactedErrorMessage(cronError)})`,
          );
          return;
        }
        try {
          await enqueueRecurringJobAsync(job, next.toISOString());
        } catch (enqueueError) {
          // Transient store failure: surface it rather than silently dropping the
          // schedule, which would stop recurrence forever.
          console.warn(
            `scheduler: failed to re-enqueue recurring job ${job.id} (${redactedErrorMessage(enqueueError)})`,
          );
        }
      }
    } catch (error) {
      // Failure-handling itself awaits store writes; if those reject the rejection
      // would otherwise escape this async method and (with Node's default
      // unhandledRejection=throw) crash the scheduler process. Guard them so a
      // store error while handling a job failure can never escape.
      try {
        if (error instanceof JobDeferredError) {
          await updateJobAsync(job.id, {
            status: "queued",
            attempts: Math.max(0, job.attempts - 1),
            error: undefined,
            scheduledAt: error.retryAt,
            startedAt: undefined,
          });
          return;
        }
        if (
          error instanceof JobReleasedError ||
          ctrl.signal.reason === WORKER_SCHEDULER_SHUTDOWN_REASON
        ) {
          await this.releaseJob(job);
          return;
        }
        const fresh = await findJobAsync(job.id);
        if (fresh?.cancelRequested || ctrl.signal.aborted) {
          recordTerminal("canceled");
          await updateJobAsync(job.id, {
            status: "canceled",
            error: redactedErrorMessage(error),
            completedAt: new Date().toISOString(),
          });
          return;
        }
        if (job.attempts < job.maxAttempts) {
          // retry path: do not record metrics; only terminal outcomes are tracked.
          const next = new Date(Date.now() + backoffMs(job.attempts));
          await updateJobAsync(job.id, {
            status: "queued",
            error: redactedErrorMessage(error),
            scheduledAt: next.toISOString(),
            startedAt: undefined,
          });
        } else {
          recordTerminal("failed");
          await updateJobAsync(job.id, {
            status: "failed",
            error: redactedErrorMessage(error),
            completedAt: new Date().toISOString(),
          });
        }
      } catch (storeError) {
        console.warn(
          `scheduler: failed to persist failure outcome for job ${job.id} (${redactedErrorMessage(storeError)})`,
        );
      }
    } finally {
      clearInterval(cancelWatcher);
      this.inFlight.delete(job.id);
    }
  }

  private async releaseJob(job: JobRecord): Promise<void> {
    await updateJobAsync(job.id, {
      status: "queued",
      attempts: Math.max(0, job.attempts - 1),
      error: undefined,
      scheduledAt: new Date().toISOString(),
      startedAt: undefined,
    });
  }
}
