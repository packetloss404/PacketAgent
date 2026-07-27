#!/usr/bin/env node
// Preflight check: verify Node version and that at least one AI provider is
// configured AND that the configured provider's key actually works. We do a
// quick probe (~1-3s) against the provider's cheapest list endpoint so the
// user finds out at launch time -- not at first generation -- if they pasted
// a typo, an expired key, or forgot to start their local LLM server.
//
// Exits non-zero with a friendly, copy-pasteable message if anything is wrong
// so the wrapper scripts can stop before launching the dev server.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function line(s = "") {
  process.stdout.write(s + "\n");
}

function errLine(s = "") {
  process.stderr.write(s + "\n");
}

// ---------------------------------------------------------------------------
// 1. Node version check.
// ---------------------------------------------------------------------------

const REQUIRED_MAJOR = 22;
const nodeVersion = process.versions.node;
const major = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);

if (!Number.isFinite(major) || major < REQUIRED_MAJOR) {
  errLine(`${RED}${BOLD}Node ${REQUIRED_MAJOR} or newer is required.${RESET}`);
  errLine(`${DIM}You're running Node ${nodeVersion}.${RESET}`);
  errLine("");
  errLine("Install the latest LTS from https://nodejs.org/ and try again.");
  errLine("If you use nvm:  nvm install 22 && nvm use 22");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. AI provider detection.
// ---------------------------------------------------------------------------

// Note: priority order matters. We only probe the FIRST configured provider --
// we just need ONE working provider for the user to be unblocked, and probing
// all six on every launch would add seconds to startup. Local LLMs win because
// if a user bothered to spin one up, that's what they want to use.
const PROVIDERS = [
  { env: "OLLAMA_BASE_URL", name: "Ollama (local)", kind: "ollama" },
  { env: "LOCAL_LLM_BASE_URL", name: "Local LLM", kind: "openai-compat" },
  { env: "VLLM_BASE_URL", name: "vLLM (local)", kind: "openai-compat" },
  { env: "ANTHROPIC_API_KEY", name: "Anthropic", kind: "anthropic" },
  { env: "OPENAI_API_KEY", name: "OpenAI", kind: "openai" },
  { env: "OPENROUTER_API_KEY", name: "OpenRouter", kind: "openrouter" },
  { env: "GOOGLE_API_KEY", name: "Google Gemini", kind: "gemini" },
  { env: "GEMINI_API_KEY", name: "Google Gemini", kind: "gemini" },
  { env: "MINIMAX_API_KEY", name: "MiniMax", kind: "minimax" },
];

const detected = PROVIDERS.filter((p) => {
  const value = process.env[p.env];
  return typeof value === "string" && value.trim().length > 0;
});

if (detected.length === 0) {
  errLine(`${YELLOW}${BOLD}No AI provider configured.${RESET}`);
  errLine(
    "PacketAgent needs at least one to generate apps. Three easy options:",
  );
  errLine("");
  errLine(`  ${BOLD}(a) Anthropic${RESET} ${DIM}— recommended${RESET}`);
  errLine(
    `      Copy this line into a file named ${CYAN}.env${RESET} in this folder:`,
  );
  errLine(`        ${GREEN}ANTHROPIC_API_KEY=sk-ant-...${RESET}`);
  errLine(`      Get a key at ${CYAN}https://console.anthropic.com/${RESET}`);
  errLine("");
  errLine(`  ${BOLD}(b) OpenAI${RESET}`);
  errLine(
    `      Copy this line into a file named ${CYAN}.env${RESET} in this folder:`,
  );
  errLine(`        ${GREEN}OPENAI_API_KEY=sk-...${RESET}`);
  errLine(`      Get a key at ${CYAN}https://platform.openai.com/${RESET}`);
  errLine("");
  errLine(`  ${BOLD}(c) Local Ollama${RESET} ${DIM}— free, no key needed${RESET}`);
  errLine(`      Install from ${CYAN}https://ollama.com${RESET}`);
  errLine(`      Then run:  ${GREEN}ollama serve${RESET}`);
  errLine(
    `      And add this line to ${CYAN}.env${RESET}:  ${GREEN}OLLAMA_BASE_URL=http://localhost:11434${RESET}`,
  );
  errLine("");
  errLine(
    `${DIM}Tip: there's an ${RESET}${CYAN}.env.example${RESET}${DIM} file you can copy to ${RESET}${CYAN}.env${RESET}${DIM} to start.${RESET}`,
  );
  process.exit(1);
}

const primary = detected[0];
const extras = detected.slice(1).map((p) => p.name).join(", ");

// ---------------------------------------------------------------------------
// 3. Probe the primary provider to validate the key / reachability.
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 2500;

// Count models from a typical list-models JSON payload. Different providers
// shape their list differently; we just want a friendly number for the success
// banner, so missing field => 0 and we don't print the count.
function countModels(payload) {
  if (!payload || typeof payload !== "object") return 0;
  if (Array.isArray(payload.data)) return payload.data.length;
  if (Array.isArray(payload.models)) return payload.models.length;
  return 0;
}

// Trim trailing slashes off a base URL so we can append paths cleanly.
function trimBase(url) {
  return url.replace(/\/+$/, "");
}

// Result shape: { ok: true, modelCount } | { ok: false, reason: "auth"|"network"|"timeout", detail?, base? }
async function probe(provider) {
  const value = (process.env[provider.env] ?? "").trim();
  try {
    switch (provider.kind) {
      case "anthropic": {
        const res = await fetch("https://api.anthropic.com/v1/models", {
          method: "GET",
          headers: {
            "x-api-key": value,
            "anthropic-version": "2023-06-01",
          },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
        if (!res.ok) return { ok: false, reason: "network", detail: `HTTP ${res.status}` };
        const body = await res.json().catch(() => null);
        return { ok: true, modelCount: countModels(body) };
      }
      case "openai": {
        const res = await fetch("https://api.openai.com/v1/models", {
          method: "GET",
          headers: { Authorization: `Bearer ${value}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
        if (!res.ok) return { ok: false, reason: "network", detail: `HTTP ${res.status}` };
        const body = await res.json().catch(() => null);
        return { ok: true, modelCount: countModels(body) };
      }
      case "openrouter": {
        // OpenRouter's /v1/models endpoint is PUBLIC -- it returns 200 even for
        // a bogus key -- so we use /api/v1/key which actually validates auth.
        // We don't get a model count from this endpoint, just a "key is good"
        // signal, which is what we want.
        const res = await fetch("https://openrouter.ai/api/v1/key", {
          method: "GET",
          headers: { Authorization: `Bearer ${value}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
        if (!res.ok) return { ok: false, reason: "network", detail: `HTTP ${res.status}` };
        // Drain body to free the socket; we don't need the contents.
        await res.json().catch(() => null);
        return { ok: true, modelCount: 0 };
      }
      case "gemini": {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`;
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        // Gemini returns 400 (INVALID_ARGUMENT) when the key is malformed and
        // 403 (PERMISSION_DENIED) when the key is unknown / revoked.
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          return { ok: false, reason: "auth" };
        }
        if (!res.ok) return { ok: false, reason: "network", detail: `HTTP ${res.status}` };
        const body = await res.json().catch(() => null);
        return { ok: true, modelCount: countModels(body) };
      }
      case "ollama": {
        const base = trimBase(value);
        const res = await fetch(`${base}/api/tags`, {
          method: "GET",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, reason: "network", detail: `HTTP ${res.status}`, base };
        const body = await res.json().catch(() => null);
        const count = Array.isArray(body?.models) ? body.models.length : 0;
        return { ok: true, modelCount: count, base };
      }
      case "openai-compat": {
        const base = trimBase(value);
        const res = await fetch(`${base}/v1/models`, {
          method: "GET",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth", base };
        if (!res.ok) return { ok: false, reason: "network", detail: `HTTP ${res.status}`, base };
        const body = await res.json().catch(() => null);
        return { ok: true, modelCount: countModels(body), base };
      }
      case "minimax":
      default:
        return { ok: "skip" };
    }
  } catch (err) {
    const name = err && typeof err === "object" ? err.name : "";
    if (name === "TimeoutError") return { ok: false, reason: "timeout" };
    // fetch() throws TypeError("fetch failed") for network errors (DNS, ECONNREFUSED, ...).
    return { ok: false, reason: "network", detail: err?.message ?? String(err) };
  }
}

function printSuccess(provider, modelCount) {
  const suffix = modelCount > 0 ? ` (${modelCount} models available)` : "";
  line(
    `${GREEN}Detected provider: ${BOLD}${provider.name}${RESET}${GREEN} · key valid${suffix}${RESET}`,
  );
  if (extras) {
    line(`${DIM}(also configured: ${extras})${RESET}`);
  }
  line(`${GREEN}Starting PacketAgent...${RESET}`);
}

function printAuthFailure(provider) {
  errLine(`${RED}${BOLD}Provider rejected your ${provider.name} key.${RESET}`);
  errLine(
    `The value you set for ${BOLD}${provider.env}${RESET} is not accepted by ${provider.name}.`,
  );
  errLine("Common causes:");
  errLine(" - Pasted the wrong line from the provider's dashboard");
  errLine(" - Extra whitespace or quotes around the key");
  errLine(" - Key was rotated or revoked");
  errLine(
    `Open ${CYAN}.env${RESET}, replace the ${BOLD}${provider.env}${RESET} value, and run again.`,
  );
}

function printLocalUnreachable(provider, base) {
  const where = base || (process.env[provider.env] ?? "").trim();
  if (provider.kind === "ollama") {
    errLine(
      `${RED}${BOLD}Local LLM at ${where} isn't responding — is Ollama running?${RESET}`,
    );
    errLine(`Try:  ${GREEN}ollama serve${RESET}`);
    errLine(
      `Then re-run this command. (Or unset ${BOLD}${provider.env}${RESET} in ${CYAN}.env${RESET} to use a cloud provider instead.)`,
    );
  } else {
    errLine(
      `${RED}${BOLD}Local LLM at ${where} isn't responding.${RESET}`,
    );
    errLine(
      `Make sure your server is running and serving the OpenAI-compatible ${CYAN}/v1/models${RESET} endpoint.`,
    );
    errLine(
      `Then re-run this command. (Or unset ${BOLD}${provider.env}${RESET} in ${CYAN}.env${RESET} to use a cloud provider instead.)`,
    );
  }
}

function printNetworkSkip(provider) {
  line(
    `${YELLOW}Couldn't reach ${provider.name} to verify the key. Skipping probe and continuing.${RESET}`,
  );
  line(
    `${DIM}(If generation fails later with a 401, check ${provider.env} in .env.)${RESET}`,
  );
  if (extras) {
    line(`${DIM}(also configured: ${extras})${RESET}`);
  }
  line(`${GREEN}Starting PacketAgent...${RESET}`);
}

const result = await probe(primary);

// We set process.exitCode rather than calling process.exit() to let the event
// loop drain naturally. Node 24's fetch on Windows has a known teardown
// assertion ("UV_HANDLE_CLOSING") when the process is hard-exited while
// fetch's keep-alive sockets are still closing -- which would mangle our
// carefully-chosen exit code into a 127 and confuse the wrapper scripts.

if (result.ok === "skip") {
  // MiniMax has no cheap list-models GET; defer validation to first use.
  line(
    `${GREEN}Detected provider: ${BOLD}${primary.name}${RESET}${GREEN}.${RESET}`,
  );
  line(
    `${DIM}MiniMax key detected (validity will be checked on first use).${RESET}`,
  );
  if (extras) {
    line(`${DIM}(also configured: ${extras})${RESET}`);
  }
  line(`${GREEN}Starting PacketAgent...${RESET}`);
  process.exitCode = 0;
} else if (result.ok === true) {
  printSuccess(primary, result.modelCount);
  process.exitCode = 0;
} else if (result.reason === "auth") {
  printAuthFailure(primary);
  process.exitCode = 1;
} else {
  // Network/timeout. For local LLMs an unreachable host means the user forgot
  // to start their server -- that's a hard fail because there's no fallback we
  // can reasonably make. For cloud providers a transient blip shouldn't block
  // them.
  const isLocal = primary.kind === "ollama" || primary.kind === "openai-compat";
  if (isLocal) {
    printLocalUnreachable(primary, result.base);
    process.exitCode = 1;
  } else {
    printNetworkSkip(primary);
    process.exitCode = 0;
  }
}
