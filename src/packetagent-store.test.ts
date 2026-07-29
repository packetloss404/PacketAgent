import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import {
  activationSignalRepository,
  clearStoreCacheForTests,
  createInvitationEmailDelivery,
  findInvitationEmailDelivery,
  findSessionByIdIndexed,
  findShareTokenByTokenIndexed,
  findUserByEmailIndexed,
  findUserByIdIndexed,
  findWorkspaceInvitationByTokenIndexed,
  findWorkspaceMembershipIndexed,
  findWorkspaceBrief,
  listActivitiesForWorkspaceIndexed,
  listAgentRunsForWorkspaceIndexed,
  listAgentsForWorkspaceIndexed,
  listImplementationPlanItemsForWorkspaceIndexed,
  listJobsForWorkspaceIndexed,
  listProviderCallsForWorkspaceIndexed,
  listRequirementsForWorkspaceIndexed,
  loadStore,
  listSessionsForUserIndexed,
  listShareTokensForWorkspaceIndexed,
  listActivationSignalsForWorkspace,
  listInvitationEmailDeliveries,
  listInvitationEmailDeliveriesIndexed,
  listValidationEvidenceForWorkspaceIndexed,
  listWorkspaceBriefVersionsIndexed,
  listWorkflowConcernsForWorkspaceIndexed,
  listWorkspaceInvitationsIndexed,
  listWorkspaceMembershipsIndexed,
  findWorkspaceMembership,
  listAgentRunsForWorkspace,
  listAgentsForWorkspace,
  listProvidersForWorkspace,
  listReleaseConfirmationsForWorkspace,
  listRequirementsForWorkspace,
  listValidationEvidenceForWorkspace,
  listWorkflowConcernsForWorkspace,
  markInvitationEmailDeliveryFailed,
  markInvitationEmailDeliverySent,
  markInvitationEmailDeliverySkipped,
  mutateStore,
  persistSqliteAppData,
  recordActivity,
  resetStoreForTests,
  upsertActivationSignal,
  upsertRequirement,
  upsertWorkspaceBrief,
  upsertWorkspaceMembership,
  type WorkspaceRole,
} from "./packetagent-store";
import {
  recordLocalInvitationEmailDelivery,
  PACKETAGENT_INVITATION_EMAIL_MODE_ENV,
} from "./invitation-email";

test("seed store includes product workflow records for each workspace", () => {
  const store = resetStoreForTests();

  for (const workspaceId of ["alpha", "beta", "gamma"]) {
    assert.ok(findWorkspaceBrief(store, workspaceId));
    assert.ok(listRequirementsForWorkspace(store, workspaceId).length > 0);
    assert.ok(listWorkflowConcernsForWorkspace(store, workspaceId).length > 0);
    assert.ok(listValidationEvidenceForWorkspace(store, workspaceId).length > 0);
    assert.ok(listReleaseConfirmationsForWorkspace(store, workspaceId).length > 0);
    assert.ok(listProvidersForWorkspace(store, workspaceId).length > 0);
    assert.ok(listAgentsForWorkspace(store, workspaceId).length > 0);
    assert.ok(listAgentRunsForWorkspace(store, workspaceId).length > 0);
  }

  assert.equal(listWorkflowConcernsForWorkspace(store, "beta", "blocker").length, 1);
  assert.equal(listReleaseConfirmationsForWorkspace(store, "gamma")[0]?.status, "confirmed");
});

test("upsert helpers create and update records by natural key", () => {
  const store = resetStoreForTests();
  const timestamp = "2026-01-02T03:04:05.000Z";

  const brief = upsertWorkspaceBrief(
    store,
    {
      workspaceId: "alpha",
      summary: "Updated alpha brief",
      goals: ["Clarify the release path"],
      audience: "Product lead",
      constraints: "Keep the validation scope focused.",
      problemStatement: "A clearer problem statement.",
      targetCustomers: ["Product lead"],
      desiredOutcome: "A clearer release path.",
      successMetrics: ["Brief is updated"],
      updatedByUserId: "user_alpha",
    },
    timestamp,
  );

  assert.equal(brief.summary, "Updated alpha brief");
  assert.equal(brief.updatedAt, timestamp);
  assert.notEqual(brief.createdAt, timestamp);
  assert.equal(findWorkspaceBrief(store, "alpha")?.summary, "Updated alpha brief");

  const requirement = upsertRequirement(
    store,
    {
      workspaceId: "alpha",
      title: "New durable requirement",
      detail: "Exercise generated IDs and timestamps.",
      priority: "could",
      status: "draft",
      acceptanceCriteria: ["Record exists"],
      source: "team",
      createdByUserId: "user_alpha",
    },
    timestamp,
  );

  assert.ok(requirement.id);
  assert.equal(requirement.createdAt, timestamp);
  assert.equal(findWorkspaceBrief(store, "alpha")?.summary, "Updated alpha brief");
});

test("workspace memberships support expanded roles", () => {
  const store = resetStoreForTests();
  const role: WorkspaceRole = "viewer";

  upsertWorkspaceMembership(store, {
    workspaceId: "alpha",
    userId: "user_beta",
    role,
    joinedAt: "2026-01-02T03:04:05.000Z",
  });

  assert.equal(findWorkspaceMembership(store, "alpha", "user_beta")?.role, "viewer");
});

test("invitation email deliveries record local sent and skipped attempts", () => {
  const previousMode = process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV];

  try {
    delete process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV];
    const store = resetStoreForTests();
    const invitation = {
      id: "invite_email_delivery",
      workspaceId: "alpha",
      email: "Invitee@Example.Com",
      role: "member" as const,
      token: "invite-email-delivery-token",
      invitedByUserId: "user_alpha",
      expiresAt: "2026-05-01T00:00:00.000Z",
      createdAt: "2026-04-01T00:00:00.000Z",
    };

    const sent = recordLocalInvitationEmailDelivery(store, {
      invitation,
      workspaceName: "Alpha Workspace",
      deliveryId: "delivery_sent",
      timestamp: "2026-04-01T00:00:01.000Z",
    });

    assert.equal(sent.status, "sent");
    assert.equal(sent.mode, "dev");
    assert.equal(sent.provider, "local");
    assert.equal(sent.recipientEmail, "invitee@example.com");
    assert.equal(sent.subject, "You're invited to Alpha Workspace on PacketAgent");
    assert.equal(sent.sentAt, "2026-04-01T00:00:01.000Z");

    process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV] = "skip";
    const skipped = recordLocalInvitationEmailDelivery(store, {
      invitation: { ...invitation, id: "invite_email_delivery_skipped" },
      deliveryId: "delivery_skipped",
      timestamp: "2026-04-01T00:00:02.000Z",
    });

    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.mode, "skip");
    assert.equal(skipped.sentAt, undefined);
    assert.equal(skipped.error, `${PACKETAGENT_INVITATION_EMAIL_MODE_ENV}=skip`);
    assert.deepEqual(
      listInvitationEmailDeliveries(store, "alpha").map((entry) => entry.id),
      ["delivery_skipped", "delivery_sent"],
    );
    assert.deepEqual(
      listInvitationEmailDeliveries(store, "alpha", "invite_email_delivery").map(
        (entry) => entry.id,
      ),
      ["delivery_sent"],
    );
  } finally {
    if (previousMode === undefined) delete process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV];
    else process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV] = previousMode;
  }
});

test("invitation email delivery helpers create and mark durable records", () => {
  const store = resetStoreForTests();
  const delivery = createInvitationEmailDelivery(
    store,
    {
      id: "delivery_marking",
      workspaceId: "alpha",
      invitationId: "invite_marking",
      recipientEmail: "Mark.Me@Example.Com",
      subject: "Invitation",
      provider: "local",
      mode: "dev",
    },
    "2026-04-02T00:00:00.000Z",
  );

  assert.equal(delivery.status, "pending");
  assert.equal(delivery.recipientEmail, "mark.me@example.com");
  assert.equal(
    markInvitationEmailDeliverySent(store, "delivery_marking", "2026-04-02T00:00:01.000Z")?.sentAt,
    "2026-04-02T00:00:01.000Z",
  );
  assert.equal(
    markInvitationEmailDeliverySkipped(store, "delivery_marking", "not needed")?.status,
    "skipped",
  );
  assert.equal(findInvitationEmailDelivery(store, "delivery_marking")?.sentAt, undefined);
  assert.equal(markInvitationEmailDeliveryFailed(store, "delivery_marking", "boom")?.error, "boom");
  assert.equal(findInvitationEmailDelivery(store, "missing_delivery"), null);
});

test("activation signal repository deduplicates JSON records by stable key", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;

  try {
    delete process.env.PACKETAGENT_STORE;
    delete process.env.PACKETAGENT_DB_PATH;
    const store = resetStoreForTests();

    const direct = upsertActivationSignal(
      store,
      {
        workspaceId: "alpha",
        kind: "retry",
        source: "user_fact",
        stableKey: "alpha:retry:user-entered",
        data: { reason: "Initial user-entered retry" },
      },
      "2026-04-01T00:00:00.000Z",
    );
    assert.equal(direct.source, "user_fact");
    assert.equal(direct.origin, "user_entered");

    const repository = activationSignalRepository();
    const first = repository.upsert(
      {
        workspaceId: "alpha",
        kind: "retry",
        source: "user_fact",
        stableKey: "alpha:retry:repository",
        data: { reason: "Entered by a user" },
      },
      "2026-04-02T00:00:00.000Z",
    );
    const second = repository.upsert(
      {
        workspaceId: "alpha",
        kind: "retry",
        source: "system_fact",
        stableKey: "alpha:retry:repository",
        data: { reason: "Observed by the system" },
      },
      "2026-04-03T00:00:00.000Z",
    );

    assert.equal(second.id, first.id);
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.updatedAt, "2026-04-03T00:00:00.000Z");
    assert.equal(second.source, "system_fact");
    assert.equal(second.origin, "system_observed");
    assert.equal(
      repository
        .listForWorkspace("alpha")
        .filter((entry) => entry.stableKey === "alpha:retry:repository").length,
      1,
    );
    assert.equal(
      listActivationSignalsForWorkspace(loadStore(), "alpha").some(
        (entry) => entry.id === first.id,
      ),
      true,
    );
  } finally {
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
  }
});

test("sqlite store persists mutations across cache reloads", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-store-"));

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = join(tempDir, "packetagent.sqlite");

    resetStoreForTests();
    mutateStore((data) => {
      upsertRequirement(
        data,
        {
          id: "req_sqlite_reload",
          workspaceId: "alpha",
          title: "SQLite reload requirement",
          detail: "Persists through the database-backed store adapter.",
          priority: "must",
          status: "approved",
          acceptanceCriteria: ["Requirement survives cache clear"],
          source: "test",
          createdByUserId: "user_alpha",
        },
        "2026-02-03T04:05:06.000Z",
      );
    });

    clearStoreCacheForTests();
    const reloaded = loadStore();

    assert.equal(
      reloaded.requirements.some((entry) => entry.id === "req_sqlite_reload"),
      true,
    );
    assert.equal(findWorkspaceBrief(reloaded, "alpha")?.workspaceId, "alpha");
  } finally {
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sqlite recordActivity writes activities to the dedicated table only", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-store-activity-dual-write-"));
  const dbPath = join(tempDir, "packetagent.sqlite");

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = dbPath;
    resetStoreForTests();

    mutateStore((data) => {
      recordActivity(data, {
        id: "activity_dual_write",
        workspaceId: "alpha",
        scope: "workspace",
        event: "workspace.updated",
        occurredAt: "2026-04-26T12:00:00.000Z",
        actor: { type: "user", id: "user_alpha", displayName: "Alpha User" },
        data: { title: "Workspace updated" },
      });
    });

    const db = new DatabaseSync(dbPath);
    try {
      const appRecord = db
        .prepare(
          "select count(*) as count from app_records where collection = 'activities' and id = ?",
        )
        .get("activity_dual_write") as { count: number };
      const dedicated = db
        .prepare("select workspace_id, type, payload from activities where id = ?")
        .get("activity_dual_write") as
        | { workspace_id: string; type: string; payload: string }
        | undefined;
      const payload = JSON.parse(dedicated?.payload ?? "{}") as { data?: Record<string, unknown> };

      assert.equal(appRecord.count, 0);
      assert.equal(dedicated?.workspace_id, "alpha");
      assert.equal(dedicated?.type, "workspace.updated");
      assert.deepEqual(payload.data, { title: "Workspace updated" });
    } finally {
      db.close();
    }
  } finally {
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sqlite: a failing dedicated-table dual-write flush does NOT make the primary mutation throw", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-store-flush-failure-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  const originalWarn = console.warn;
  const warnings: string[] = [];

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = dbPath;
    resetStoreForTests();

    // Make ONLY the post-commit dual-write flush fail, while the canonical
    // commit succeeds. The canonical commit persists dedicated rows via
    // "delete from activities" then a fresh insert (the row does not yet
    // exist), so this trigger does not fire there. The deferred flush then
    // opens a SEPARATE connection and re-inserts the already-committed row, at
    // which point the row exists and the trigger aborts -> flush throws.
    {
      const setup = new DatabaseSync(dbPath);
      try {
        setup.exec(
          "create trigger activities_block_reinsert before insert on activities when exists(select 1 from activities where id = new.id) begin select raise(abort, 'dedicated activities table is offline'); end",
        );
      } finally {
        setup.close();
      }
    }

    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    // Must NOT throw even though the dedicated-table flush fails.
    assert.doesNotThrow(() => {
      mutateStore((data) => {
        recordActivity(data, {
          id: "activity_flush_failure",
          workspaceId: "alpha",
          scope: "workspace",
          event: "workspace.updated",
          occurredAt: "2026-04-26T12:00:00.000Z",
          actor: { type: "user", id: "user_alpha", displayName: "Alpha User" },
          data: { title: "Workspace updated" },
        });
      });
    });

    console.warn = originalWarn;

    // Primary write committed: the canonical commit persisted the dedicated
    // activities row BEFORE the (failing) deferred flush ran, so the row is
    // present and durable despite the flush failure.
    const db = new DatabaseSync(dbPath);
    try {
      const row = db
        .prepare("select workspace_id, type from activities where id = ?")
        .get("activity_flush_failure") as { workspace_id: string; type: string } | undefined;
      assert.ok(row, "primary write should persist the activity row");
      assert.equal(row?.workspace_id, "alpha");
      assert.equal(row?.type, "workspace.updated");
    } finally {
      db.close();
    }

    // The dual-write failure was logged, not swallowed silently.
    assert.ok(warnings.some((message) => message.includes("dual-write flush failed")));
  } finally {
    console.warn = originalWarn;
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sqlite store hydrates retired relational collections from dedicated tables", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-store-dedicated-hydrate-"));
  const dbPath = join(tempDir, "packetagent.sqlite");

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = dbPath;
    const data = resetStoreForTests();
    data.jobMetricSnapshots.push({
      id: "metric_dedicated",
      capturedAt: "2026-04-26T12:00:00.000Z",
      type: "agent.run",
      totalRuns: 2,
      succeededRuns: 1,
      failedRuns: 1,
      canceledRuns: 0,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastDurationMs: null,
      averageDurationMs: null,
      p95DurationMs: null,
    });
    data.alertEvents.push({
      id: "alert_dedicated",
      ruleId: "rule_dedicated",
      severity: "warning",
      title: "Dedicated alert",
      detail: "Stored outside app_records.",
      observedAt: "2026-04-26T12:01:00.000Z",
      context: { source: "test" },
      delivered: false,
    });
    data.agentRuns.push({
      id: "run_dedicated",
      workspaceId: "alpha",
      title: "Dedicated run",
      status: "success",
      logs: [],
      createdAt: "2026-04-26T12:02:00.000Z",
      updatedAt: "2026-04-26T12:02:00.000Z",
    });
    data.jobs.push({
      id: "job_dedicated",
      workspaceId: "alpha",
      type: "test",
      payload: { source: "dedicated" },
      status: "queued",
      attempts: 0,
      maxAttempts: 1,
      scheduledAt: "2026-04-26T12:03:00.000Z",
      createdAt: "2026-04-26T12:03:00.000Z",
      updatedAt: "2026-04-26T12:03:00.000Z",
    });
    data.invitationEmailDeliveries.push({
      id: "delivery_dedicated",
      workspaceId: "alpha",
      invitationId: "invitation_dedicated",
      recipientEmail: "dedicated@example.com",
      subject: "Dedicated delivery",
      status: "pending",
      provider: "dev",
      mode: "dev",
      createdAt: "2026-04-26T12:04:00.000Z",
    });
    data.activities.push({
      id: "activity_dedicated",
      workspaceId: "alpha",
      scope: "workspace",
      event: "workspace.dedicated",
      occurredAt: "2026-04-26T12:05:00.000Z",
      actor: { type: "system", id: "test" },
      data: { title: "Dedicated activity" },
    });
    data.providerCalls.push({
      id: "provider_call_dedicated",
      workspaceId: "alpha",
      routeKey: "provider.dedicated",
      provider: "stub",
      model: "stub-small",
      promptTokens: 1,
      completionTokens: 2,
      costUsd: 0.01,
      durationMs: 10,
      status: "success",
      startedAt: "2026-04-26T12:06:00.000Z",
      completedAt: "2026-04-26T12:06:01.000Z",
    });
    data.activationSignals.push({
      id: "signal_dedicated",
      workspaceId: "alpha",
      kind: "retry",
      source: "user_fact",
      origin: "user_entered",
      sourceId: "run_dedicated",
      stableKey: "alpha:retry:dedicated",
      data: { reason: "whole-store persist" },
      createdAt: "2026-04-26T12:07:00.000Z",
      updatedAt: "2026-04-26T12:07:01.000Z",
    });
    persistSqliteAppData(dbPath, data);

    const db = new DatabaseSync(dbPath);
    try {
      const legacyRows = db
        .prepare(
          `
        select count(*) as count
        from app_records
        where (collection = 'jobMetricSnapshots' and id = 'metric_dedicated')
           or (collection = 'alertEvents' and id = 'alert_dedicated')
           or (collection = 'agentRuns' and id = 'run_dedicated')
           or (collection = 'jobs' and id = 'job_dedicated')
           or (collection = 'invitationEmailDeliveries' and id = 'delivery_dedicated')
           or (collection = 'activities' and id = 'activity_dedicated')
           or (collection = 'providerCalls' and id = 'provider_call_dedicated')
           or (collection = 'activationSignals' and id = 'signal_dedicated')
      `,
        )
        .get() as { count: number };
      assert.equal(legacyRows.count, 0);
      assert.equal(
        (
          db
            .prepare(
              "select count(*) as count from job_metric_snapshots where id = 'metric_dedicated'",
            )
            .get() as { count: number }
        ).count,
        1,
      );
      assert.equal(
        (
          db
            .prepare("select count(*) as count from alert_events where id = 'alert_dedicated'")
            .get() as { count: number }
        ).count,
        1,
      );
      assert.equal(
        (
          db
            .prepare("select count(*) as count from agent_runs where id = 'run_dedicated'")
            .get() as { count: number }
        ).count,
        1,
      );
      assert.equal(
        (
          db.prepare("select count(*) as count from jobs where id = 'job_dedicated'").get() as {
            count: number;
          }
        ).count,
        1,
      );
      assert.equal(
        (
          db
            .prepare(
              "select count(*) as count from invitation_email_deliveries where id = 'delivery_dedicated'",
            )
            .get() as { count: number }
        ).count,
        1,
      );
      assert.equal(
        (
          db
            .prepare("select count(*) as count from activities where id = 'activity_dedicated'")
            .get() as { count: number }
        ).count,
        1,
      );
      assert.equal(
        (
          db
            .prepare(
              "select count(*) as count from provider_calls where id = 'provider_call_dedicated'",
            )
            .get() as { count: number }
        ).count,
        1,
      );
      assert.equal(
        (
          db
            .prepare(
              "select count(*) as count from activation_signals where id = 'signal_dedicated'",
            )
            .get() as { count: number }
        ).count,
        1,
      );
    } finally {
      db.close();
    }

    clearStoreCacheForTests();
    const reloaded = loadStore();
    assert.equal(
      reloaded.jobMetricSnapshots.some((entry) => entry.id === "metric_dedicated"),
      true,
    );
    assert.equal(
      reloaded.alertEvents.some((entry) => entry.id === "alert_dedicated"),
      true,
    );
    assert.equal(
      reloaded.agentRuns.some((entry) => entry.id === "run_dedicated"),
      true,
    );
    assert.equal(
      reloaded.jobs.some((entry) => entry.id === "job_dedicated"),
      true,
    );
    assert.equal(
      reloaded.invitationEmailDeliveries.some((entry) => entry.id === "delivery_dedicated"),
      true,
    );
    assert.equal(
      reloaded.activities.some((entry) => entry.id === "activity_dedicated"),
      true,
    );
    assert.equal(
      reloaded.providerCalls.some((entry) => entry.id === "provider_call_dedicated"),
      true,
    );
    assert.equal(
      reloaded.activationSignals.some((entry) => entry.id === "signal_dedicated"),
      true,
    );
  } finally {
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sqlite mutateStore loads fresh state before persisting cached mutations", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-store-fresh-mutate-"));
  const dbPath = join(tempDir, "packetagent.sqlite");

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = dbPath;

    const cached = resetStoreForTests();
    const external = structuredClone(cached);
    upsertRequirement(
      external,
      {
        id: "req_sqlite_external",
        workspaceId: "alpha",
        title: "Externally persisted requirement",
        detail: "Must survive a mutation started with stale cache.",
        priority: "should",
        status: "approved",
        source: "test",
        createdByUserId: "user_alpha",
      },
      "2026-02-04T00:00:00.000Z",
    );
    persistSqliteAppData(dbPath, external);

    mutateStore((data) => {
      assert.equal(
        data.requirements.some((entry) => entry.id === "req_sqlite_external"),
        true,
      );
      upsertRequirement(
        data,
        {
          id: "req_sqlite_mutation",
          workspaceId: "alpha",
          title: "Mutation requirement",
          detail: "Persists alongside fresh database state.",
          priority: "must",
          status: "approved",
          source: "test",
          createdByUserId: "user_alpha",
        },
        "2026-02-04T00:01:00.000Z",
      );
    });

    clearStoreCacheForTests();
    const reloaded = loadStore();
    assert.equal(
      reloaded.requirements.some((entry) => entry.id === "req_sqlite_external"),
      true,
    );
    assert.equal(
      reloaded.requirements.some((entry) => entry.id === "req_sqlite_mutation"),
      true,
    );
  } finally {
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sqlite mutateStore rolls back and preserves cache when mutator throws", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-store-rollback-"));

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = join(tempDir, "packetagent.sqlite");

    resetStoreForTests();

    assert.throws(() => {
      mutateStore((data) => {
        upsertRequirement(
          data,
          {
            id: "req_sqlite_rollback",
            workspaceId: "alpha",
            title: "Rolled back requirement",
            detail: "Should not persist after a mutator failure.",
            priority: "must",
            status: "draft",
            source: "test",
            createdByUserId: "user_alpha",
          },
          "2026-02-05T00:00:00.000Z",
        );
        throw new Error("stop mutation");
      });
    }, /stop mutation/);

    assert.equal(
      loadStore().requirements.some((entry) => entry.id === "req_sqlite_rollback"),
      false,
    );
    clearStoreCacheForTests();
    assert.equal(
      loadStore().requirements.some((entry) => entry.id === "req_sqlite_rollback"),
      false,
    );
  } finally {
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("activation signal repository persists and lists SQLite records by workspace", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-store-signals-"));
  const dbPath = join(tempDir, "packetagent.sqlite");

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = dbPath;

    resetStoreForTests();
    const repository = activationSignalRepository();
    const first = repository.upsert(
      {
        workspaceId: "workspace_sqlite_signals",
        kind: "scope_change",
        source: "system_fact",
        stableKey: "workspace_sqlite_signals:scope:billing",
        sourceId: "activity_scope_billing",
        data: { area: "billing" },
      },
      "2026-04-04T00:00:00.000Z",
    );
    const second = repository.upsert(
      {
        workspaceId: "workspace_sqlite_signals",
        kind: "scope_change",
        source: "user_fact",
        stableKey: "workspace_sqlite_signals:scope:billing",
        sourceId: "manual_scope_billing",
        data: { area: "billing", confirmed: true },
      },
      "2026-04-05T00:00:00.000Z",
    );

    assert.equal(second.id, first.id);
    assert.equal(repository.listForWorkspace("workspace_sqlite_signals").length, 1);
    assert.equal(repository.listForWorkspace("workspace_sqlite_signals")[0]?.source, "user_fact");
    assert.equal(
      repository.listForWorkspace("workspace_sqlite_signals")[0]?.origin,
      "user_entered",
    );
    assert.equal(activationSignalRowCount(dbPath, "workspace_sqlite_signals"), 1);
    assert.equal(activationSignalAppRecordRowCount(dbPath), 0);

    clearStoreCacheForTests();
    const reloaded = loadStore();
    const signals = listActivationSignalsForWorkspace(reloaded, "workspace_sqlite_signals");
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.stableKey, "workspace_sqlite_signals:scope:billing");
  } finally {
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("activation signal repository de-dupes legacy fallback rows by stable key", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-store-signal-fallback-"));
  const dbPath = join(tempDir, "packetagent.sqlite");

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = dbPath;

    resetStoreForTests();
    const repository = activationSignalRepository();
    const dedicated = repository.upsert(
      {
        workspaceId: "workspace_sqlite_signals",
        kind: "retry",
        source: "agent_run",
        stableKey: "workspace_sqlite_signals:retry:shared",
        sourceId: "run_dedicated",
      },
      "2026-04-04T00:00:00.000Z",
    );
    insertLegacyActivationSignalAppRecord(dbPath, {
      ...dedicated,
      id: "legacy_signal_same_stable_key",
      sourceId: "run_legacy",
      updatedAt: "2026-04-05T00:00:00.000Z",
    });

    const signals = repository.listForWorkspace("workspace_sqlite_signals");
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.id, dedicated.id);
    assert.equal(signals[0]?.sourceId, "run_dedicated");
  } finally {
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sqlite upsertActivationSignal writes dedicated records during mutations", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-store-signal-mutation-"));
  const dbPath = join(tempDir, "packetagent.sqlite");

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = dbPath;

    resetStoreForTests();
    mutateStore((data) => {
      const record = upsertActivationSignal(
        data,
        {
          workspaceId: "workspace_sqlite_signal_mutation",
          kind: "retry",
          source: "agent_run",
          stableKey: "workspace_sqlite_signal_mutation:retry:run",
          sourceId: "run_sqlite_signal_mutation",
          data: { attempt: 2 },
        },
        "2026-04-06T00:00:00.000Z",
      );
      assert.equal(record.origin, "user_entered");
    });

    assert.equal(activationSignalRowCount(dbPath, "workspace_sqlite_signal_mutation"), 1);
    assert.equal(activationSignalAppRecordRowCount(dbPath), 0);

    clearStoreCacheForTests();
    const signals = listActivationSignalsForWorkspace(
      loadStore(),
      "workspace_sqlite_signal_mutation",
    );
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.sourceId, "run_sqlite_signal_mutation");
  } finally {
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sqlite indexed helpers read high-value records and stay in sync", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-store-index-"));
  const dbPath = join(tempDir, "packetagent.sqlite");

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = dbPath;

    resetStoreForTests();
    mutateStore((data) => {
      data.users.push({
        id: "user_sqlite_index",
        email: "Indexed.User@Example.Com",
        displayName: "Indexed User",
        timezone: "UTC",
        passwordHash: "hash",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      data.sessions.push({
        id: "session_sqlite_index",
        userId: "user_sqlite_index",
        secretHash: "secret",
        createdAt: "2026-03-01T00:00:00.000Z",
        lastAccessedAt: "2026-03-01T00:00:00.000Z",
        expiresAt: "2026-04-01T00:00:00.000Z",
      });
      data.workspaces.push({
        id: "workspace_sqlite_index",
        slug: "sqlite-index",
        name: "SQLite Index",
        website: "",
        automationGoal: "",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      data.memberships.push({
        workspaceId: "workspace_sqlite_index",
        userId: "user_sqlite_index",
        role: "admin",
        joinedAt: "2026-03-01T00:00:00.000Z",
      });
      data.workspaceInvitations.push({
        id: "invite_sqlite_index",
        workspaceId: "workspace_sqlite_index",
        email: "invitee@example.com",
        role: "member",
        token: "invite-token-sqlite-index",
        invitedByUserId: "user_sqlite_index",
        expiresAt: "2026-04-01T00:00:00.000Z",
        createdAt: "2026-03-01T00:00:00.000Z",
      });
      data.invitationEmailDeliveries.push({
        id: "delivery_sqlite_index",
        workspaceId: "workspace_sqlite_index",
        invitationId: "invite_sqlite_index",
        recipientEmail: "invitee@example.com",
        subject: "You're invited to SQLite Index on PacketAgent",
        status: "sent",
        provider: "local",
        mode: "dev",
        createdAt: "2026-03-01T00:00:01.000Z",
        sentAt: "2026-03-01T00:00:01.000Z",
      });
      data.shareTokens.push({
        id: "share_sqlite_index",
        workspaceId: "workspace_sqlite_index",
        token: "share-token-sqlite-index",
        scope: "overview",
        createdByUserId: "user_sqlite_index",
        readCount: 0,
        createdAt: "2026-03-01T00:00:00.000Z",
      });
    });

    clearStoreCacheForTests();
    assert.ok(indexRowCount(dbPath) >= 5);
    assert.equal(findUserByEmailIndexed("indexed.user@example.com")?.id, "user_sqlite_index");
    assert.equal(findUserByIdIndexed("user_sqlite_index")?.email, "Indexed.User@Example.Com");
    assert.equal(findSessionByIdIndexed("session_sqlite_index")?.userId, "user_sqlite_index");
    assert.equal(
      listSessionsForUserIndexed("user_sqlite_index").some(
        (entry) => entry.id === "session_sqlite_index",
      ),
      true,
    );
    assert.equal(
      findWorkspaceMembershipIndexed("workspace_sqlite_index", "user_sqlite_index")?.role,
      "admin",
    );
    assert.equal(
      listWorkspaceMembershipsIndexed("workspace_sqlite_index").some(
        (entry) => entry.userId === "user_sqlite_index",
      ),
      true,
    );
    assert.equal(
      findWorkspaceInvitationByTokenIndexed("invite-token-sqlite-index")?.id,
      "invite_sqlite_index",
    );
    assert.equal(
      listWorkspaceInvitationsIndexed("workspace_sqlite_index")[0]?.id,
      "invite_sqlite_index",
    );
    assert.equal(
      listInvitationEmailDeliveriesIndexed("workspace_sqlite_index")[0]?.id,
      "delivery_sqlite_index",
    );
    assert.equal(
      listInvitationEmailDeliveriesIndexed("workspace_sqlite_index", "invite_sqlite_index")[0]
        ?.recipientEmail,
      "invitee@example.com",
    );
    assert.equal(
      findShareTokenByTokenIndexed("share-token-sqlite-index")?.id,
      "share_sqlite_index",
    );
    assert.equal(
      listShareTokensForWorkspaceIndexed("workspace_sqlite_index")[0]?.id,
      "share_sqlite_index",
    );

    mutateStore((data) => {
      const user = data.users.find((entry) => entry.id === "user_sqlite_index");
      assert.ok(user);
      user.email = "updated.index@example.com";
      user.updatedAt = "2026-03-02T00:00:00.000Z";
      data.sessions = data.sessions.filter((entry) => entry.id !== "session_sqlite_index");
      const shareToken = data.shareTokens.find((entry) => entry.id === "share_sqlite_index");
      assert.ok(shareToken);
      shareToken.token = "share-token-sqlite-updated";
      shareToken.readCount = 3;
    });

    clearStoreCacheForTests();
    assert.equal(findUserByEmailIndexed("indexed.user@example.com"), null);
    assert.equal(findUserByEmailIndexed("updated.index@example.com")?.id, "user_sqlite_index");
    assert.equal(findSessionByIdIndexed("session_sqlite_index"), null);
    assert.equal(findShareTokenByTokenIndexed("share-token-sqlite-index"), null);
    assert.equal(findShareTokenByTokenIndexed("share-token-sqlite-updated")?.readCount, 3);
  } finally {
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sqlite workspace record helpers read scoped collections with route ordering", () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-store-workspace-records-"));
  const dbPath = join(tempDir, "packetagent.sqlite");

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = dbPath;

    resetStoreForTests();
    mutateStore((data) => {
      data.activities.push({
        id: "activity_workspace_records_old",
        workspaceId: "workspace_records",
        scope: "workspace",
        event: "workspace.old",
        occurredAt: "2026-03-01T00:00:00.000Z",
        actor: { type: "system", id: "test" },
        data: {},
      });
      data.activities.push({
        id: "activity_workspace_records_new",
        workspaceId: "workspace_records",
        scope: "workspace",
        event: "workspace.new",
        occurredAt: "2026-03-02T00:00:00.000Z",
        actor: { type: "system", id: "test" },
        data: {},
      });
      data.activities.push({
        id: "activity_other_workspace",
        workspaceId: "other_workspace",
        scope: "workspace",
        event: "workspace.private",
        occurredAt: "2026-03-03T00:00:00.000Z",
        actor: { type: "system", id: "test" },
        data: {},
      });
      data.requirements.push({
        id: "req_workspace_records",
        workspaceId: "workspace_records",
        title: "Workspace-scoped requirement",
        priority: "must",
        status: "approved",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      data.implementationPlanItems.push({
        id: "plan_workspace_records_second",
        workspaceId: "workspace_records",
        requirementIds: ["req_workspace_records"],
        title: "Second plan item",
        description: "Sorts after the first item.",
        status: "todo",
        order: 2,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      data.implementationPlanItems.push({
        id: "plan_workspace_records_first",
        workspaceId: "workspace_records",
        requirementIds: ["req_workspace_records"],
        title: "First plan item",
        description: "Sorts before the second item.",
        status: "todo",
        order: 1,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      data.workflowConcerns.push({
        id: "concern_workspace_records_question",
        workspaceId: "workspace_records",
        kind: "open_question",
        title: "Question",
        description: "Question for workspace helper.",
        status: "open",
        severity: "medium",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      data.validationEvidence.push({
        id: "evidence_workspace_records",
        workspaceId: "workspace_records",
        title: "Evidence",
        status: "passed",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      data.agents.push({
        id: "agent_workspace_records_old",
        workspaceId: "workspace_records",
        name: "Old agent",
        description: "Older agent.",
        instructions: "Do the old thing.",
        tools: [],
        status: "active",
        createdByUserId: "user_alpha",
        inputSchema: [],
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      data.agents.push({
        id: "agent_workspace_records_new",
        workspaceId: "workspace_records",
        name: "New agent",
        description: "Newer agent.",
        instructions: "Do the new thing.",
        tools: [],
        status: "active",
        createdByUserId: "user_alpha",
        inputSchema: [],
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      });
      data.agentRuns.push({
        id: "run_workspace_records_old",
        workspaceId: "workspace_records",
        agentId: "agent_workspace_records_new",
        title: "Old run",
        status: "success",
        logs: [],
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      data.agentRuns.push({
        id: "run_workspace_records_new",
        workspaceId: "workspace_records",
        agentId: "agent_workspace_records_new",
        title: "New run",
        status: "success",
        logs: [],
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      });
      data.providerCalls.push({
        id: "provider_call_workspace_records_old",
        workspaceId: "workspace_records",
        routeKey: "test.route",
        provider: "stub",
        model: "stub",
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        durationMs: 1,
        status: "success",
        startedAt: "2026-03-01T00:00:00.000Z",
        completedAt: "2026-03-01T00:00:00.000Z",
      });
      data.providerCalls.push({
        id: "provider_call_workspace_records_new",
        workspaceId: "workspace_records",
        routeKey: "test.route",
        provider: "stub",
        model: "stub",
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        durationMs: 1,
        status: "success",
        startedAt: "2026-03-02T00:00:00.000Z",
        completedAt: "2026-03-02T00:00:00.000Z",
      });
      data.jobs.push({
        id: "job_workspace_records_old",
        workspaceId: "workspace_records",
        type: "test",
        payload: {},
        status: "success",
        attempts: 1,
        maxAttempts: 1,
        scheduledAt: "2026-03-01T00:00:00.000Z",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      data.jobs.push({
        id: "job_workspace_records_new",
        workspaceId: "workspace_records",
        type: "test",
        payload: {},
        status: "queued",
        attempts: 0,
        maxAttempts: 1,
        scheduledAt: "2026-03-02T00:00:00.000Z",
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      });
      data.workspaceBriefVersions.push({
        id: "brief_version_workspace_records_1",
        workspaceId: "workspace_records",
        versionNumber: 1,
        summary: "First version",
        goals: [],
        audience: "",
        constraints: "",
        problemStatement: "",
        targetCustomers: [],
        desiredOutcome: "",
        successMetrics: [],
        source: "manual",
        createdAt: "2026-03-01T00:00:00.000Z",
      });
      data.workspaceBriefVersions.push({
        id: "brief_version_workspace_records_2",
        workspaceId: "workspace_records",
        versionNumber: 2,
        summary: "Second version",
        goals: [],
        audience: "",
        constraints: "",
        problemStatement: "",
        targetCustomers: [],
        desiredOutcome: "",
        successMetrics: [],
        source: "manual",
        createdAt: "2026-03-02T00:00:00.000Z",
      });
    });

    clearStoreCacheForTests();
    assert.deepEqual(
      listActivitiesForWorkspaceIndexed("workspace_records", 1).map((entry) => entry.id),
      ["activity_workspace_records_new"],
    );
    assert.deepEqual(
      listImplementationPlanItemsForWorkspaceIndexed("workspace_records").map((entry) => entry.id),
      ["plan_workspace_records_first", "plan_workspace_records_second"],
    );
    assert.deepEqual(
      listAgentsForWorkspaceIndexed("workspace_records").map((entry) => entry.id),
      ["agent_workspace_records_new", "agent_workspace_records_old"],
    );
    assert.deepEqual(
      listAgentRunsForWorkspaceIndexed("workspace_records").map((entry) => entry.id),
      ["run_workspace_records_new", "run_workspace_records_old"],
    );
    assert.deepEqual(
      listProviderCallsForWorkspaceIndexed("workspace_records", { limit: 1 }).map(
        (entry) => entry.id,
      ),
      ["provider_call_workspace_records_new"],
    );
    assert.deepEqual(
      listJobsForWorkspaceIndexed("workspace_records", { status: "queued", limit: 1 }).map(
        (entry) => entry.id,
      ),
      ["job_workspace_records_new"],
    );
    assert.deepEqual(
      listWorkspaceBriefVersionsIndexed("workspace_records").map((entry) => entry.id),
      ["brief_version_workspace_records_2", "brief_version_workspace_records_1"],
    );
    assert.equal(
      listRequirementsForWorkspaceIndexed("workspace_records").some(
        (entry) => entry.id === "req_workspace_records",
      ),
      true,
    );
    assert.equal(
      listWorkflowConcernsForWorkspaceIndexed("workspace_records", "open_question").length,
      1,
    );
    assert.equal(listValidationEvidenceForWorkspaceIndexed("workspace_records").length, 1);
    assert.equal(
      listActivitiesForWorkspaceIndexed("workspace_records").some(
        (entry) => entry.workspaceId === "other_workspace",
      ),
      false,
    );

    mutateStore((data) => {
      const requirement = data.requirements.find((entry) => entry.id === "req_workspace_records");
      assert.ok(requirement);
      requirement.title = "Updated workspace-scoped requirement";
      requirement.updatedAt = "2026-03-03T00:00:00.000Z";
      data.validationEvidence = data.validationEvidence.filter(
        (entry) => entry.id !== "evidence_workspace_records",
      );
    });

    clearStoreCacheForTests();
    assert.equal(
      listRequirementsForWorkspaceIndexed("workspace_records")[0]?.title,
      "Updated workspace-scoped requirement",
    );
    assert.equal(listValidationEvidenceForWorkspaceIndexed("workspace_records").length, 0);
  } finally {
    clearStoreCacheForTests();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function indexRowCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select count(*) as count from app_record_search").get() as {
      count: number;
    };
    return row.count;
  } finally {
    db.close();
  }
}

function activationSignalRowCount(dbPath: string, workspaceId: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("select count(*) as count from activation_signals where workspace_id = ?")
      .get(workspaceId) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function activationSignalAppRecordRowCount(dbPath: string, workspaceId?: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = workspaceId
      ? (db
          .prepare(
            "select count(*) as count from app_records where collection = 'activationSignals' and workspace_id = ?",
          )
          .get(workspaceId) as { count: number })
      : (db
          .prepare(
            "select count(*) as count from app_records where collection = 'activationSignals'",
          )
          .get() as { count: number });
    return row.count;
  } finally {
    db.close();
  }
}

function insertLegacyActivationSignalAppRecord(
  dbPath: string,
  record: import("./packetagent-store").ActivationSignalRecord,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('activationSignals', ?, ?, json(?), ?)
    `,
    ).run(record.id, record.workspaceId, JSON.stringify(record), record.updatedAt);
  } finally {
    db.close();
  }
}
