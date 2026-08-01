import {
  AppBuilderDraftContract,
  AppDraftSource,
  GeneratedAppCheckpointWithRuntime,
  GeneratedAppRecordWithRuntime,
  GeneratedAppWorkspaceSummary,
} from "./contracts.js";
import { buildAppSmokeStatus, previewUrlForDraft, runAppSmokeViaSandbox } from "./smoke.js";
import {
  buildGeneratedAppRuntimeArtifact,
  buildGeneratedAppRuntimeArtifactFromFiles,
  type GeneratedAppRuntimeArtifactRecord,
  summarizeGeneratedAppSourceFiles,
  writeGeneratedAppRuntimeWorkspace,
} from "../../generated-app-runtime.js";
import { checkpointForPublish, generatedFilesFromUnknown } from "./generated-apps.js";
import { dirname } from "node:path";
import { requireAuthenticatedContextAsync } from "../../packetagent-services.js";
import {
  type ApiRouteStub,
  type AppDraft,
  type CrudFlowDraft,
  type FieldSchemaDraft,
  generateAppDraftFromPrompt,
  type PageDraft,
} from "../../app-builder-service.js";
import {
  type AuthenticatedRouteContext,
  chatStreamDelay,
  emitProse,
  errorResponse,
  httpRouteError,
  requireWorkspacePermission,
  stableAppId,
  stableHash,
} from "../shared.js";
import { type Context } from "hono";
import {
  type GeneratedAppCheckpointRecord,
  type GeneratedAppStatus,
  mutateStoreAsync,
  recordActivity,
} from "../../packetagent-store.js";
import { type GeneratedFile } from "../../codegen/llm-author.js";

const TEMPLATE_NARRATION_LABELS: Record<AppDraft["templateId"], string> = {
  crm: "CRM",
  booking: "booking",
  internal_dashboard: "internal dashboard",
  task_tracker: "task tracker",
  customer_portal: "customer portal",
};

function templateNarrationLines(draft: AppDraft): string[] {
  const lines: string[] = [];
  lines.push("Let me take a look at what you're describing…\n\n");

  const entities = Array.isArray(draft.dataSchema?.entities) ? draft.dataSchema.entities : [];
  const routes = Array.isArray(draft.apiRouteStubs) ? draft.apiRouteStubs : [];
  const label =
    (draft.templateId && TEMPLATE_NARRATION_LABELS[draft.templateId]) || draft.templateId;
  if (label) {
    lines.push(
      `I think the **${label}** shape fits this best — it has ${entities.length} entities and ${routes.length} routes ready to go.\n\nLet me put the plan together…\n\n`,
    );
  }

  const entityNames = entities
    .map((entity) => entity?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  if (entityNames.length > 0) {
    lines.push(`I'm sketching out the data model: ${entityNames.join(", ")}.\n\n`);
  }

  const routeNames = routes
    .map((route) => (route && typeof route.path === "string" ? route.path : null))
    .filter((path): path is string => typeof path === "string" && path.length > 0)
    .slice(0, 6);
  if (routeNames.length > 0) {
    lines.push(`Wiring up the API surface — ${routeNames.join(", ")}.\n\n`);
  }

  lines.push("Here's the plan. Click Approve when it looks right.\n\n");
  return lines;
}

export async function streamTemplateNarration(
  sse: { writeSSE: (event: { event: string; data: string }) => Promise<void> },
  draft: AppDraft,
): Promise<void> {
  let lines: string[];
  try {
    lines = templateNarrationLines(draft);
  } catch {
    return;
  }
  for (const line of lines) {
    // Split on word boundaries so each whitespace-separated token streams
    // as its own SSE chunk, but preserve trailing whitespace (incl. the
    // double newlines that separate paragraphs) so the UI renders newlines.
    const tokens = line.match(/\S+\s*|\s+/g);
    if (!tokens) continue;
    for (const token of tokens) {
      await emitProse(sse, token);
      await chatStreamDelay();
    }
  }
}

export async function applyAppBuilderDraft(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const body = (await c.req.json()) as {
      prompt?: string;
      draft?: AppBuilderDraftContract;
      source?: AppDraftSource;
      files?: GeneratedFile[];
      runBuild?: boolean;
      runSmoke?: boolean;
      targetStatus?: GeneratedAppStatus;
    };
    const draft =
      body.draft ??
      buildAppBuilderDraft(generateAppDraftFromPrompt(promptFromBody(body.prompt)), context);
    const fileTreeFiles =
      body.source === "llm-filetree" ? generatedFilesFromUnknown(body.files) : undefined;
    const runSmoke = Boolean(body.runSmoke || body.runBuild);
    const smokeBuild = await runAppSmokeViaSandbox(draft, context, runSmoke);
    const previewUrl =
      smokeBuild.status === "pass"
        ? previewUrlForDraft(draft, context, stableGeneratedAppId(draft, context))
        : undefined;
    const record = await persistGeneratedAppDraft(context, draft, {
      status: body.targetStatus ?? (runSmoke ? "built" : "saved"),
      previewUrl,
      smokeStatus: smokeBuild.status,
      buildStatus: runSmoke ? "passed" : "not_run",
      codegenSource: fileTreeFiles ? "llm-filetree" : body.source,
      fileTreeFiles,
    });
    const checkpoint = checkpointForPublish(record, record.checkpointId);
    if (!checkpoint || !record.runtimeArtifact)
      throw httpRouteError(500, "generated app runtime artifact missing");
    const workspace = await writeGeneratedAppWorkspace(
      context,
      record,
      checkpoint,
      record.runtimeArtifact,
    );

    return c.json(
      {
        draft: {
          ...draft,
          smokeBuildStatus: smokeBuild,
        },
        draftSource: fileTreeFiles ? "llm-filetree" : body.source,
        fileTree: fileTreeFiles,
        created: true,
        applied: true,
        app: {
          id: record.id,
          slug: record.slug,
          name: record.name,
          status: record.status,
          previewUrl: record.previewUrl,
          createdAt: record.createdAt,
        },
        checkpoint: {
          id: record.checkpointId,
          appId: record.id,
          savedAt: record.updatedAt,
        },
        artifact: {
          entrypoint: record.runtimeArtifact?.entrypoint,
          renderedAt: record.runtimeArtifact?.renderedAt,
          files: summarizeGeneratedAppSourceFiles(record.sourceFiles ?? []),
        },
        sourceFiles: summarizeGeneratedAppSourceFiles(record.sourceFiles ?? []),
        workspace,
        build: {
          status: record.buildStatus ?? "not_run",
          checks: smokeBuild.checks,
        },
        smoke: smokeBuild,
        previewUrl: record.previewUrl,
        smokeBuild,
      },
      201,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
}

export function stableGeneratedAppId(
  draft: AppBuilderDraftContract,
  context: AuthenticatedRouteContext,
) {
  return `gapp_${stableHash(`${context.workspace.id}:${draft.app.slug || stableAppId(draft.app.name)}`)}`;
}

export function routeHandlerName(method: "GET" | "POST" | "PATCH" | "DELETE", path: string) {
  const words = `${method.toLowerCase()} ${path}`
    .replace(/[:{}]/g, " ")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return (
    words
      .map((word, index) =>
        index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join("") || "handleGeneratedRoute"
  );
}

export function appRouteMethod(value: string): "GET" | "POST" | "PATCH" | "DELETE" {
  return value === "POST" || value === "PATCH" || value === "DELETE" ? value : "GET";
}

export function appRouteAccess(value: unknown): "public" | "private" | "admin" {
  return value === "public" || value === "admin" ? value : "private";
}

export function appFieldType(
  value: unknown,
): "string" | "number" | "boolean" | "date" | "enum" | "json" | "relation" {
  if (
    value === "number" ||
    value === "boolean" ||
    value === "date" ||
    value === "enum" ||
    value === "json" ||
    value === "relation"
  )
    return value;
  return "string";
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function titleFromPath(path: string) {
  const segment = path.split("/").filter(Boolean).at(-1) ?? "page";
  return segment
    .split(/[-_]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function appendUniqueSentence(value: string, sentence: string) {
  return value.includes(sentence) ? value : `${value} ${sentence}`.trim();
}

export function buildAppBuilderDraft(draft: AppDraft, context: AuthenticatedRouteContext) {
  const smokeBuildStatus = buildAppSmokeStatus(draft, context, false);

  return {
    prompt: draft.prompt,
    intent: draft.templateId,
    summary: draft.summary,
    app: {
      slug: stableAppId(draft.appName),
      name: draft.appName,
      description: draft.summary,
      pages: draft.pageMap.map((page) => ({
        name: page.name,
        route: page.path,
        access: page.access,
        purpose: page.purpose,
        actions: page.actions,
        components: componentsForPage(draft, page),
      })),
      dataSchema: draft.dataSchema.entities.map((entity) => ({
        name: entity.name,
        fields: entity.fields.map(mapDataField),
        relationships: [
          ...entity.relations,
          ...entity.indexes.map((index) => `Indexed by ${index}`),
        ],
      })),
      apiRoutes: draft.apiRouteStubs.map(mapApiRoute),
      crudFlows: draft.crudFlows.map((flow) => ({
        entity: flow.entity,
        create: flow.create.join(" "),
        read: flow.read.join(" "),
        update: flow.update.join(" "),
        delete: flow.delete.join(" "),
        validation: validationForCrudFlow(draft, flow),
      })),
      authDecisions: [
        ...draft.auth.publicRoutes.map((route) => ({
          area: route,
          decision: "Public",
          rationale: "This route is explicitly listed as public in the generated access map.",
        })),
        ...draft.auth.privateRoutes.map((route) => ({
          area: route,
          decision: "Authenticated",
          rationale: "The app defaults to authenticated access outside public entry points.",
        })),
        ...draft.auth.roleRoutes.map((route) => ({
          area: route.routes.join(", "),
          decision: `${route.role} role`,
          rationale: route.reason,
        })),
        ...draft.auth.decisions.map((decision) => ({
          area: "Global policy",
          decision: draft.auth.defaultPolicy,
          rationale: decision,
        })),
      ],
    },
    plan: {
      title: `${draft.appName} build plan`,
      steps: [
        planStep(
          "Generate pages",
          `Create ${draft.pageMap.length} routed screens and shared navigation from the page map.`,
        ),
        planStep(
          "Create data layer",
          `Provision ${draft.dataSchema.database} tables for ${draft.dataSchema.entities.map((entry) => entry.name).join(", ")}.`,
        ),
        planStep(
          "Review API contracts",
          `Review ${draft.apiRouteStubs.length} generated route contracts with validation and auth expectations before runtime execution.`,
        ),
        planStep(
          "Run smoke build",
          "Render the generated preview and run page plus API contract smoke checks.",
        ),
      ],
      acceptanceChecks: draft.acceptanceChecks,
      openQuestions: [],
    },
    smokeBuildStatus,
  };
}

export async function persistGeneratedAppDraft(
  context: AuthenticatedRouteContext,
  draft: AppBuilderDraftContract,
  input: {
    status: GeneratedAppStatus;
    previewUrl?: string;
    buildStatus: string;
    smokeStatus: string;
    checkpointLabel?: string;
    checkpointSource?: GeneratedAppCheckpointRecord["source"];
    codegenSource?: AppDraftSource;
    fileTreeFiles?: GeneratedFile[];
  },
) {
  const timestamp = new Date().toISOString();
  const slug = draft.app.slug || stableAppId(draft.app.name);
  const checkpointId = `gapp_ckpt_${stableHash(`${context.workspace.id}:${slug}:${timestamp}`)}`;
  const draftRecord = draft as unknown as Record<string, unknown>;

  const record = await mutateStoreAsync((data) => {
    data.generatedApps ??= [];
    const existing = data.generatedApps.find(
      (entry) => entry.workspaceId === context.workspace.id && entry.slug === slug,
    );
    const previousCheckpointId = existing?.checkpointId;
    const appId = existing?.id ?? stableGeneratedAppId(draft, context);
    const runtimeArtifact = input.fileTreeFiles?.length
      ? buildGeneratedAppRuntimeArtifactFromFiles(input.fileTreeFiles, timestamp)
      : buildGeneratedAppRuntimeArtifact({
          appId,
          workspaceId: context.workspace.id,
          checkpointId,
          draft,
          renderedAt: timestamp,
        });
    const checkpoint = {
      id: checkpointId,
      appId,
      workspaceId: context.workspace.id,
      label: input.checkpointLabel ?? `${draft.app.name} ${input.status}`,
      draft: draftRecord,
      runtimeArtifact,
      sourceFiles: runtimeArtifact.files,
      previewUrl: input.previewUrl,
      buildStatus: input.buildStatus,
      smokeStatus: input.smokeStatus,
      source: input.checkpointSource ?? "initial",
      codegenSource: input.codegenSource,
      previousCheckpointId,
      createdByUserId: context.user.id,
      createdAt: timestamp,
    } satisfies GeneratedAppCheckpointWithRuntime;
    const existingWithRuntime = existing as GeneratedAppRecordWithRuntime | undefined;
    const record: GeneratedAppRecordWithRuntime = {
      id: checkpoint.appId,
      workspaceId: context.workspace.id,
      slug,
      name: draft.app.name,
      description: draft.app.description,
      prompt: draft.prompt,
      templateId: draft.intent,
      status: input.status,
      draft: draftRecord,
      checkpointId,
      runtimeArtifact,
      sourceFiles: runtimeArtifact.files,
      codegenSource: input.codegenSource,
      previewUrl: input.previewUrl,
      buildStatus: input.buildStatus,
      smokeStatus: input.smokeStatus,
      checkpoints: [...(existingWithRuntime?.checkpoints ?? []), checkpoint],
      previewSnapshots: existingWithRuntime?.previewSnapshots ?? [],
      createdByUserId: existingWithRuntime?.createdByUserId ?? context.user.id,
      createdAt: existingWithRuntime?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    if (existing) Object.assign(existing, record);
    else data.generatedApps.unshift(record);

    recordActivity(data, {
      id: `activity_generated_app_${record.id}_${stableHash(checkpointId)}`,
      workspaceId: context.workspace.id,
      scope: "workspace",
      event: "builder.generated_app.applied",
      actor: { type: "user", id: context.user.id },
      data: {
        title: `${record.name} applied from builder`,
        appId: record.id,
        slug: record.slug,
        status: record.status,
        checkpointId,
        previewUrl: record.previewUrl,
      },
      occurredAt: timestamp,
    });

    return record;
  });
  return record;
}

export async function writeGeneratedAppWorkspace(
  context: AuthenticatedRouteContext,
  record: Pick<GeneratedAppRecordWithRuntime, "id" | "slug" | "name">,
  checkpoint: Pick<GeneratedAppCheckpointWithRuntime, "id" | "label" | "createdAt">,
  artifact: GeneratedAppRuntimeArtifactRecord,
): Promise<GeneratedAppWorkspaceSummary> {
  const result = await writeGeneratedAppRuntimeWorkspace({
    workspaceSlug: context.workspace.slug || context.workspace.id,
    appSlug: record.slug || record.id,
    appId: record.id,
    workspaceId: context.workspace.id,
    checkpointId: checkpoint.id,
    checkpointLabel: checkpoint.label,
    checkpointCreatedAt: checkpoint.createdAt,
    artifact,
    generatedAppsRoot: process.env.PACKETAGENT_GENERATED_APP_WORKSPACES_DIR,
  });

  return generatedAppWorkspaceSummary(context, record, artifact, result);
}

function generatedAppWorkspaceSummary(
  context: AuthenticatedRouteContext,
  record: Pick<GeneratedAppRecordWithRuntime, "id" | "slug" | "name">,
  artifact: GeneratedAppRuntimeArtifactRecord,
  result: Awaited<ReturnType<typeof writeGeneratedAppRuntimeWorkspace>>,
): GeneratedAppWorkspaceSummary {
  return {
    id: context.workspace.id,
    slug: context.workspace.slug,
    path: result.paths.workspacePath,
    appPath: dirname(result.paths.workspacePath),
    checkpointPath: result.paths.workspacePath,
    manifest: {
      path: result.paths.manifestPath,
      version: result.manifest.version,
      fileCount: result.manifest.files.length,
      totalBytes: result.manifest.files.reduce((total, file) => total + file.size, 0),
      entrypoint: artifact.entrypoint,
      renderedAt: artifact.renderedAt,
      checkpointId: result.manifest.checkpoint.id,
    },
  };
}

export function promptFromBody(prompt: string | undefined) {
  const trimmed = String(prompt ?? "").trim();
  if (trimmed.length < 8) throw httpRouteError(400, "prompt must be at least 8 characters");
  if (trimmed.length > 2_000) throw httpRouteError(400, "prompt must be 2000 characters or fewer");
  return trimmed;
}

function planStep(title: string, detail: string) {
  return { title, detail, status: "todo" as const };
}

function componentsForPage(draft: AppDraft, page: PageDraft) {
  const used = draft.components
    .filter((component) => component.usedOn.includes(page.path))
    .map((component) => component.name);
  return used.length > 0 ? used : ["PageShell"];
}

function mapDataField(field: FieldSchemaDraft) {
  const notes = [
    field.enumValues?.length ? `Allowed values: ${field.enumValues.join(", ")}` : "",
    field.references ? `References ${field.references}` : "",
  ]
    .filter(Boolean)
    .join(". ");

  return {
    name: field.name,
    type: mapFieldType(field),
    required: field.required,
    notes: notes || undefined,
  };
}

function mapFieldType(field: FieldSchemaDraft) {
  if (field.references) return "relation";
  if (
    field.type === "number" ||
    field.type === "boolean" ||
    field.type === "date" ||
    field.type === "enum"
  )
    return field.type;
  if (field.type === "datetime") return "date";
  return "string";
}

function mapApiRoute(route: ApiRouteStub) {
  return {
    method: route.method,
    path: route.path,
    access: route.access,
    purpose: route.purpose,
    handler: handlerName(route),
    authRequired: route.access !== "public",
    requiredRole: route.access === "admin" ? ("admin" as const) : undefined,
  };
}

function handlerName(route: ApiRouteStub) {
  const words = `${route.method.toLowerCase()} ${route.path}`
    .replace(/[:{}]/g, " ")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return (
    words
      .map((word, index) =>
        index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join("") || "handleGeneratedRoute"
  );
}

function validationForCrudFlow(draft: AppDraft, flow: CrudFlowDraft) {
  const entity = draft.dataSchema.entities.find((entry) => entry.name === flow.entity);
  if (!entity) return draft.acceptanceChecks;
  const required = entity.fields
    .filter((field) => field.required && field.name !== entity.primaryKey)
    .map((field) => field.name);
  return [
    required.length ? `Required fields: ${required.join(", ")}` : "No non-id fields are required.",
    ...entity.relations,
  ];
}
