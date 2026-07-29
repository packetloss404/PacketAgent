# Self-Host Setup Guide

PacketAgent runs as a Node application. This guide takes an existing checkout
through local startup, provider configuration, storage, sandboxing, and
production serving. It documents the inherited workbench that exists today;
the crash-resumable autonomous Worker lifecycle is still W1-W8 roadmap work.

If you want the strategic background on what self-host _intentionally_ gives up versus hosted competitors, see [CLOUD.md](../CLOUD.md).

---

## Prerequisites

- **Node.js 22.5.0 or later.** PacketAgent uses native `tsx` imports and modern ESM features. Check with `node --version`. Use `nvm`, `fnm`, or `volta` if you need to manage multiple versions.
- **npm 10+** (ships with Node 22).
- **OS.** Linux, macOS, or Windows. Tested on Ubuntu 22.04+, macOS 13+, and Windows 11 with PowerShell 7+. WSL2 is also supported and recommended on Windows for the Docker sandbox path.
- **Disk.** ~500 MB for `node_modules`, plus space for generated app workspaces and SQLite data under `data/`. Budget at least 2 GB free.
- **Memory.** ~512 MB resident for the API process, ~512 MB for the Vite dev server, plus whatever the sandbox uses when active.
- **Docker** (optional but recommended). Required for the secure sandbox runtime and for running generated apps from the publish handoff. Without Docker, the sandbox falls back to a `native` host-process driver that is clearly marked **insecure** in the UI.

---

## 5-Minute Quick Start

```bash
cd /path/to/PacketAgent
npm ci
npm run dev
```

Open **http://localhost:7341** in your browser.

The current foundation checkout is `D:\projects\PacketAgent`. PacketAgent does
not yet have a configured `origin`; never push this work to the historical
`taskloom-source` remote.

Sign in with the seeded developer account:

- Email: `alpha@packetagent.local`
- Password: `demo12345`

You are now in the workbench. The sidebar collapses to four items - Build, Projects, Runs, Admin - and sixteen operator surfaces (Roles, SSO, Secrets, Rate limits, Webhooks, Releases, Storage, Backups, Notifications, Operations, Integrations, Activation, Sandbox, Workflows, Billing, Alerts) live as tabs under `/admin/:tab`. Back-compat redirects mean old per-page URLs still work.

Go to `/builder` (a full-bleed route outside the workbench Shell), choose **Build an app**, and try a starter prompt like `Build a lightweight CRM for renewal tracking`.

**That is the full local loop.** No account creation, no email verification, no credit card. The two processes that started are:

| Port   | Process    | Purpose                                         |
| ------ | ---------- | ----------------------------------------------- |
| `7341` | Vite (web) | React workbench UI, proxies `/api/*` to the API |
| `8484` | Hono (api) | REST + SSE endpoints, jobs scheduler, sandbox   |

If port `7341` or `8484` is already in use, see the troubleshooting section below.

To reset local data back to the seed state at any time, stop the dev server and run `npm run store:reset`.

---

## Configure your LLM key

PacketAgent does not ship with a bundled LLM key. You bring your own - this is the central tradeoff of Fork B. Without a key, the builder falls back to **template-only generation**: deterministic, no LLM round-trip, useful for verifying the workbench is wired up but not for producing real apps from open-ended prompts.

### What is wired in today

Honest snapshot of where multi-provider BYOK actually stands:

- **Builder draft + iteration**: Routed through `ProviderRouter`. Six providers are first-class - Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, and a generic local-LLM provider (Ollama / vLLM / LM Studio / llama.cpp). The Builder UI exposes four presets (`fast`, `smart`, `cheap`, `local`) and surfaces the resolved provider+model on each chip.
- **Agent runs**: Same `ProviderRouter` instance - agents pick provider+model per run.
- **Default**: Anthropic wins the default `fast` and `smart` priority walks when its key is present. The `local` preset is strict: it only routes to the local-LLM provider and returns null (template-only fallback) if nothing local is reachable.
- **Override**: Set `PACKETAGENT_PROVIDER_PRIORITY=ollama,openrouter,anthropic` to re-order every preset's walk. Hit `GET /api/app/builder/providers/status` to see what is actually resolved at runtime, without exposing any keys.

If you want to drive the builder with an LLM, configure one of the six provider blocks below. If you configure several, the priority walk (or your `PACKETAGENT_PROVIDER_PRIORITY` override) decides which one each preset picks.

### Where to put the key

You can configure keys two ways:

1. **Per-workspace in the workbench** for Anthropic, OpenAI, Gemini,
   OpenRouter, and MiniMax.
   Open **Admin -> Integrations** and paste the key. Supported provider keys are
   stored in the encrypted secrets vault (AES-256-GCM at rest), never logged,
   and sent only to the selected provider.
2. **As environment variables at startup** (useful for headless installs or Docker Compose). Copy `.env.example` to `.env` and set the variables below.

Configure **only the providers you actually use**. You do not need all of them.

### Option A - Anthropic Claude (default)

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

Get a key at https://console.anthropic.com. The default model PacketAgent targets is `claude-sonnet-4-6` - a good balance of cost, latency, and quality for builder workloads. The `smart` preset upgrades to `claude-opus-4-7`; the `cheap` preset drops to `claude-haiku-4-5-20251001`. Anthropic wins the default priority walk for `fast` and `smart` when its key is present.

Reference: https://docs.claude.com/en/api

### Option B - OpenAI

```bash
# .env
OPENAI_API_KEY=sk-...
```

Get a key at https://platform.openai.com/api-keys. Preset model picks: `fast` / `cheap` -> `gpt-4o-mini`, `smart` -> `gpt-4o`. OpenAI is second on the default `fast` / `smart` walks (after Anthropic), and third on `cheap` (after OpenRouter and Gemini).

### Option C - Gemini (Google)

```bash
# .env
GOOGLE_API_KEY=...
# or, equivalently:
GEMINI_API_KEY=...
```

Either env name is accepted. Get a key at https://aistudio.google.com/app/apikey. The Gemini adapter speaks Google's OpenAI-compatible endpoint, so it slots into the router with the same shape as OpenAI. Preset picks: `fast` / `cheap` -> `gemini-2.5-flash`, `smart` -> `gemini-2.5-pro`. A workspace-vault key is equivalent to either environment key for readiness and request-time resolution.

### Option D - OpenRouter

```bash
# .env
OPENROUTER_API_KEY=sk-or-...
```

Get a key at https://openrouter.ai/keys. OpenRouter is a model marketplace that exposes Anthropic, Google, Mistral, DeepSeek, and others behind a single OpenAI-compatible endpoint. Preset picks: `fast` -> `anthropic/claude-haiku-4-5`, `smart` -> `anthropic/claude-sonnet-4-6`, `cheap` -> `qwen/qwen3-coder`. OpenRouter is first on the default `cheap` walk. A workspace-vault key is equivalent to the environment key for readiness and request-time resolution.

### Option E - MiniMax

```bash
# .env
MINIMAX_API_KEY=...
```

Configured the same way as Anthropic / OpenAI. Useful when you want a non-Anthropic, non-OpenAI option for agent runs. MiniMax is registered unconditionally; the preset resolver only picks it when it appears in your `PACKETAGENT_PROVIDER_PRIORITY` override (it is not in the default priority walks).

### Option F - Local LLM (Ollama / vLLM / LM Studio / remote llama.cpp)

The "ollama" provider is intentionally generic: it can talk to **any OpenAI-compatible local LLM server**, on `localhost` or on a separate machine on your LAN (think: a beefy GPU box). It is registered unconditionally - but it is **not the default** for hosted presets. Anthropic / OpenAI / Gemini / OpenRouter take precedence unless you (a) explicitly request the `local` preset, or (b) set `PACKETAGENT_PROVIDER_PRIORITY=ollama,...`.

Five env vars control where requests go and how they're shaped:

| Env var                        | Default                  | Purpose                                                                                                                                                        |
| ------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOCAL_LLM_BASE_URL`           | unset                    | Base URL of the local LLM server. Takes precedence over `OLLAMA_BASE_URL`. Use this for non-Ollama servers (vLLM, LM Studio, llama.cpp) - it documents intent. |
| `OLLAMA_BASE_URL`              | `http://localhost:11434` | Legacy synonym for `LOCAL_LLM_BASE_URL`. Honored when `LOCAL_LLM_BASE_URL` is unset.                                                                           |
| `LOCAL_LLM_API_FORMAT`         | `ollama`                 | Either `ollama` (native `/api/chat`) or `openai` (`/v1/chat/completions`). Set to `openai` for vLLM, LM Studio, and llama.cpp's OpenAI-compat server.          |
| `LOCAL_LLM_MODEL`              | unset                    | Overrides the per-call model name. Useful when the remote server only loads one specific model.                                                                |
| `LOCAL_LLM_STRUCTURED_OUTPUTS` | `auto`                   | `auto` sends vLLM's `structured_outputs` JSON Schema and permits one bounded prompt fallback on HTTP 400/404/422. `off` uses the prompt fallback directly.     |

**Recipe 1: Local Ollama (zero config).** No env needed; PacketAgent hits `http://localhost:11434` by default.

```bash
ollama pull qwen2.5-coder:32b
# PacketAgent will pick this up automatically when the `local` preset is selected.
```

**Recipe 2: Remote Ollama on another box (same LAN).**

```bash
# .env
OLLAMA_BASE_URL=http://192.168.1.100:11434
```

Run Ollama on the GPU box with `OLLAMA_HOST=0.0.0.0:11434 ollama serve` so it binds to the LAN interface, not just localhost.

**Recipe 3: vLLM on a remote GPU machine.**

```bash
# .env
LOCAL_LLM_BASE_URL=http://gpu-box:8000
LOCAL_LLM_API_FORMAT=openai
LOCAL_LLM_MODEL=qwen2.5-coder-32b-instruct
LOCAL_LLM_STRUCTURED_OUTPUTS=auto
```

Start vLLM with e.g. `vllm serve Qwen/Qwen2.5-Coder-32B-Instruct --host 0.0.0.0 --port 8000`. `LOCAL_LLM_MODEL` is required because vLLM only serves the one model that was loaded at startup, and its OpenAI-compat layer matches model names strictly.

**Recipe 4: LM Studio (local app on a developer laptop).**

```bash
# .env
LOCAL_LLM_BASE_URL=http://localhost:1234
LOCAL_LLM_API_FORMAT=openai
```

In LM Studio, load a model and start the "Local Server" tab. Default port is `1234`. LM Studio exposes the OpenAI-compatible API.

**Recipe 5: llama.cpp's OpenAI-compatible server.**

```bash
# .env
LOCAL_LLM_BASE_URL=http://localhost:8080
LOCAL_LLM_API_FORMAT=openai
LOCAL_LLM_MODEL=deepseek-coder-v2
```

Run llama.cpp with `./llama-server -m deepseek-coder-v2.gguf --port 8080 --host 0.0.0.0`. Same caveat as vLLM: set `LOCAL_LLM_MODEL` to whatever name your server reports.

**Quality caveat.** Smaller local models generally produce less reliable
file-tree and tool-use output than larger coding models. Treat the model names
in these recipes as examples, verify what your installed server currently
offers, and validate output before granting tools or running generated code.

The local provider is registered unconditionally, but it is not in the default `fast` / `smart` / `cheap` priority walks - Anthropic / OpenAI / Gemini / OpenRouter come first. To make local the preferred path, either pick the `local` Builder preset (strict: only routes local) or set `PACKETAGENT_PROVIDER_PRIORITY=ollama,...` (see the next section).

### Option G - No key (template-only fallback)

If no provider key is set and no local server is reachable, the builder falls back to deterministic template-only generation. This is fine for:

- Verifying the workbench is wired up end-to-end.
- Running the sandbox and publish handoff against the bundled CRM template.
- CI / smoke tests that should not consume LLM tokens.

It is **not** sufficient for producing real apps from open-ended prompts - the LLM step is what turns "build a lightweight CRM for renewal tracking" into a tailored brief, plan, and source files.

### Provider precedence and override

The Builder UI exposes four presets - `fast`, `smart`, `cheap`, `local`. Each preset walks a priority list of providers and picks the first one that is both registered on the router and has a configured key (env or vault). The default walks are:

| Preset  | Default priority (first match wins)                                |
| ------- | ------------------------------------------------------------------ |
| `fast`  | `anthropic` -> `openai` -> `gemini` -> `openrouter` -> `ollama`    |
| `smart` | `anthropic` -> `openai` -> `gemini` -> `openrouter` -> `ollama`    |
| `cheap` | `openrouter` -> `gemini` -> `openai` -> `anthropic` -> `ollama`    |
| `local` | `ollama` (strict - returns null if no local provider is reachable) |

Set `PACKETAGENT_PROVIDER_PRIORITY` to replace the walk for every non-`local` preset:

```bash
# Prefer local LLM for everything; fall back to OpenRouter, then Anthropic.
PACKETAGENT_PROVIDER_PRIORITY=ollama,openrouter,anthropic
```

The override is comma-separated, case-insensitive, and silently drops unknown names. The `local` preset is unaffected - it always routes only to local providers.

To confirm what is actually resolved at runtime, call:

```bash
curl -s --cookie-jar /tmp/jar --cookie /tmp/jar \
  http://localhost:8484/api/app/builder/providers/status
```

(Authenticate first; the endpoint requires a signed-in viewer.) The response contains a `presets` map keyed by preset name, an `availableProviders` array of providers with credentials, public capability/generation metadata and credential source for every provider, and the active `priority` override string (or `null` if unset). No secrets are included.

---

## Deploy your generated app

When you click **Publish handoff** in the builder, PacketAgent produces a local package - not a hosted deployment. The package lands under:

```
data/published-apps/<workspace>/<app>/
```

It contains the generated React/Vite source under `bundle/`,
`Dockerfile.publish`, `docker-compose.publish.yml`, a small standalone Node
static/health/SQLite runtime under `runtime/`, checkpoint-bound runtime config,
the sealed artifact manifest, and `RUNBOOK.md`. It does not start or require the
PacketAgent control plane or a separate Postgres container.

**To certify a published app locally from the PacketAgent repository:**

```bash
npm run verify:generated-app-publish -- data/published-apps/<workspace>/<app>
```

The bounded verifier validates Compose, builds and starts the package on a free
loopback port, checks `/health/live`, `/health/ready`, static HTML, and
generated CRUD, restarts the container to prove SQLite volume persistence,
runs a stopped-service backup/mutate/restore round trip, and then removes its
uniquely named test containers, network, volume, local image, and temporary
backup.

**To keep a published app running:**

```bash
cd data/published-apps/<workspace>/<app>
docker compose -f docker-compose.publish.yml up --build --wait
```

Open `http://localhost:8787`. Set `PACKETAGENT_GENERATED_APP_PORT` before
starting Compose to select another host port. The mapping binds to
`127.0.0.1` by default; set
`PACKETAGENT_GENERATED_APP_BIND_ADDRESS=0.0.0.0` only for intentional,
firewall-protected direct LAN exposure. Stop without deleting app data with:

```bash
docker compose -f docker-compose.publish.yml down --remove-orphans
```

The `generated-app-data` named volume holds `runtime.sqlite`. Adding
`--volumes` deletes that local app data and should be an intentional reset.

### Verify the publish package

New publish materializations contain
`packetagent.generated-app-artifact-manifest/v2` in
`publish-artifacts.json`. Before handoff, PacketAgent verifies every listed
file's byte count and SHA-256, the canonical manifest digest, the workspace/app/
checkpoint binding, and local assets referenced by HTML `src`/`href`/`srcset`/
`poster` attributes and CSS `url(...)` values. Missing, modified, unexpected,
traversing, or symlinked files block the integrity gate. Verification is
bounded to 1,000 files and 25 MiB.

After publishing, an authenticated viewer can re-check the exact current
package without rewriting it:

```bash
curl -s --cookie /tmp/jar \
  http://localhost:8484/api/app/generated-apps/<app-id>/publish/integrity
```

The response is `verified` only when the manifest and disk agree. Checksums are
always enabled. To add an authenticity check, configure a secret of at least
32 bytes before starting PacketAgent:

```bash
PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY=<long-random-secret>
PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY_ID=home-server-2026
```

Only the HMAC-SHA256 result and non-secret key ID enter the package. Keep the
same key available when re-verifying a signed manifest; PacketAgent treats a
signed package without its verification key as unverifiable rather than
silently downgrading it to checksum-only.

**To deploy to your own infrastructure:**

The generated bundle is a standalone containerized Node/Vite/SQLite app. You
can:

- `scp` or `rsync` the whole publish directory to a VPS and run
  `docker compose -f docker-compose.publish.yml up --build -d --wait` there.
- Push it to a registry and deploy via Kubernetes / Fly Machines / Cloud Run / your own orchestrator.
- Wrap it in your existing CI/CD pipeline. Keep `runtime-config.json` and
  `runtime/runtime-model.json` with the image because they bind it to the
  published app/checkpoint.

DNS, TLS, reverse-proxy, VPN, and public URL configuration are your
responsibility. PacketAgent does not provision a domain, certificate, or
tailnet policy. The sealed `deploy/` directory contains:

- `Caddyfile.example` - set `PACKETAGENT_GENERATED_APP_HOSTNAME`; Caddy can
  obtain/renew public certificates and proxies to the loopback app port.
- `nginx.generated-app.conf.example` - replace the hostname and certificate
  paths, validate with `nginx -t`, then reload nginx.
- `TAILSCALE.md` - `tailscale serve --bg http://127.0.0.1:8787` for private
  tailnet HTTPS, with the distinct opt-in Funnel command documented for public
  exposure.

Caddy sets/augments the standard forwarded headers by default; the nginx
example sets Host, X-Real-IP, X-Forwarded-For, and X-Forwarded-Proto
explicitly. The standalone generated-app runtime does not currently use
forwarded headers for authorization, identity, or URL generation, so spoofed
forwarded values cannot broaden access. TLS policy remains at the terminating
proxy.

Use the final HTTPS origin printed/configured by the proxy or VPN:

```bash
npm run verify:generated-app-reachability -- \
  data/published-apps/<workspace>/<app> \
  https://app.example.com
```

The command reads expected app/checkpoint identity from the local package,
then separately reports URL-policy, DNS, TCP/TLS, liveness, readiness identity,
and app-root results. Every network step is bounded to five seconds, response
reads stop at 64 KiB, TLS certificates must validate, and redirects fail rather
than silently verifying another service. HTTP is accepted only for loopback
testing. A passing check proves reachability at that moment; it does not
configure or continuously monitor DNS/TLS.

### Standalone runtime, schema-change, and backup truth

The image build may use the package registry only during dependency
installation; dependency lifecycle scripts are disabled and the Vite compile
step runs with Docker build networking disabled. The final container runs as
the unprivileged `node` user with a read-only root, bounded `/tmp`, CPU, memory,
and process limits, all capabilities dropped, and
`no-new-privileges`. Only the named SQLite volume is persistent and writable.

The standalone runtime validates Vite's emitted `.vite/manifest.json` and all
referenced chunks, CSS, and assets before readiness passes. The source
`publish-artifacts.json` seals the exact declared build/runtime inputs; it
does not claim to contain the final image digest.

Both `runtime-config.json` and `/health/ready` declare
`schemaChangePolicy: "reset-and-reseed"`. Same-schema restarts preserve
records; changing the generated schema signature clears the app's records and
loads its seed data again. Generated `src/db/migrations/0001_initial.sql` is
reference DDL for an app-owned database and is not executed by the current
preview or standalone runtime. Automatic data-preserving schema migration is
not implemented or claimed.

Use the exact offline backup and restore commands in the generated
`RUNBOOK.md`. They stop the service, run the already-built generated-app image
with the named volume plus an external backup directory, copy
`runtime.sqlite`, restart, and re-verify the app. Stopping matters because
SQLite checkpoints WAL content when the last database connection closes.
Docker's volume documentation likewise treats backup/restore as an explicit
operator workflow:

- [Docker volume backup and restore](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes)
- [SQLite write-ahead logging and final-connection checkpoint](https://www.sqlite.org/wal.html)

Keep backups outside the sealed publish directory so they do not invalidate
artifact integrity. Never add `--volumes` to `docker compose down` unless
deleting the app data is intentional. The certification CLI exercises the
same stopped-service backup/restore method against a temporary external
directory.

For hosted-only conveniences PacketAgent does not ship (free public subdomain, auto TLS, managed App Store submission, hosted OAuth proxy), see [CLOUD.md](../CLOUD.md) for the full deferred-features inventory.

### Monitor PacketAgent preview runtimes

These endpoints describe generated-app previews served by PacketAgent, not a
standalone Compose package. Preview/API requests run in supervised per-app Node child
processes. The pool defaults to four warm processes per PacketAgent server.
Set `PACKETAGENT_GENERATED_APP_RUNTIME_MAX_PROCESSES` to a value from `1` to
`64` before startup to change the limit; out-of-range values are clamped. When
the pool is full, PacketAgent evicts the least-recently-used idle process.
Each active app therefore consumes one child process in addition to the main
PacketAgent server.

The health response and Builder Sandbox tab expose the same
`reset-and-reseed` policy so a preview schema change is not presented as an
automatic migration.

After authenticating as a workspace viewer, inspect the whole workspace:

```bash
curl -s --cookie /tmp/jar \
  http://localhost:8484/api/app/generated-app-runtime/health
```

Or inspect one owned app:

```bash
curl -s --cookie /tmp/jar \
  http://localhost:8484/api/app/generated-apps/<app-id>/runtime/health
```

An app that has never received a runtime request is `idle`; reading the health
endpoint does not start it. A live process with no recent failure is
`healthy`. A request failure, startup failure, or unexpected exit leaves the
app `degraded` for five minutes and records bounded reason/code/signal
metadata. PacketAgent retries a failed request once. Request totals, failures,
retries, starts, crashes, schema restarts, and LRU evictions are process-local
operational counters and reset when the PacketAgent server restarts. The
Builder's **Sandbox** tab presents the same per-app status and recent failure.

For a standalone package, probe its own endpoints on the mapped app port:

```bash
curl -fsS http://localhost:8787/health/live
curl -fsS http://localhost:8787/health/ready
curl -fsS http://localhost:8787/meta
```

`/meta` contains only package identity and schema entity names; it does not
expose secrets.

---

## Troubleshooting

### "No API key configured" / builder produces only template output

The builder fell back to template-only generation because the preset resolver could not find a usable provider. Check, in order:

1. Open **Admin -> Integrations** in the workbench, or inspect `.env`. Is at least one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` / `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MINIMAX_API_KEY`, or `LOCAL_LLM_BASE_URL` / `OLLAMA_BASE_URL` configured?
2. Hit `GET /api/app/builder/providers/status` (cookie-authenticated) and look at the `presets` map. If every preset is `null`, the resolver sees no usable provider. If only `local` is `null` but you set `LOCAL_LLM_BASE_URL`, the server is unreachable - try `curl $LOCAL_LLM_BASE_URL/api/tags` (Ollama) or `/v1/models` (OpenAI-compat).
3. If you set the key via `.env`, did you restart `npm run dev` after editing the file? `.env` is read at process startup, not on every request.
4. Test the key directly against the provider's own API. For Anthropic: `curl -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" https://api.anthropic.com/v1/messages -d '{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'`. If this fails, the problem is the key or the provider, not PacketAgent.

### Port collision (`EADDRINUSE` on 7341 or 8484)

Another process is already bound to one of PacketAgent's ports.

- Find what's using the port (Linux/macOS): `lsof -i :7341` or `lsof -i :8484`.
- Find what's using the port (Windows PowerShell): `Get-NetTCPConnection -LocalPort 7341` or `Get-NetTCPConnection -LocalPort 8484`.
- Either stop the conflicting process, or override PacketAgent's API port: `PORT=9090 npm run dev`. The Vite dev port is set in `web/vite.config.ts` if you need to change it.

### Missing native deps on `npm install` (`better-sqlite3`, `playwright`)

Some optional dependencies build native code. If `npm install` fails:

- On Linux, ensure `build-essential`, `python3`, and `make` are installed (`sudo apt install build-essential python3`).
- On macOS, ensure Xcode Command Line Tools are installed (`xcode-select --install`).
- On Windows, install the Visual Studio Build Tools (the `Desktop development with C++` workload) or use WSL2.
- For Playwright specifically, after install run `npx playwright install chromium` to fetch the browser binary.

### Generated app preview shows a blank page

The generated app is served from disk through the API at `/api/app/generated-apps/:appId/preview`. If the preview is blank:

1. Check the **Generated source** tab - are files actually written under `data/generated-apps/...`?
2. Open the browser devtools network tab and check for 404s or CORS errors on `/api/app/generated-apps/:appId/preview/...`.
3. If smoke checks failed, the publish handoff panel will list which checks blocked the preview; rerun them after fixing the underlying issue.

### Docker sandbox not available

The sandbox runtime defaults to `docker`. If Docker is not installed or not running:

- The workbench Sandbox panel will show `Docker not available`.
- You can switch to the `native` host-process driver with `PACKETAGENT_SANDBOX_DRIVER=native` plus `PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX=true`. **This runs sandbox commands as the host user with no isolation.** Only do this on a trusted dev machine.
- For production, install Docker Desktop (macOS/Windows) or `docker-ce` (Linux), confirm `docker ps` works for your user, and restart PacketAgent.

### Reset everything

```bash
npm run store:reset   # JSON store
# or
npm run db:reset      # SQLite store
```

Both stop short of deleting generated app workspaces under `data/generated-apps/`. Remove that directory manually if you want a fully clean slate.

---

## What's next

- When moving to a new Codex project, start with [dev/CODEX-HANDOFF.md](../dev/CODEX-HANDOFF.md).
- Read [dev/roadmap.md](../dev/roadmap.md) for current product direction.
- Read [CLOUD.md](../CLOUD.md) to understand what self-host intentionally does not do, and what a hypothetical PacketAgent Cloud product would have to own.
- Read [BACKLOG.md](../BACKLOG.md) for W1-W10 and the inherited lower-priority backlog.
- Read [dev/TESTING.md](../dev/TESTING.md) for local verification and release checks.
- [PHASE3_SCOPE.md](PHASE3_SCOPE.md) is an archived historical builder plan, not the resume point.
