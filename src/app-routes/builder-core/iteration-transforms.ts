import {
  AppBuilderDraftContract,
  AppBuilderIterationDiffStatus,
  AppBuilderIterationTarget,
  AppDraftSource,
  AppIterationDiffFile,
  AppIterationRouteRequest,
  AppIterationRouteResult,
} from "./contracts.js";
import {
  appendUniqueSentence,
  appFieldType,
  appRouteAccess,
  appRouteMethod,
  routeHandlerName,
  stableGeneratedAppId,
  stringList,
  titleFromPath,
} from "./draft.js";
import { buildAppPreviewSnapshotMetadata } from "../../app-preview-snapshots.js";
import { derivePreviewRefreshState } from "../../app-preview-iteration.js";
import { inspectAppIterationTools } from "../../app-iteration-tools.js";
import { smokeStatusFromChecks } from "./smoke.js";
import {
  type AppIterationDiffHunk,
  type AppIterationFileReview,
  type AppIterationFileTreeTarget,
  type AppIterationLLMResult,
  type AppIterationPlan,
  type AppIterationTargetInput,
  type GeneratedAppDraftLike,
} from "../../app-iteration-service.js";
import { type AuthenticatedRouteContext, stableHash } from "../shared.js";
import {
  type GeneratedAppRuntimeArtifactRecord,
  type GeneratedAppSourceFileRecord,
  summarizeGeneratedAppSourceFiles,
} from "../../generated-app-runtime.js";
import { type GeneratedFile } from "../../codegen/llm-author.js";

export function appIterationResponse(input: {
  context: AuthenticatedRouteContext;
  body: AppIterationRouteRequest;
  draft: AppBuilderDraftContract;
  plan: AppIterationPlan;
  status: AppBuilderIterationDiffStatus;
  previewUrl?: string;
  smoke: ReturnType<typeof smokeStatusFromChecks>;
  logs: AppIterationRouteResult["logs"];
  snapshot: ReturnType<typeof buildAppPreviewSnapshotMetadata>;
  tools: ReturnType<typeof inspectAppIterationTools>;
  sourceDiffFiles?: AppIterationDiffFile[];
  fileReview?: AppIterationFileReview[];
  sourceFiles?: GeneratedAppSourceFileRecord[];
  artifact?: GeneratedAppRuntimeArtifactRecord;
  llmResult?: AppIterationLLMResult | null;
  validationErrors?: string[];
  fileTree?: GeneratedFile[];
  draftSource?: AppDraftSource;
}): AppIterationRouteResult & {
  rollback: AppIterationPlan["rollbackCheckpoint"];
  snapshot: unknown;
  tools: unknown;
} {
  const preview = derivePreviewRefreshState({
    appId: input.body.appId ?? stableGeneratedAppId(input.draft, input.context),
    workspaceId: input.context.workspace.id,
    previewUrl: input.previewUrl,
    previewPath: input.previewUrl,
    build: {
      phase: "queued",
      checkCount: input.smoke.checks.length,
      passedChecks: 0,
      buildId: input.snapshot.build.id,
      revision: input.plan.rollbackCheckpoint.checkpointId,
    },
    lastRendered: input.previewUrl
      ? {
          previewUrl: input.previewUrl,
          revision: input.body.checkpointId,
        }
      : undefined,
    refreshRequest: {
      requestId: `preview-refresh:${input.plan.rollbackCheckpoint.checkpointId}`,
      buildId: input.snapshot.build.id,
      revision: input.plan.rollbackCheckpoint.checkpointId,
      requestedAt: new Date().toISOString(),
    },
  });

  const llmFiles: AppIterationDiffFile[] = (input.llmResult?.files ?? []).map((file) => ({
    path: file.path,
    changeType: file.changeType,
    summary: file.summary,
    diff: file.diff,
  }));
  const baseSummary =
    input.plan.diffHunks.map((hunk) => hunk.summary).join(" ") ||
    "No generated app changes available for this prompt.";
  return {
    id: `change_${stableHash(`${input.plan.rollbackCheckpoint.checkpointId}:${input.plan.request.requestedChange}`)}`,
    appId: input.body.appId,
    checkpointId: input.body.checkpointId,
    target: input.body.target ?? routeTargetFromPlan(input.plan),
    prompt: input.body.prompt ?? input.plan.request.requestedChange,
    summary: input.llmResult?.changedSummary || baseSummary,
    status: input.status,
    files: mergeIterationDiffFiles(
      mergeIterationDiffFiles(input.plan.diffHunks.map(diffFileFromHunk), llmFiles),
      input.sourceDiffFiles ?? [],
    ),
    fileReview: input.fileReview,
    sourceDiffFiles: input.sourceDiffFiles ?? [],
    sourceFiles: summarizeGeneratedAppSourceFiles(input.sourceFiles ?? []),
    fileTree: input.fileTree,
    draftSource: input.draftSource,
    validationErrors: input.validationErrors,
    artifact: {
      entrypoint: input.artifact?.entrypoint,
      renderedAt: input.artifact?.renderedAt,
      files: summarizeGeneratedAppSourceFiles(input.artifact?.files ?? []),
    },
    draft: input.draft,
    preview: {
      url: input.previewUrl,
      status: input.status === "blocked" ? "warn" : "pending",
      message: preview.reason,
    },
    logs: input.logs,
    smoke: input.smoke,
    errorFix: input.smoke.blockers[0]
      ? {
          source: "smoke",
          message: input.smoke.blockers[0],
          prompt: `Fix this generated app smoke failure for ${input.plan.request.target.label}: ${input.smoke.blockers[0]}`,
        }
      : undefined,
    rollback: input.plan.rollbackCheckpoint,
    snapshot: input.snapshot,
    tools: input.tools,
  };
}

export function appIterationTargetForService(
  target: AppBuilderIterationTarget | undefined,
): AppIterationTargetInput {
  if (!target) return { kind: "page" };
  const kind =
    target.kind === "api_route"
      ? "api"
      : target.kind === "data_entity"
        ? "data"
        : target.kind === "component"
          ? "page"
          : target.kind === "app" ||
              target.kind === "smoke" ||
              target.kind === "file" ||
              target.kind === "agent" ||
              target.kind === "tool"
            ? "config"
            : target.kind;
  return {
    kind: kind as AppIterationTargetInput["kind"],
    key: target.id,
    path: target.path,
    name: target.label,
  };
}

export function appIterationFileTreeTarget(
  target: AppBuilderIterationTarget | undefined,
): AppIterationFileTreeTarget {
  if (!target) return { kind: "app" };
  const kind =
    target.kind === "api_route"
      ? "api"
      : target.kind === "data_entity"
        ? "data"
        : target.kind === "component"
          ? "component"
          : target.kind === "page" || target.kind === "auth" || target.kind === "config"
            ? target.kind
            : target.kind === "app"
              ? "app"
              : "config";
  return {
    kind,
    key: target.id,
    path: target.path,
    name: target.label,
    selector: target.selector,
  };
}

function routeTargetFromPlan(plan: AppIterationPlan): AppBuilderIterationTarget {
  const target = plan.request.target;
  return {
    id: target.key,
    kind:
      target.kind === "api" ? "api_route" : target.kind === "data" ? "data_entity" : target.kind,
    label: target.label,
    path: target.path,
  };
}

export function toGeneratedAppDraftLike(draft: AppBuilderDraftContract): GeneratedAppDraftLike {
  return {
    appName: draft.app.name,
    pageMap: draft.app.pages.map((page) => ({
      path: page.route,
      name: page.name,
      access: page.access,
      purpose: page.purpose,
      actions: page.actions,
      components: page.components,
    })),
    apiRouteStubs: draft.app.apiRoutes.map((route) => ({
      method: route.method,
      path: route.path,
      access: route.access,
      purpose: route.purpose,
      handler: route.handler,
      authRequired: route.authRequired,
    })),
    dataSchema: {
      database: "generated",
      entities: draft.app.dataSchema.map((entity) => ({
        name: entity.name,
        fields: entity.fields.map((field) => ({
          name: field.name,
          type: field.type,
          required: field.required,
        })),
        relations: entity.relationships,
      })),
      notes: draft.plan.acceptanceChecks,
    },
    auth: {
      defaultPolicy: "authenticated-by-default",
      publicRoutes: draft.app.pages
        .filter((page) => page.access === "public")
        .map((page) => page.route),
      privateRoutes: draft.app.pages
        .filter((page) => page.access === "private")
        .map((page) => page.route),
      roleRoutes: draft.app.pages
        .filter((page) => page.access === "admin")
        .map((page) => ({
          role: "admin",
          routes: [page.route],
          reason: `Admin access for ${page.name}`,
        })),
      decisions: draft.app.authDecisions.map(
        (decision) => `${decision.area}: ${decision.decision}. ${decision.rationale}`,
      ),
    },
    acceptanceChecks: draft.plan.acceptanceChecks,
    config: {
      notes: [draft.summary],
    },
  };
}

export function fromGeneratedAppDraftLike(
  base: AppBuilderDraftContract,
  generated: GeneratedAppDraftLike,
): AppBuilderDraftContract {
  const pages = (generated.pageMap ?? []).map((page) => ({
    name: page.name ?? titleFromPath(page.path),
    route: page.path,
    access: appRouteAccess(page.access),
    purpose: String(page.purpose ?? `Generated page for ${page.path}`),
    actions: stringList(page.actions),
    components:
      stringList(page.components).length > 0
        ? stringList(page.components)
        : (base.app.pages.find((entry) => entry.route === page.path)?.components ?? ["PageShell"]),
  }));
  const dataSchema = (generated.dataSchema?.entities ?? []).map((entity) => ({
    name: entity.name,
    fields: (entity.fields ?? []).map((field) => ({
      name: field.name,
      type: appFieldType(field.type),
      required: Boolean(field.required),
      notes: field.references ? `References ${field.references}` : undefined,
    })),
    relationships: [
      ...stringList(entity.relations),
      ...stringList(entity.indexes).map((index) => `Indexed by ${index}`),
    ],
  }));
  const apiRoutes = (generated.apiRouteStubs ?? []).map((route) => ({
    method: appRouteMethod(route.method),
    path: route.path,
    access: appRouteAccess(route.access),
    purpose: String(route.purpose ?? `Generated route for ${route.path}`),
    handler:
      typeof route.handler === "string"
        ? route.handler
        : routeHandlerName(appRouteMethod(route.method), route.path),
    authRequired: route.access !== "public",
    requiredRole: appRouteAccess(route.access) === "admin" ? ("admin" as const) : undefined,
  }));
  const nextDraft = {
    ...base,
    summary: appendUniqueSentence(
      base.summary,
      `Latest iteration: ${generated.config?.notes?.at(-1) ?? base.summary}`,
    ),
    app: {
      ...base.app,
      pages,
      dataSchema,
      apiRoutes,
      crudFlows: base.app.crudFlows.filter((flow) =>
        dataSchema.some((entity) => entity.name === flow.entity),
      ),
      authDecisions: authDecisionsFromGenerated(generated, pages),
    },
    smokeBuildStatus: {
      ...base.smokeBuildStatus,
      status: "pending" as const,
      message: "Smoke checks are ready to run after applying the generated iteration.",
    },
  };
  return nextDraft;
}

function authDecisionsFromGenerated(
  generated: GeneratedAppDraftLike,
  pages: AppBuilderDraftContract["app"]["pages"],
) {
  const auth = generated.auth;
  if (!auth) {
    return pages.map((page) => ({
      area: page.route,
      decision:
        page.access === "public"
          ? "Public"
          : page.access === "admin"
            ? "admin role"
            : "Authenticated",
      rationale: "Derived from generated route access.",
    }));
  }
  return [
    ...(auth.publicRoutes ?? []).map((route) => ({
      area: route,
      decision: "Public",
      rationale: "Iteration marked this route public.",
    })),
    ...(auth.privateRoutes ?? []).map((route) => ({
      area: route,
      decision: "Authenticated",
      rationale: "Iteration marked this route authenticated.",
    })),
    ...(auth.roleRoutes ?? []).map((route) => ({
      area: route.routes.join(", "),
      decision: `${route.role} role`,
      rationale: route.reason ?? "Iteration requires a role gate.",
    })),
    ...(auth.decisions ?? []).map((decision) => ({
      area: "Global policy",
      decision: auth.defaultPolicy ?? "authenticated-by-default",
      rationale: decision,
    })),
  ];
}

function diffFileFromHunk(hunk: AppIterationDiffHunk): AppIterationRouteResult["files"][number] {
  return {
    path: diffFilePath(hunk),
    changeType: hunk.action === "add" ? "added" : hunk.action === "remove" ? "deleted" : "modified",
    summary: hunk.summary,
    diff: [
      `@@ ${hunk.target.label}`,
      ...hunk.before.split("\n").map((line) => `- ${line}`),
      ...hunk.after.split("\n").map((line) => `+ ${line}`),
    ].join("\n"),
    source: "draft",
  };
}

export function diffGeneratedAppSourceFiles(
  previous: GeneratedAppRuntimeArtifactRecord,
  next: GeneratedAppRuntimeArtifactRecord,
): AppIterationDiffFile[] {
  const previousFiles = new Map(
    previous.files.map((file) => [normalizeGeneratedSourcePath(file.path), file]),
  );
  const nextFiles = new Map(
    next.files.map((file) => [normalizeGeneratedSourcePath(file.path), file]),
  );
  const paths = sortedUniqueStrings([...previousFiles.keys(), ...nextFiles.keys()]);

  return paths.flatMap((path) => {
    const before = previousFiles.get(path);
    const after = nextFiles.get(path);
    if (before?.sha256 && after?.sha256 && before.sha256 === after.sha256) return [];
    const changeType = before && after ? "modified" : before ? "deleted" : "added";
    const role = after?.role ?? before?.role;
    return [
      {
        path: after?.path ?? before?.path ?? path,
        changeType,
        summary: sourceDiffSummary(changeType, after?.path ?? before?.path ?? path, before, after),
        diff: renderSourceFileDiff(before, after),
        source: "runtime" as const,
        beforeSha256: before?.sha256,
        afterSha256: after?.sha256,
        beforeSize: before?.size,
        afterSize: after?.size,
        role,
      },
    ];
  });
}

export function mergeIterationDiffFiles(
  draftFiles: AppIterationDiffFile[],
  sourceFiles: AppIterationDiffFile[],
): AppIterationDiffFile[] {
  const runtimePaths = new Set(
    sourceFiles.map((file) => `runtime:${normalizeGeneratedSourcePath(file.path)}`),
  );
  return [
    ...draftFiles.filter(
      (file) =>
        file.source !== "runtime" ||
        !runtimePaths.has(`runtime:${normalizeGeneratedSourcePath(file.path)}`),
    ),
    ...sourceFiles,
  ];
}

function sourceDiffSummary(
  changeType: AppIterationDiffFile["changeType"],
  path: string,
  before: GeneratedAppSourceFileRecord | undefined,
  after: GeneratedAppSourceFileRecord | undefined,
) {
  const checksum =
    before && after ? ` (${before.sha256.slice(0, 8)} -> ${after.sha256.slice(0, 8)})` : "";
  const size = before && after ? `, ${before.size} -> ${after.size} bytes` : "";
  return `${changeType[0].toUpperCase()}${changeType.slice(1)} generated source file ${path}${checksum}${size}.`;
}

function renderSourceFileDiff(
  before: GeneratedAppSourceFileRecord | undefined,
  after: GeneratedAppSourceFileRecord | undefined,
) {
  const beforeLines = before?.content.split(/\r?\n/) ?? [];
  const afterLines = after?.content.split(/\r?\n/) ?? [];
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines = [
    `--- ${before?.path ?? "/dev/null"}${before?.sha256 ? ` sha256:${before.sha256}` : ""}`,
    `+++ ${after?.path ?? "/dev/null"}${after?.sha256 ? ` sha256:${after.sha256}` : ""}`,
    "@@ source artifact @@",
  ];

  for (let index = 0; index < max; index += 1) {
    const left = beforeLines[index];
    const right = afterLines[index];
    if (left === right) {
      if (left !== undefined && shouldKeepSourceContext(index, beforeLines, afterLines))
        lines.push(`  ${left}`);
      continue;
    }
    if (left !== undefined) lines.push(`- ${left}`);
    if (right !== undefined) lines.push(`+ ${right}`);
  }

  return lines.join("\n");
}

function shouldKeepSourceContext(index: number, beforeLines: string[], afterLines: string[]) {
  return (
    beforeLines[index - 1] !== afterLines[index - 1] ||
    beforeLines[index + 1] !== afterLines[index + 1]
  );
}

function normalizeGeneratedSourcePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function sortedUniqueStrings(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function diffFilePath(hunk: Pick<AppIterationDiffHunk, "target" | "action">) {
  const suffix =
    hunk.target.kind === "api"
      ? `${hunk.target.path ?? hunk.target.key}.ts`
      : hunk.target.kind === "page"
        ? `${hunk.target.path ?? hunk.target.key}.tsx`
        : `${hunk.target.key}.json`;
  return `generated/${hunk.target.kind}/${suffix.replace(/^\/+/, "")}`;
}

export function routeLog(level: "info" | "warn" | "error", message: string) {
  return { at: new Date().toISOString(), level, message };
}
