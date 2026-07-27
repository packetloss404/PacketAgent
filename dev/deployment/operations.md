# Operations

This page covers everything you wire to your monitoring, on-call, and SIEM stack: health probes, the admin operations status and health endpoints, alert rules and webhook delivery, scheduler leader-election for multi-process deployments, and access-log shipping.

## Health probes

Three endpoints, two of them public:

| Endpoint                | Auth | Purpose                                                                                                                                         |
| ----------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health/live`  | none | Liveness. Always returns `200 { "status": "live" }`. No I/O, never fails for store degradation.                                                 |
| `GET /api/health/ready` | none | Readiness. Calls `loadStore()` once. `200 { "status": "ready" }` on success, `503 { "status": "not_ready", "error": "<redacted>" }` on failure. |
| `GET /api/health`       | none | Legacy compatibility shim. Returns `200 { "ok": true }`.                                                                                        |

The error string on a 503 readiness response passes through PacketAgent's redaction helper, so it is safe to surface in load-balancer logs but is intended for operator triage, not user display.

Wire `/api/health/live` to liveness probes (Kubernetes `livenessProbe`, container orchestrators) - it tolerates store degradation, because killing the process for a store hiccup usually makes the outage worse. Wire `/api/health/ready` to readiness probes and load-balancer health checks (Kubernetes `readinessProbe`, ALB target group health, GCP load balancer backend health, nginx upstream `health_check`) - it pulls a backend out of rotation when the store is unreachable.

```bash
curl -i http://localhost:8484/api/health/live
curl -i http://localhost:8484/api/health/ready
```

To exercise the failure path, point `PACKETAGENT_DB_PATH` at an unreadable file and confirm `/api/health/ready` returns `503` with a redacted `error`.

## Operator status endpoint

`GET /api/app/operations/status` is admin-scoped (RBAC: `admin` or `owner`) and returns a single payload covering the runtime configuration an operator most often needs in one place:

- `store.mode` - `json` or `sqlite`. Mirrors `PACKETAGENT_STORE`.
- `scheduler.leaderMode`, `scheduler.leaderTtlMs`, `scheduler.leaderHeldLocally`, `scheduler.lockSummary` - the live state of the scheduler leader-lock. `lockSummary` is `"local"` for `off` mode, the file path for `file` mode, or the URL with any query string stripped for `http` mode. It never contains a secret.
- `jobs[]` - one row per `type` with queued/running/succeeded/failed/canceled counts.
- `jobMetrics[]` - per-type latency snapshot (`totalRuns`, `succeededRuns`, `failedRuns`, `canceledRuns`, `lastDurationMs`, `averageDurationMs`, `p95DurationMs`). The metrics window is in-memory and resets on restart by design; tune size with `PACKETAGENT_SCHEDULER_METRICS_WINDOW_SIZE` (default 50).
- `jobMetricsSnapshots` - durable summary of persisted snapshots (`{ total, lastCapturedAt }`). See "Job metrics history" below for capture cadence.
- `accessLog.{mode, path, maxBytes, maxFiles}` - mirrors `PACKETAGENT_ACCESS_LOG_*` env knobs.
- `runtime.nodeVersion` - `process.versions.node`.
- Plus several deployment-readiness sub-reports (`storageTopology`, `managedDatabaseTopology`, `managedDatabaseRuntimeGuard`, `managedPostgresCapability`, `releaseReadiness`, `releaseEvidence`, ...) used by the Operations UI's Production Status tile.

Auth model: `401` without a session, `403` for non-admin/non-owner sessions, `200` for admin/owner. Same-origin and CSRF requirements do not apply because the route is read-only.

```bash
curl -H "Cookie: packetagent_session=$SESSION" http://localhost:8484/api/app/operations/status | jq
```

The endpoint requires session auth and is therefore not directly suitable for unattended monitoring. For long-running scrapes, ship access logs and queue depth out of band, or build a service-token wrapper that re-auths.

## Operator subsystem health

`GET /api/app/operations/health` is admin-scoped and returns per-subsystem health classifications with diagnostic detail.

```json
{
  "generatedAt": "2026-04-26T12:00:00.000Z",
  "overall": "ok",
  "subsystems": [
    { "name": "store", "status": "ok", "detail": "loaded successfully", "checkedAt": "..." },
    {
      "name": "scheduler",
      "status": "ok",
      "detail": "last tick 12ms ago, ticksSinceStart=4321",
      "checkedAt": "...",
      "observedAt": "..."
    },
    { "name": "accessLog", "status": "disabled", "detail": "access log is off", "checkedAt": "..." }
  ]
}
```

Subsystem classification:

- **store** - `ok` when `loadStore()` returns; `down` when it throws or returns a non-object.
- **scheduler** - `down` if `start()` was never called; `degraded` if no tick completed yet, or the last completed tick is older than 60 seconds; `ok` otherwise.
- **accessLog** - `disabled` when mode is `off`; `ok` for `stdout`, or `file` with the path present; `degraded` for `file` with parent directory present but file absent; `down` for `file` with no path or missing parent directory.

`overall` is the worst-of subsystem status, except `disabled` never poisons overall: a healthy deployment with access logging off still reports `overall: "ok"`.

The endpoint always returns `200` regardless of subsystem statuses; the consumer decides what to alert on. Auth is the same as `/api/app/operations/status` (session + admin/owner RBAC).

## Job metrics history

Per-type metrics are in-memory by default. To see trends across process restarts, capture durable snapshots:

```bash
# Capture a snapshot now (default 30-day retention).
npm run jobs:snapshot-metrics

# Override retention (older rows are pruned in the same call).
npm run jobs:snapshot-metrics -- --retention-days=90
```

Or wire the built-in cron:

| Env var                                           | Default      | Notes                                                                                               |
| ------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON`           | unset        | Five-field cron expression. When unset, no auto-snapshot runs (the explicit CLI remains available). |
| `PACKETAGENT_JOB_METRICS_SNAPSHOT_RETENTION_DAYS` | `30`         | Retention window in days.                                                                           |
| `PACKETAGENT_JOB_METRICS_SNAPSHOT_WORKSPACE_ID`   | `__system__` | Bookkeeping workspace id for the recurring job.                                                     |

`GET /api/app/operations/job-metrics/history?type=<type>&since=<iso>&until=<iso>&limit=<n>` returns persisted snapshots ascending by `capturedAt`. `limit` defaults to `100`, capped at `500`.

## Alerting

Three built-in rules evaluate on each cron tick and can post to a webhook:

- **subsystem-degraded** - fires `warning` for any subsystem with `status === "degraded"` in the health report.
- **subsystem-down** - fires `critical` for any subsystem with `status === "down"`.
- **job-failure-rate** - fires `warning` (or `critical` above 0.8) when `(failedRuns + canceledRuns) / totalRuns` exceeds the threshold and `totalRuns >= PACKETAGENT_ALERT_JOB_FAILURE_MIN_SAMPLES`.

Each event carries a stable `ruleId`, a `severity`, a `title`, a `detail`, an `observedAt` timestamp, and a `context` object describing the triggering subsystem or job type.

Webhook contract:

```http
POST <PACKETAGENT_ALERT_WEBHOOK_URL>
Content-Type: application/json
x-packetagent-alert-secret: <PACKETAGENT_ALERT_WEBHOOK_SECRET>
```

```json
{
  "alerts": [
    {
      "id": "<uuid>",
      "ruleId": "subsystem-degraded",
      "severity": "warning",
      "title": "Subsystem scheduler degraded",
      "detail": "last tick 92s ago",
      "observedAt": "2026-04-26T12:00:00.000Z",
      "context": { "subsystem": "scheduler", "status": "degraded", "observedAt": "..." }
    }
  ],
  "deliveredAt": "2026-04-26T12:00:00.073Z"
}
```

Delivery semantics:

- 2xx response: stored as `delivered: true`.
- Non-2xx, network error, or timeout: stored as `delivered: false` with a redacted `deliveryError` string. A retry job (`alerts.deliver`) is enqueued per failed event with the scheduler's existing 30s/exponential-backoff (capped at 1 hour) up to `PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS` total attempts. After exhaustion, the alert row is marked `deadLettered: true` and remains visible through the admin endpoint.

| Env var                                        | Default                      | Notes                                                                               |
| ---------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| `PACKETAGENT_ALERT_EVALUATE_CRON`              | unset                        | Five-field cron expression. Required to enable scheduled evaluation.                |
| `PACKETAGENT_ALERT_WEBHOOK_URL`                | unset                        | Webhook target. Without it, evaluations still run and persist but no webhook fires. |
| `PACKETAGENT_ALERT_WEBHOOK_SECRET`             | unset                        | Optional shared secret. When set, sent as the configured header on every request.   |
| `PACKETAGENT_ALERT_WEBHOOK_SECRET_HEADER`      | `x-packetagent-alert-secret` | Header name for the shared secret.                                                  |
| `PACKETAGENT_ALERT_WEBHOOK_TIMEOUT_MS`         | `5000`                       | Per-request timeout in milliseconds.                                                |
| `PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS`       | `3`                          | Total delivery attempts per alert (inline + retries).                               |
| `PACKETAGENT_ALERT_JOB_FAILURE_RATE_THRESHOLD` | `0.5`                        | Failure-ratio cutoff. Severity escalates to `critical` above 0.8.                   |
| `PACKETAGENT_ALERT_JOB_FAILURE_MIN_SAMPLES`    | `5`                          | Minimum `totalRuns` before `job-failure-rate` evaluates a job type.                 |
| `PACKETAGENT_ALERT_RETENTION_DAYS`             | `30`                         | Retention window for `data.alertEvents`. Older rows pruned on each tick.            |
| `PACKETAGENT_ALERT_WORKSPACE_ID`               | `__system__`                 | Bookkeeping workspace id for the recurring job.                                     |

Operators inspect alert history via `GET /api/app/operations/alerts?severity=<s>&since=<iso>&until=<iso>&limit=<n>` (admin-scoped), or the Operations page's Recent Alerts tile, which shows distinct badges for delivered, retrying, and dead-lettered.

A five-minute cron (`*/5 * * * *`) is reasonable for most deployments. Per-rule runtime suppression is not exposed; tune via env knobs (raise the failure-rate threshold or min-samples gate) or filter at the consumer (PagerDuty event rules, Slack workflow filter, custom router) by `ruleId`, `severity`, or `context` fields.

## Scheduler leader election

For multi-process deployments, enable the leader-election gate so only one process at a time dequeues new jobs. In-flight jobs already running in non-leader processes continue to run to completion; the gate only affects new dequeues.

Three modes:

- **off** (default): no coordination. Use this for single-process deployments. The scheduler runs as a single dequeuer.
- **file**: JSON file lock at `PACKETAGENT_SCHEDULER_LEADER_FILE_PATH` (default `data/scheduler-leader.json`). Suitable for multiple Node processes on the same host with reliable atomic `rename(2)` semantics. **Not safe on NFS, SMB, EFS, Azure Files, or other network filesystems.**
- **http**: external HTTP coordinator. Use once schedulers cross hosts, regions, or filesystems without shared atomic-rename semantics. PacketAgent calls `POST <url>/acquire` and `POST <url>/release` with a JSON body; the coordinator returns `{ "leader": true }` / `{ "acquired": true }` (or 409) to gate the tick. PacketAgent does not ship a coordinator service; build one against existing infrastructure (Redis with `SET NX PX`, Consul/etcd KV with TTLs, a tiny custom Hono service).

| Env var                                        | Default                                | Notes                                                                                                            |
| ---------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PACKETAGENT_SCHEDULER_LEADER_MODE`            | `off`                                  | `off`, `file`, or `http`.                                                                                        |
| `PACKETAGENT_SCHEDULER_LEADER_TTL_MS`          | `30000`                                | Lock TTL in milliseconds. Lock expires this long after the most recent acquire/renew.                            |
| `PACKETAGENT_SCHEDULER_LEADER_PROCESS_ID`      | `${hostname}-${pid}-${randomShortHex}` | Stable per-process identifier written into the lock record.                                                      |
| `PACKETAGENT_SCHEDULER_LEADER_FILE_PATH`       | `data/scheduler-leader.json`           | File-mode lock path. Must be on a local filesystem.                                                              |
| `PACKETAGENT_SCHEDULER_LEADER_HTTP_URL`        | unset                                  | Required when mode is `http`.                                                                                    |
| `PACKETAGENT_SCHEDULER_LEADER_HTTP_SECRET`     | unset                                  | Optional bearer secret sent as `Authorization: Bearer <secret>`.                                                 |
| `PACKETAGENT_SCHEDULER_LEADER_HTTP_TIMEOUT_MS` | `5000`                                 | Per-request HTTP timeout in milliseconds.                                                                        |
| `PACKETAGENT_SCHEDULER_LEADER_HTTP_FAIL_OPEN`  | unset (fail-closed)                    | Set to `true` to preserve the prior local leader belief on coordinator outages. Otherwise outages skip the tick. |

Handoff:

- Graceful exit: `release()` returns the lock immediately; the next process picks up on its next tick.
- Ungraceful exit: expect up to `PACKETAGENT_SCHEDULER_LEADER_TTL_MS` of scheduler quiet time before another process takes over. Lower the TTL for faster takeover, but never below the worst-case scheduler tick or the lock will flap.
- The scheduler runs a stale-running-job sweep on `start()`, so a new leader re-queues runs that were in-flight when the prior leader died.

## Access-log shipping

PacketAgent's access-log middleware writes one redacted JSON line per request when `PACKETAGENT_ACCESS_LOG_MODE` is set to `stdout` or `file`:

```json
{
  "ts": "2026-04-26T00:00:00.000Z",
  "method": "POST",
  "status": 200,
  "path": "/api/app/invitations/wkin_***/accept",
  "durationMs": 14,
  "userId": "user_abc",
  "workspaceId": "alpha",
  "requestId": "req_..."
}
```

Modes:

- `stdout`: emit JSON lines to the Node process's stdout. Pair with a process supervisor that captures stdout (`systemd` with `StandardOutput=journal`, `docker logs`, Kubernetes container logs, Vector/Fluent Bit/Promtail tailing the supervisor's stream). Rotation is the supervisor's responsibility.
- `file`: append to `PACKETAGENT_ACCESS_LOG_PATH`. Use a deployment-managed log directory on persistent storage.
- `off` (default): no access log.

| Env var                            | Default        | Notes                                                                                                                              |
| ---------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PACKETAGENT_ACCESS_LOG_MODE`      | `off`          | `stdout`, `file`, or `off`.                                                                                                        |
| `PACKETAGENT_ACCESS_LOG_PATH`      | unset          | Required when mode is `file`.                                                                                                      |
| `PACKETAGENT_ACCESS_LOG_MAX_BYTES` | `0` (disabled) | Size cap for the active file. When set, the middleware rotates before writing a line that would push the file past this threshold. |
| `PACKETAGENT_ACCESS_LOG_MAX_FILES` | `5`            | Number of historical rotations retained. Clamped to `>= 1`.                                                                        |

The middleware does not log request bodies, response bodies, or response headers. Body fields already pass through DTO-level redaction; re-logging them at the request boundary would risk re-leaking the same fields the route layer just masked.

### File rotation

Rotated siblings use `<path>.1`, `<path>.2`, ... up to `<path>.<MAX_FILES>`. On rotation, files cascade and the oldest is deleted. The middleware closes its cached write stream before rename to release the file handle from the Node side; on Windows, a concurrent process holding the file open can still trigger `EBUSY`, in which case the middleware skips the rotation and retries on the next request.

For cron-driven daily rotation or controlled maintenance windows:

```bash
npm run access-log:rotate -- --path=data/access.log --max-files=10
```

The CLI calls the same helper as the in-app middleware. Exit codes: `0` on success (including when the file does not exist yet), `1` on filesystem/permission errors, `2` when no path can be resolved.

### Shipping recipes

Drop-in starter configs ship under `examples/access-log-shipping/`:

- `vector.toml.example` - `file` source tailing the access log, `remap` transform parsing JSON and tagging, sinks for Loki, S3, Elasticsearch, or any Vector destination.
- `fluent-bit.conf.example` - `tail` input with `Parser json`, `Rotate_Wait`, and a persistent `DB` for tail offset across restarts.
- `promtail.yaml.example` - Loki shipper with `json` and `labels` pipeline stages. Promote only low-cardinality fields (`status`, `method`, `workspaceId`) to labels; keep `requestId` and `path` in the body.

For all three: pin includes to the active path (or a glob that matches rotated siblings), keep the shipper checkpoint on the same persistent volume across restarts, and never enrich shipped lines with auth-derived values that were stripped at the source.

### Retention

Configure compliance-grade retention on the SIEM or object-store side, not via PacketAgent-side `MAX_FILES`. The in-app rotation is a disk-bound buffer; treat the shipped destination as the source of truth for retention windows, legal hold, and tamper evidence. Size the local buffer (`MAX_BYTES * MAX_FILES`) generously enough to cover the worst-case shipper outage you are willing to absorb.
