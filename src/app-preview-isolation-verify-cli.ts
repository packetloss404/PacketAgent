import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GeneratedAppRuntimeDraft } from "./generated-app-runtime.js";

const APP_ORIGIN = "https://packetagent.verify.test";
const PREVIEW_ORIGIN = "https://preview.packetagent.verify.test";
const tempRoot = mkdtempSync(join(tmpdir(), "packetagent-preview-isolation-"));

process.env.NODE_ENV = "production";
process.env.PACKETAGENT_STORE = "sqlite";
process.env.PACKETAGENT_DB_PATH = join(tempRoot, "packetagent.sqlite");
process.env.PACKETAGENT_GENERATED_APP_RUNTIME_DIR = join(tempRoot, "runtime");
process.env.PACKETAGENT_APP_ORIGIN = APP_ORIGIN;
process.env.PACKETAGENT_PREVIEW_ORIGIN = PREVIEW_ORIGIN;
process.env.PACKETAGENT_PREVIEW_TOKEN_SECRET = "packetagent-preview-isolation-verifier-secret-2026";
process.env.PACKETAGENT_MASTER_KEY = "packetagent-preview-isolation-verifier-master-key";

try {
  const [{ app, assertServerStartupRuntimeSupported }, services, store, generatedRuntime, runtime] =
    await Promise.all([
      import("./server.js"),
      import("./packetagent-services.js"),
      import("./packetagent-store.js"),
      import("./generated-app-runtime.js"),
      import("./generated-app-runtime/server.js"),
    ]);

  assert.equal(assertServerStartupRuntimeSupported().allowed, true);
  store.resetStoreForTests();
  const session = services.login({
    email: "alpha@packetagent.local",
    password: "demo12345",
  });

  const appId = "gapp_preview_isolation_verify";
  const checkpointId = "gapp_ckpt_preview_isolation_verify";
  const createdAt = new Date().toISOString();
  const draft: GeneratedAppRuntimeDraft = {
    prompt: "Verify generated preview origin isolation.",
    intent: "verification",
    summary: "A deterministic preview isolation verifier.",
    app: {
      slug: "preview-isolation-verify",
      name: "Preview Isolation Verify",
      description: "Exercises the isolated generated preview boundary.",
      pages: [
        {
          name: "Home",
          route: "/",
          access: "private",
          purpose: "Verify rendering.",
          actions: ["Inspect"],
          components: ["Verification card"],
        },
      ],
      dataSchema: [
        {
          name: "check",
          fields: [{ name: "name", type: "string", required: true }],
          relationships: [],
        },
      ],
      apiRoutes: [
        {
          method: "GET",
          path: "/api/checks",
          access: "private",
          purpose: "List checks.",
          handler: "listChecks",
          authRequired: true,
        },
      ],
      crudFlows: [
        {
          entity: "check",
          create: "Create checks.",
          read: "Read checks.",
          update: "Update checks.",
          delete: "Archive checks.",
          validation: ["name required"],
        },
      ],
      authDecisions: [
        {
          area: "Global policy",
          decision: "Authenticated",
          rationale: "Verification fixture.",
        },
      ],
    },
  };
  const artifact = generatedRuntime.buildGeneratedAppRuntimeArtifact({
    appId,
    workspaceId: "alpha",
    checkpointId,
    draft,
    renderedAt: createdAt,
  });
  store.mutateStore((data) => {
    data.generatedApps ??= [];
    data.generatedApps.push({
      id: appId,
      workspaceId: "alpha",
      slug: draft.app.slug,
      name: draft.app.name,
      description: draft.app.description,
      prompt: draft.prompt,
      templateId: draft.intent,
      status: "built",
      draft: draft as unknown as Record<string, unknown>,
      checkpointId,
      runtimeArtifact: artifact,
      sourceFiles: artifact.files,
      previewUrl: `/builder/preview/alpha/${appId}`,
      buildStatus: "passed",
      smokeStatus: "pass",
      checkpoints: [
        {
          id: checkpointId,
          appId,
          workspaceId: "alpha",
          label: "Preview isolation verification",
          draft: draft as unknown as Record<string, unknown>,
          runtimeArtifact: artifact,
          sourceFiles: artifact.files,
          previewUrl: `/builder/preview/alpha/${appId}`,
          buildStatus: "passed",
          smokeStatus: "pass",
          source: "initial",
          createdByUserId: session.context.user.id,
          createdAt,
        },
      ],
      createdByUserId: session.context.user.id,
      createdAt,
      updatedAt: createdAt,
    });
  });

  const primaryCookie = `packetagent_session=${session.cookieValue}`;
  const primaryPreview = await app.request(
    `${APP_ORIGIN}/api/app/generated-apps/${appId}/preview`,
    { headers: { Cookie: primaryCookie } },
  );
  assert.equal(primaryPreview.status, 404);

  const previewHostHealth = await app.request(`${PREVIEW_ORIGIN}/api/health`);
  assert.equal(previewHostHealth.status, 404);

  const standardHealth = await app.request(`${APP_ORIGIN}/api/health`);
  assert.equal(standardHealth.status, 200);
  assert.match(
    standardHealth.headers.get("content-security-policy") ?? "",
    new RegExp(`frame-src 'self' ${PREVIEW_ORIGIN.replaceAll(".", "\\.")}`),
  );

  const readTokenResponse = await app.request(
    `${APP_ORIGIN}/api/app/generated-apps/${appId}/preview-token`,
    {
      method: "POST",
      headers: { Cookie: primaryCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "read", checkpointId }),
    },
  );
  assert.equal(readTokenResponse.status, 200);
  const readToken = (await readTokenResponse.json()) as {
    token: string;
    previewUrl: string;
  };
  const shareUrl = new URL(readToken.previewUrl);
  assert.equal(shareUrl.origin, PREVIEW_ORIGIN);
  assert.equal(shareUrl.search, "");
  assert.match(shareUrl.hash, /^#token=pt1\./);

  shareUrl.hash = "";
  const bootstrap = await app.request(shareUrl);
  assert.equal(bootstrap.status, 200);
  assert.match(await bootstrap.text(), /location\.hash/);

  const readSessionResponse = await app.request(
    `${PREVIEW_ORIGIN}/api/app/generated-apps/${appId}/preview-session`,
    {
      method: "POST",
      headers: {
        Origin: PREVIEW_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: readToken.token }),
    },
  );
  assert.equal(readSessionResponse.status, 200);
  const readSetCookie = readSessionResponse.headers.get("set-cookie") ?? "";
  assert.match(readSetCookie, /packetagent_preview_[a-f0-9]{20}=/);
  assert.match(readSetCookie, /HttpOnly/i);
  assert.match(readSetCookie, /Secure/i);
  assert.match(readSetCookie, /SameSite=None/i);
  assert.match(readSetCookie, /Partitioned/i);
  assert.match(readSetCookie, new RegExp(`Path=/api/app/generated-apps/${appId}/`));
  assert.doesNotMatch(readSetCookie, /packetagent_session=/i);
  const readCookie = readSetCookie.split(";")[0] ?? "";

  const readDocument = await app.request(
    `${PREVIEW_ORIGIN}/api/app/generated-apps/${appId}/preview/`,
    { headers: { Cookie: readCookie } },
  );
  assert.equal(readDocument.status, 200);
  assert.match(readDocument.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const readHtml = await readDocument.text();
  assert.doesNotMatch(readHtml, new RegExp(escapeRegExp(readToken.token)));
  assert.doesNotMatch(readHtml, /packetagent\.preview\.v1/);

  const blockedWrite = await app.request(
    `${PREVIEW_ORIGIN}/api/app/generated-apps/${appId}/api/check`,
    {
      method: "POST",
      headers: { Cookie: readCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "blocked" }),
    },
  );
  assert.equal(blockedWrite.status, 403);

  const queryDelivery = await app.request(
    `${PREVIEW_ORIGIN}/api/app/generated-apps/${appId}/preview/?token=${encodeURIComponent(
      readToken.token,
    )}`,
  );
  assert.equal(queryDelivery.status, 400);

  const interactiveTokenResponse = await app.request(
    `${APP_ORIGIN}/api/app/generated-apps/${appId}/preview-token`,
    {
      method: "POST",
      headers: { Cookie: primaryCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "interact", checkpointId }),
    },
  );
  assert.equal(interactiveTokenResponse.status, 200);
  const interactiveToken = (await interactiveTokenResponse.json()) as { token: string };
  const interactiveSessionResponse = await app.request(
    `${PREVIEW_ORIGIN}/api/app/generated-apps/${appId}/preview-session`,
    {
      method: "POST",
      headers: {
        Origin: PREVIEW_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: interactiveToken.token }),
    },
  );
  assert.equal(interactiveSessionResponse.status, 200);
  const interactiveCookie =
    interactiveSessionResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
  const interactiveDocument = await app.request(
    `${PREVIEW_ORIGIN}/api/app/generated-apps/${appId}/preview/`,
    { headers: { Cookie: interactiveCookie } },
  );
  assert.equal(interactiveDocument.status, 200);
  assert.match(
    interactiveDocument.headers.get("content-security-policy") ?? "",
    new RegExp(`frame-ancestors ${APP_ORIGIN.replaceAll(".", "\\.")}`),
  );
  assert.match(await interactiveDocument.text(), /packetagent\.preview\.v1/);

  const browserProof = await verifyPreviewIsolationInChromium({
    app,
    appId,
    checkpointId,
    primaryCookie,
  });
  assert.equal(browserProof.generatedDocumentStatus, 200);
  assert.equal(browserProof.bridgeReady, true);
  assert.equal(browserProof.previewCookieHttpOnly, true);
  assert.equal(browserProof.primaryCookieLeaked, false);

  await runtime.shutdownDefaultGeneratedAppRuntimeProcessPool();
  store.clearStoreCacheForTests();
  console.log(
    JSON.stringify(
      {
        ok: true,
        appOrigin: APP_ORIGIN,
        previewOrigin: PREVIEW_ORIGIN,
        assertions: 30,
        capabilityDelivery: "fragment-to-http-only-cookie",
        readScopeWriteStatus: blockedWrite.status,
        browser: browserProof,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function verifyPreviewIsolationInChromium(input: {
  app: { fetch: (request: Request) => Response | Promise<Response> };
  appId: string;
  checkpointId: string;
  primaryCookie: string;
}) {
  const [{ serve }, { chromium }] = await Promise.all([
    import("@hono/node-server"),
    import("playwright"),
  ]);
  let previewUrl = "";
  const server = serve({
    port: 0,
    hostname: "0.0.0.0",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.hostname === "localhost" && url.pathname === "/verify-parent") {
        return new Response(
          `<!doctype html><html><body>
<div id="status">waiting</div>
<iframe id="preview" sandbox="allow-forms allow-modals allow-same-origin allow-scripts" referrerpolicy="no-referrer" src="${escapeHtmlAttribute(
            previewUrl,
          )}"></iframe>
<script>
  addEventListener("message", (event) => {
    if (event.data?.channel === "packetagent.preview.v1" && event.data?.kind === "ready") {
      document.getElementById("status").textContent = "bridge-ready";
    }
  });
</script>
</body></html>`,
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy":
                "default-src 'none'; frame-src http://127.0.0.2:*; script-src 'unsafe-inline'",
            },
          },
        );
      }
      return input.app.fetch(request);
    },
  });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const localAppOrigin = `http://localhost:${port}`;
  const localPreviewOrigin = `http://127.0.0.2:${port}`;
  process.env.NODE_ENV = "development";
  process.env.PORT = String(port);
  process.env.PACKETAGENT_APP_ORIGIN = localAppOrigin;
  process.env.PACKETAGENT_PREVIEW_ORIGIN = localPreviewOrigin;

  const tokenResponse = await input.app.fetch(
    new Request(`${localAppOrigin}/api/app/generated-apps/${input.appId}/preview-token`, {
      method: "POST",
      headers: {
        Cookie: input.primaryCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: "interact",
        checkpointId: input.checkpointId,
      }),
    }),
  );
  assert.equal(tokenResponse.status, 200);
  previewUrl = ((await tokenResponse.json()) as { previewUrl: string }).previewUrl;
  assert.equal(new URL(previewUrl).origin, localPreviewOrigin);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const sessionExchange = page.waitForResponse(
      (response) =>
        new URL(response.url()).hostname === "127.0.0.2" &&
        new URL(response.url()).pathname.endsWith("/preview-session") &&
        response.status() === 200,
      { timeout: 15_000 },
    );
    const generatedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).hostname === "127.0.0.2" &&
        response.headers()["x-packetagent-generated-app-id"] === input.appId,
      { timeout: 15_000 },
    );
    await page.goto(`${localAppOrigin}/verify-parent`);
    const sessionResponse = await sessionExchange;
    const response = await generatedResponse;
    await page.locator("#status").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.getElementById("status")?.textContent === "bridge-ready",
      undefined,
      { timeout: 15_000 },
    );
    const setCookie = (await sessionResponse.allHeaders())["set-cookie"] ?? "";
    return {
      generatedDocumentStatus: response.status(),
      bridgeReady: (await page.locator("#status").textContent()) === "bridge-ready",
      previewCookieHttpOnly:
        /packetagent_preview_[a-f0-9]{20}=/.test(setCookie) && /HttpOnly/i.test(setCookie),
      primaryCookieLeaked: /packetagent_(?:session|csrf)=/i.test(setCookie),
    };
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}
