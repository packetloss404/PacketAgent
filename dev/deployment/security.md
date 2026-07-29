# Security

This page covers the public-surface controls PacketAgent enforces in-process: same-origin and CSRF protection on browser mutations, rate limits on auth and invitation routes, trusted-proxy handling, session cookie behavior, and the redaction posture that keeps tokens out of DTOs, exports, and access logs. The matching log-shipping recipes for proxy access logs live under `examples/proxy-access-log-redaction/` and in the [operations](./operations.md) page.

## Same-origin and CSRF protection

Private mutating routes under `/api/app/*` reject browser requests whose `Origin` host does not match the request host. Cross-origin mutations return `403 cross-origin requests are not allowed`.

For same-origin browser mutations, PacketAgent additionally requires the readable `packetagent_csrf` cookie to be echoed in the `X-CSRF-Token` request header. The token is bound to the session: it is derived from the session cookie, so a leaked CSRF cookie alone does not authorize a mutation, and a leaked session cookie alone does not echo correctly.

The CSRF cookie is set when a session is established and cleared on logout. It is `httpOnly: false` (so the SPA can read it), `sameSite: Lax`, `path: /`, and is `Secure` whenever `NODE_ENV=production`.

Server-to-server callers that present the session cookie but no `Origin` header (typical for `curl` or backend integrations) skip CSRF enforcement; the same-origin check only applies when the browser supplies `Origin`. Public webhooks and unauthenticated routes are not subject to CSRF.

## Auth and invitation rate limits

Auth register/login routes and invitation create/accept/resend routes have store-backed rate limits. The defaults are 20 attempts per 60-second window per route family. Limited responses return `429` with a `Retry-After` header.

Bucket IDs are SHA-256 hashed with `PACKETAGENT_RATE_LIMIT_KEY_SALT`, so raw client identifiers never sit in the store. JSON mode stores buckets in the regular store; SQLite mode uses a dedicated `rate_limit_buckets` table.

| Env var                                          | Default                  | Notes                                                                                      |
| ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------ |
| `PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS`       | `20`                     | Max auth register/login attempts per window.                                               |
| `PACKETAGENT_AUTH_RATE_LIMIT_WINDOW_MS`          | `60000`                  | Auth rate-limit window in milliseconds.                                                    |
| `PACKETAGENT_INVITATION_RATE_LIMIT_MAX_ATTEMPTS` | `20`                     | Max invitation create/accept/resend attempts per window.                                   |
| `PACKETAGENT_INVITATION_RATE_LIMIT_WINDOW_MS`    | `60000`                  | Invitation rate-limit window in milliseconds.                                              |
| `PACKETAGENT_RATE_LIMIT_KEY_SALT`                | `packetagent-rate-limit` | Salt for hashed rate-limit bucket IDs. **Set a deployment-specific secret in production.** |
| `PACKETAGENT_RATE_LIMIT_MAX_BUCKETS`             | `5000`                   | Max retained app-level buckets before pruning.                                             |

These are app-level guardrails. Local buckets are process and store scoped; they do not coordinate across separate stores, separate disks, or separate regions. For deployments with more than one PacketAgent process, container, or region, also enable a shared limiter (next section) or enforce equivalent limits at the edge.

## Distributed rate limiter

When `PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL` is set, PacketAgent calls a shared HTTP limiter before updating local buckets. The local buckets remain as a backstop for restarts and edge bypass, but the cross-process counters live in the limiter you operate.

Request shape (`POST <url>`):

```json
{
  "bucketId": "auth:login:sha256:...",
  "scope": "auth:login",
  "maxAttempts": 20,
  "windowMs": 60000,
  "timestamp": "2026-04-26T00:00:00.000Z"
}
```

If `PACKETAGENT_DISTRIBUTED_RATE_LIMIT_SECRET` is set, PacketAgent sends `Authorization: Bearer <secret>`. The bucket ID is already salted and hashed; raw client identifiers never reach the limiter.

Response semantics:

- `2xx` with empty body or `{ "allowed": true }` allows the request to continue to the local backstop.
- `429`, `{ "limited": true }`, or `{ "allowed": false }` makes PacketAgent return `429` with `Retry-After`. The limiter can supply the retry window via the `Retry-After` header, `retryAfterSeconds`, or `resetAt` (ISO timestamp, epoch ms, or epoch seconds).
- Non-2xx responses, timeouts, and network failures fail closed with `503 rate limit service unavailable` unless `PACKETAGENT_DISTRIBUTED_RATE_LIMIT_FAIL_OPEN=true` is set, in which case PacketAgent falls back to the local backstop.

Supported scopes: `auth:register`, `auth:login`, `invitation:create`, `invitation:accept`, `invitation:resend`.

| Env var                                         | Default             | Notes                                                                               |
| ----------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL`        | unset               | Optional HTTP limiter endpoint. When set, called before the local backstop.         |
| `PACKETAGENT_DISTRIBUTED_RATE_LIMIT_SECRET`     | unset               | Optional bearer secret sent as `Authorization: Bearer <secret>`.                    |
| `PACKETAGENT_DISTRIBUTED_RATE_LIMIT_TIMEOUT_MS` | `750`               | Per-request HTTP timeout in milliseconds.                                           |
| `PACKETAGENT_DISTRIBUTED_RATE_LIMIT_FAIL_OPEN`  | unset (fail-closed) | Set to `true`, `1`, or `yes` to fall back to the local backstop on limiter outages. |

PacketAgent does not ship a limiter service. The protocol is intentionally minimal so you can build the limiter against existing infrastructure (Redis with `SET NX PX`, a small Hono/Express service backed by any atomic-upsert datastore, an edge worker, or a CDN/WAF rule).

## Trusted-proxy configuration

By default, the same-origin check uses the `Host` header from the immediate caller. When PacketAgent is behind a proxy that terminates TLS or rewrites the host, set `PACKETAGENT_TRUST_PROXY=true` so the `X-Forwarded-Host` header is honored for origin comparison.

| Env var                   | Default       | Notes                                                                           |
| ------------------------- | ------------- | ------------------------------------------------------------------------------- |
| `PACKETAGENT_TRUST_PROXY` | unset (false) | Set to `true`, `1`, or `yes` to honor `X-Forwarded-Host` for origin comparison. |

Only enable this when the upstream infrastructure strips and re-adds `X-Forwarded-Host` (and `X-Forwarded-For`, `X-Real-IP` for IP-based limiting at the edge). If the proxy passes through client-supplied forwarded headers, an attacker can spoof the host and bypass the same-origin check.

## Session cookies

Sessions live in `packetagent_session`, an HTTP-only cookie. The CSRF token cookie `packetagent_csrf` is set alongside it, readable to the SPA, and bound to the session secret. Both cookies share the session TTL and are marked `Secure` when `NODE_ENV=production`.

`npm run jobs:cleanup-sessions` prunes expired sessions. Run it on a cron or schedule equivalent to your session TTL.

| Env var    | Default       | Notes                                                                                       |
| ---------- | ------------- | ------------------------------------------------------------------------------------------- |
| `NODE_ENV` | `development` | Set to `production` to mark session and CSRF cookies `Secure` and to disable dev shortcuts. |

## Generated-preview origin isolation

Generated preview HTML, source assets, and generated runtime API calls are
accepted only on `PACKETAGENT_PREVIEW_ORIGIN`. The workbench, authentication,
vault, Worker, artifact, health, and other private routes are accepted only on
the primary origin. PacketAgent enforces that split from the preserved
`Host`/trusted `X-Forwarded-Host`, independently of the reverse proxy.

Production startup requires:

| Env var                            | Requirement                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PACKETAGENT_APP_ORIGIN`           | Exact HTTPS workbench origin.                                                                                                                    |
| `PACKETAGENT_PREVIEW_ORIGIN`       | Exact HTTPS preview origin on a different hostname. A port-only split is rejected because cookies are not port-scoped.                           |
| `PACKETAGENT_PREVIEW_TOKEN_SECRET` | Recommended dedicated HMAC key. `PACKETAGENT_MASTER_KEY` or `MASTER_KEY` is accepted instead; the development fallback is refused in production. |

The workbench session and CSRF cookies omit `Domain`, so they remain host-only
and are not sent to the preview hostname. Preview authorization uses a
versioned HMAC capability bound to one workspace, app, checkpoint, scope,
expiry, and—when interactive—one parent origin. It arrives after `#` in the
URL, so it is absent from HTTP requests and access logs. A same-origin
bootstrap exchanges it for a Secure, HttpOnly, `SameSite=None`, partitioned
cookie scoped to `/api/app/generated-apps/<appId>/`, then removes the fragment.
Partitioning permits the intended iframe without making the cookie a general
third-party credential.

Share capabilities default to one hour and permit only `GET`/`HEAD` runtime
operations. Interactive Builder capabilities default to 15 minutes, require
workspace management permission, and allow runtime mutations. Both are
revalidated cryptographically and against the current app/checkpoint on every
request.

Generated documents receive a per-response nonce and an explicit CSP:
`default-src 'none'`, bounded script/connect/image/font/style/worker sources,
`object-src 'none'`, `form-action 'self'`, and scope-specific
`frame-ancestors`. Shared previews cannot be framed. Interactive previews may
be framed only by their exact workbench origin. The Builder's click-to-edit
bridge uses exact-target `postMessage`; the parent validates the sender origin,
iframe window, message version, shape, string lengths, and rectangle bounds.

Defense-in-depth Caddy and nginx virtual-host examples are under
`examples/preview-origin/`. Run `npm run verify:preview-isolation` after every
origin, cookie, CSP, or proxy change.

## Container hardening

PacketAgent applies one auditable container matrix:

| Surface                         | User          | Read-only root | Capabilities | No new privileges | PID limit |
| ------------------------------- | ------------- | -------------- | ------------ | ----------------- | --------- |
| Control-plane Compose service   | `packetagent` | yes            | drop `ALL`   | yes               | `256`     |
| Codegen validator image default | `65534:65534` | runtime        | runtime      | runtime           | runtime   |
| Untrusted sandbox execution     | `65534:65534` | yes            | drop `ALL`   | yes               | `64`      |
| Generated-app publish service   | `node`        | yes            | drop `ALL`   | yes               | `128`     |

The validator's image default is defense in depth; the sandbox driver still
forces the numeric identity and all runtime controls. The control-plane and
generated-app Compose services also use bounded tmpfs/ulimits and init
reaping. Docker Compose's resolved configuration is the configuration
authority, and generated-app certification additionally inspects the running
container.

Run:

```bash
npm run verify:container-hardening
```

The verifier fails unless the two Compose matrices resolve correctly, the
validator image is non-root, and a real sandbox process reports zero effective
capabilities, `NoNewPrivs=1`, its exact cgroup PID maximum, and a denied write
to the root filesystem.

The Docker daemon socket remains host-level authority; dropping capabilities
inside the trusted control-plane container does not reduce what an authorized
Docker client can ask the daemon to do. Never mount the socket into generated
apps or untrusted sandbox containers, and never expose an unauthenticated
Docker TCP endpoint. Prefer Docker rootless mode or a protected SSH/TLS daemon
where practical. See Docker's
[Engine security](https://docs.docker.com/engine/security/),
[rootless mode](https://docs.docker.com/engine/security/rootless/), and
[daemon socket protection](https://docs.docker.com/engine/security/protect-access/)
guidance.

## Token redaction

PacketAgent treats invitation tokens, share tokens, agent webhook tokens, and bearer values as secrets. They are redacted before they appear in API responses, persisted error records, frontend display paths, access logs, exports, and structured logs. Redaction is centralized in `src/security/redaction.ts` and reused by every surface that emits string content to an operator.

What stays unredacted:

- The one-time `POST /api/app/invitations` and `POST /api/app/invitations/:invitationId/resend` response bodies, which intentionally return the freshly minted token to the inviter.
- The `:token` route parameter on `POST /api/app/invitations/:token/accept`, which is the credential the invited user supplies.
- The `tokenPreview` field on member-list and invitation-list responses (the masked tail, never the full token).

What gets masked:

- `path` field in app-level access log lines (token-bearing route segments and sensitive query parameters such as `?token=`, `?secret=`, `?api_key=`).
- Generated-preview capabilities are delivered in URL fragments and therefore
  never reach PacketAgent or proxy access logs; legacy `?token=` delivery is
  rejected.
- The redacted `error` field on `/api/health/ready` 503 responses.
- All token-bearing fields in workspace exports (invitation tokens, share tokens, agent webhook tokens, environment variable values, provider credentials).
- Webhook delivery error strings stored on alert and invitation-email delivery records.
- Provider error strings echoed back through the inbound invitation-email status webhook.

## Workspace exports

Per-workspace JSON snapshot with all bearer fields masked:

```bash
npm run jobs:export-workspace -- --workspace-id=<id> > export.json
```

The export covers the workspace record, workflow records, agents, agent runs, activities, jobs, providers, environment variables, invitations, share tokens, and memberships. Sessions are excluded - they are not part of the workspace audit boundary and would expand the bearer surface of the export without operational benefit.

The export is read-only against the active store; it does not mutate workspace records or rotate tokens. Treat the resulting file as sensitive even though tokens are masked: it still contains workspace state, member emails, and freeform user content.

Suggested uses: audit handoff to security or compliance reviewers, support escalation bundles, GDPR-style data-subject exports (with additional manual scrubbing for personal data of third parties).

## Proxy access logs

The reverse-proxy access log captures requests PacketAgent never sees in-process: TLS handshake failures, paths that 404 before reaching the upstream, health probes from load balancers, and traffic shed by edge filters. Configure your front-line proxy to redact known sensitive path segments (`/api/app/invitations/:token/accept`, `/api/public/share/:token`, `/api/public/webhooks/agents/:token`) and sensitive query parameters (`token`, `secret`, `api_key`, `bearer`) before the access log is written.

Starter configs: `examples/proxy-access-log-redaction/` ships nginx, Caddy, and Apache snippets.

Validate a proxy log against PacketAgent's pattern set:

```bash
node --import tsx src/security/proxy-access-log-validator.ts /var/log/proxy/access.log
```

Exit code `0` means no raw bearer tokens, `whk_` prefixes, share/invitation/webhook token segments, or sensitive query parameter values were found. Non-zero exit codes print the matching line numbers and patterns so you can fix the proxy redaction rules.

Run after every proxy configuration change, after every release that adds a new token-bearing route family, and periodically against rotated logs as part of regular audit.

## Secrets vault

Provider credentials, environment variables, and similar workspace secrets live in an in-app encrypted vault (AES-256-GCM with a key derived from a passphrase using PBKDF2). The encrypted blobs sit in the active store; only the running PacketAgent process can decrypt them.

| Env var      | Default        | Notes                                                                                                                                                                                      |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MASTER_KEY` | _dev fallback_ | Vault master passphrase. **Set in production.** When unset, PacketAgent logs a warning and falls back to a deterministic dev key - not safe for any deployment that persists real secrets. |

Manage stored secrets through the Settings -> Providers and Settings -> Environment views in the workbench. PacketAgent never logs decrypted secret values, and DTOs surface only `tokenPreview`-style masked tails. Treat database backups containing the vault blobs as sensitive even though the values are encrypted at rest.

## Validation checklist

Before promoting a change:

- HTTPS terminates upstream of the Node server and `NODE_ENV=production` is set so cookies are marked `Secure`.
- `PACKETAGENT_RATE_LIMIT_KEY_SALT` and `MASTER_KEY` are set to deployment-specific secret values.
- `PACKETAGENT_AUTH_RATE_LIMIT_*` and `PACKETAGENT_INVITATION_RATE_LIMIT_*` reflect the deployment's intended attempt budget.
- If the deployment has more than one PacketAgent process, container, or region, `PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL` is configured (or equivalent edge limits exist) for `/api/auth/register`, `/api/auth/login`, `/api/app/invitations`, `/api/app/invitations/:token/accept`, and `/api/app/invitations/:invitationId/resend`.
- Cross-origin browser mutations are rejected with `403`, and same-origin mutations include `X-CSRF-Token`.
- `PACKETAGENT_TRUST_PROXY=true` is only set when forwarded headers are stripped and re-added by trusted infrastructure.
- `PACKETAGENT_APP_ORIGIN` and `PACKETAGENT_PREVIEW_ORIGIN` are different
  production HTTPS hostnames, and both proxy virtual hosts preserve/replace
  `Host` according to the reviewed configuration.
- `npm run verify:preview-isolation` passes and a browser inspection shows no
  `packetagent_session` or `packetagent_csrf` cookie on the preview hostname.
- `npm run verify:container-hardening` passes against the deployment's Docker
  engine; generated apps and sandbox containers have no Docker socket mount.
- A sample `npm run jobs:export-workspace -- --workspace-id=<id>` produces JSON with no raw `whk_`, `Bearer `, `?token=`, `?secret=`, or `?api_key=` substrings.
- A sample of the live proxy access log passes `node --import tsx src/security/proxy-access-log-validator.ts <log-path>` with exit code `0`.
- `npm run jobs:cleanup-sessions` runs on a recurring schedule.
