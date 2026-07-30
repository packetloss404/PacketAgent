import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_COOKIE_NAME } from "./auth-utils.js";
import {
  createAgentBundleSigningIdentityFromSecret,
  sealAgentWorkerBundle,
  verifyAgentWorkerBundle,
  type AgentWorkerBundle,
} from "./agents/portable-bundle.js";
import { resetStoreForTests, type AgentRecord } from "./packetagent-store.js";
import { login } from "./packetagent-services.js";
import { app } from "./server.js";

const TEST_MASTER_KEY = "packetagent-agent-portability-test-master-key";
const timestamp = "2026-07-29T18:00:00.000Z";

test("Agent–Worker bundle v1 is digest-bound, DSSE-signed, and strips local state", () => {
  const signingIdentity = createAgentBundleSigningIdentityFromSecret(
    "packetagent-agent-portability-source",
  );
  const bundle = sealAgentWorkerBundle({
    agent: fixtureAgent(),
    provider: {
      id: "provider_install_local",
      workspaceId: "workspace_install_local",
      name: "Local OpenAI",
      kind: "openai",
      defaultModel: "gpt-5-mini",
      apiKeyConfigured: true,
      status: "connected",
      baseUrl: "https://install-local.example.invalid/v1",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    exportedAt: timestamp,
    signingIdentity,
  });
  const verification = verifyAgentWorkerBundle(bundle, {
    localKeyId: signingIdentity.keyId,
  });

  assert.equal(verification.ok, true);
  if (!verification.ok) assert.fail("sealed Agent bundle did not verify");
  assert.equal(verification.publisher.trust, "local");
  assert.equal(bundle.schemaVersion, "packetagent.agent-worker-bundle/v1");
  assert.match(bundle.integrity.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(bundle.worker.contentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(bundle.integrity.signature.algorithm, "ed25519");
  assert.equal(bundle.integrity.signature.dsseEnvelope.signatures.length, 1);
  assert.deepEqual(bundle.agent.providerHint, {
    kind: "openai",
    name: "Local OpenAI",
    defaultModel: "gpt-5-mini",
  });

  const serialized = JSON.stringify(bundle);
  assert.equal(serialized.includes("provider_install_local"), false);
  assert.equal(serialized.includes("workspace_install_local"), false);
  assert.equal(serialized.includes("user_install_local"), false);
  assert.equal(serialized.includes("webhook-secret-install-local"), false);
  assert.equal(serialized.includes("apiKey"), false);
  assert.equal(serialized.includes("baseUrl"), false);
  assert.equal(serialized.includes("run"), false);
});

test("Agent–Worker export refuses secret-like authored content and secret defaults", () => {
  assert.throws(
    () =>
      sealAgentWorkerBundle({
        agent: {
          ...fixtureAgent(),
          instructions:
            "Review the release, but first use authorization=must-never-enter-a-bundle.",
        },
        provider: null,
        exportedAt: timestamp,
        signingIdentity: createAgentBundleSigningIdentityFromSecret("secret-scan-source"),
      }),
    /export refused secret-like authored content/,
  );
  assert.throws(
    () =>
      sealAgentWorkerBundle({
        agent: {
          ...fixtureAgent(),
          inputSchema: [
            {
              key: "api_key",
              label: "API key",
              type: "string",
              required: true,
              defaultValue: "must-never-enter-a-bundle",
            },
          ],
        },
        provider: null,
        exportedAt: timestamp,
        signingIdentity: createAgentBundleSigningIdentityFromSecret("secret-default-source"),
      }),
    /export refused secret-like authored content/,
  );
});

test("Agent–Worker verification fails closed on tampering and classifies signer substitution", () => {
  const source = createAgentBundleSigningIdentityFromSecret("portability-source-a");
  const bundle = sealAgentWorkerBundle({
    agent: fixtureAgent(),
    provider: null,
    exportedAt: timestamp,
    signingIdentity: source,
  });

  const changed = structuredClone(bundle);
  (changed.agent as { instructions: string }).instructions =
    "Tampered instructions that should fail closed.";
  const changedResult = verifyAgentWorkerBundle(changed, { localKeyId: source.keyId });
  assert.equal(changedResult.ok, false);
  if (changedResult.ok) assert.fail("tampered bundle verified");
  assert.ok(
    changedResult.issues.some(
      (entry) =>
        entry.code === "agent_bundle.worker.projection_mismatch" ||
        entry.code === "agent_bundle.integrity.digest_mismatch",
    ),
  );

  const unexpected = structuredClone(bundle) as AgentWorkerBundle & {
    agent: AgentWorkerBundle["agent"] & { apiKey: string };
  };
  unexpected.agent.apiKey = "must-never-cross";
  const unexpectedResult = verifyAgentWorkerBundle(unexpected, { localKeyId: source.keyId });
  assert.equal(unexpectedResult.ok, false);
  if (unexpectedResult.ok) assert.fail("bundle with secret field verified");
  assert.ok(
    unexpectedResult.issues.some(
      (entry) => entry.path === "$.agent.apiKey" && entry.code === "agent_bundle.unexpected_field",
    ),
  );

  const other = sealAgentWorkerBundle({
    agent: fixtureAgent(),
    provider: null,
    exportedAt: timestamp,
    signingIdentity: createAgentBundleSigningIdentityFromSecret("portability-source-b"),
  });
  const substituted = structuredClone(bundle);
  (
    substituted.integrity.signature as {
      publicKey: AgentWorkerBundle["integrity"]["signature"]["publicKey"];
    }
  ).publicKey = other.integrity.signature.publicKey;
  (substituted.integrity.signature as { keyId: string }).keyId = other.integrity.signature.keyId;
  (
    substituted.integrity.signature.dsseEnvelope as {
      signatures: AgentWorkerBundle["integrity"]["signature"]["dsseEnvelope"]["signatures"];
    }
  ).signatures = other.integrity.signature.dsseEnvelope.signatures;
  const substitutedResult = verifyAgentWorkerBundle(substituted, {
    localKeyId: source.keyId,
  });
  assert.equal(substitutedResult.ok, true);
  if (!substitutedResult.ok) assert.fail("valid alternate signature did not verify");
  assert.equal(substitutedResult.publisher.trust, "untrusted");
  assert.notEqual(substitutedResult.publisher.keyId, source.keyId);
});

test("admin routes export, validate, and idempotently import a paused Agent without local effects", async () => {
  const previousMasterKey = process.env.MASTER_KEY;
  process.env.MASTER_KEY = TEST_MASTER_KEY;
  try {
    resetStoreForTests();
    const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const headers = {
      Cookie: `${SESSION_COOKIE_NAME}=${auth.cookieValue}`,
      "content-type": "application/json",
    };
    const createdResponse = await app.request("/api/app/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Portable release reviewer",
        description: "Reviews bounded release evidence.",
        instructions: "Review the supplied release evidence and return a concise decision.",
        tools: ["http_fetch"],
        enabledTools: ["http_fetch"],
        routeKey: "agent.reasoning",
        schedule: "0 9 * * 1",
        triggerKind: "schedule",
        playbook: [{ title: "Review", instruction: "Inspect the supplied evidence." }],
        memory: [{ label: "Policy", content: "Escalate unresolved release blockers." }],
        evaluationSpec: {
          expectedOutput: "A concise release decision.",
          requiredTools: ["http_fetch"],
        },
        status: "active",
        inputSchema: [
          {
            key: "release",
            label: "Release",
            type: "string",
            required: true,
            exampleValue: "2026.07",
          },
        ],
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { agent: AgentRecord };

    const exportResponse = await app.request(`/api/app/agents/${created.agent.id}/export`, {
      headers,
    });
    const bundle = (await exportResponse.json()) as AgentWorkerBundle;
    assert.equal(exportResponse.status, 200);
    assert.equal(exportResponse.headers.get("cache-control"), "no-store");
    assert.match(
      exportResponse.headers.get("content-disposition") ?? "",
      /portable-release-reviewer\.packetagent-agent\.json/,
    );
    assert.equal(bundle.agent.triggerKind, "schedule");
    assert.equal(bundle.agent.schedule, "0 9 * * 1");
    assert.equal("status" in bundle.agent, false);

    const validationResponse = await app.request("/api/app/agents/import/validate", {
      method: "POST",
      headers,
      body: JSON.stringify({ bundle }),
    });
    const validation = (await validationResponse.json()) as {
      publisher: { trust: string; acknowledgementRequired: boolean };
      importPolicy: { status: string; credentialsIncluded: boolean; localIdsIncluded: boolean };
    };
    assert.equal(validationResponse.status, 200);
    assert.equal(validation.publisher.trust, "local");
    assert.equal(validation.publisher.acknowledgementRequired, false);
    assert.deepEqual(validation.importPolicy, {
      status: "paused",
      credentialsIncluded: false,
      webhookTokenIncluded: false,
      runHistoryIncluded: false,
      localIdsIncluded: false,
    });

    const unexpectedWrapperResponse = await app.request("/api/app/agents/import/validate", {
      method: "POST",
      headers,
      body: JSON.stringify({ bundle, ignored: "not allowed" }),
    });
    assert.equal(unexpectedWrapperResponse.status, 400);

    const oversizedWrapperResponse = await app.request("/api/app/agents/import/validate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        bundle,
        padding: "x".repeat(512 * 1024),
      }),
    });
    assert.equal(oversizedWrapperResponse.status, 413);

    const idempotencyKey = "agent-portability-route-import-1";
    const importResponse = await app.request("/api/app/agents/import", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ bundle }),
    });
    const imported = (await importResponse.json()) as {
      agent: AgentRecord;
      replayed: boolean;
    };
    assert.equal(importResponse.status, 201);
    assert.equal(imported.replayed, false);
    assert.notEqual(imported.agent.id, created.agent.id);
    assert.notEqual(imported.agent.workspaceId, bundle.source.product);
    assert.equal(imported.agent.status, "paused");
    assert.equal(imported.agent.schedule, "0 9 * * 1");
    assert.equal(imported.agent.webhookToken, undefined);
    assert.equal(imported.agent.memory?.[0]?.content, "Escalate unresolved release blockers.");
    assert.notEqual(imported.agent.memory?.[0]?.id, "memory_install_local");

    const replayResponse = await app.request("/api/app/agents/import", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ bundle }),
    });
    const replayed = (await replayResponse.json()) as {
      agent: AgentRecord;
      replayed: boolean;
    };
    assert.equal(replayResponse.status, 201);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.agent.id, imported.agent.id);

    const otherBundle = sealAgentWorkerBundle({
      agent: {
        ...fixtureAgent(),
        name: "Different portable reviewer",
      },
      provider: null,
      exportedAt: timestamp,
    });
    const conflictResponse = await app.request("/api/app/agents/import", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ bundle: otherBundle }),
    });
    assert.equal(conflictResponse.status, 409);

    const changed = structuredClone(bundle);
    (changed.agent as { name: string }).name = "Different Agent";
    const tamperedResponse = await app.request("/api/app/agents/import", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": "agent-portability-tampered" },
      body: JSON.stringify({ bundle: changed }),
    });
    assert.equal(tamperedResponse.status, 400);

    const secretUpdateResponse = await app.request(`/api/app/agents/${created.agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        instructions:
          "Review the supplied release evidence with authorization=legacy-record-secret.",
      }),
    });
    assert.equal(secretUpdateResponse.status, 200);
    const refusedExportResponse = await app.request(`/api/app/agents/${created.agent.id}/export`, {
      headers,
    });
    const refusedExport = (await refusedExportResponse.json()) as { error: string };
    assert.equal(refusedExportResponse.status, 409);
    assert.match(refusedExport.error, /move secrets to the workspace vault/);
    assert.equal(refusedExport.error.includes("legacy-record-secret"), false);
  } finally {
    if (previousMasterKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = previousMasterKey;
  }
});

test("an unconfigured publisher requires explicit fingerprint acknowledgement", async () => {
  const previousMasterKey = process.env.MASTER_KEY;
  process.env.MASTER_KEY = TEST_MASTER_KEY;
  try {
    resetStoreForTests();
    const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const headers = {
      Cookie: `${SESSION_COOKIE_NAME}=${auth.cookieValue}`,
      "content-type": "application/json",
    };
    const bundle = sealAgentWorkerBundle({
      agent: fixtureAgent(),
      provider: null,
      exportedAt: timestamp,
      signingIdentity: createAgentBundleSigningIdentityFromSecret("different-packetagent-install"),
    });

    const validationResponse = await app.request("/api/app/agents/import/validate", {
      method: "POST",
      headers,
      body: JSON.stringify({ bundle }),
    });
    const validation = (await validationResponse.json()) as {
      publisher: { keyId: string; trust: string; acknowledgementRequired: boolean };
    };
    assert.equal(validationResponse.status, 200);
    assert.equal(validation.publisher.trust, "untrusted");
    assert.equal(validation.publisher.acknowledgementRequired, true);

    const rejectedResponse = await app.request("/api/app/agents/import", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": "untrusted-publisher-rejected" },
      body: JSON.stringify({ bundle }),
    });
    assert.equal(rejectedResponse.status, 409);

    const acceptedResponse = await app.request("/api/app/agents/import", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": "untrusted-publisher-accepted" },
      body: JSON.stringify({
        bundle,
        acknowledgeUntrustedPublisher: true,
      }),
    });
    const accepted = (await acceptedResponse.json()) as { agent: AgentRecord; replayed: boolean };
    assert.equal(acceptedResponse.status, 201);
    assert.equal(accepted.replayed, false);
    assert.equal(accepted.agent.status, "paused");
  } finally {
    if (previousMasterKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = previousMasterKey;
  }
});

function fixtureAgent(): AgentRecord {
  return {
    id: "agent_install_local",
    workspaceId: "workspace_install_local",
    name: "Portable release reviewer",
    description: "Reviews bounded release evidence.",
    instructions: "Review the supplied release evidence and return a concise decision.",
    providerId: "provider_install_local",
    model: "gpt-5-mini",
    tools: ["http_fetch"],
    enabledTools: ["http_fetch"],
    routeKey: "agent.reasoning",
    webhookToken: "webhook-secret-install-local",
    schedule: "0 9 * * 1",
    triggerKind: "schedule",
    playbook: [
      {
        id: "playbook_install_local",
        title: "Review",
        instruction: "Inspect the supplied evidence.",
      },
    ],
    memory: [
      {
        id: "memory_install_local",
        label: "Policy",
        content: "Escalate unresolved release blockers.",
      },
    ],
    evaluationSpec: {
      expectedOutput: "A concise release decision.",
      requiredTools: ["http_fetch"],
    },
    status: "active",
    createdByUserId: "user_install_local",
    templateId: "template_install_local",
    inputSchema: [
      {
        key: "release",
        label: "Release",
        type: "string",
        required: true,
        exampleValue: "2026.07",
      },
    ],
    publishHistory: [{ id: "publish_install_local" }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
