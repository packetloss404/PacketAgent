import { AppBuilderDraftContract } from "./contracts.js";
import { buildGeneratedAppRuntimeArtifact } from "../../generated-app-runtime.js";
import { type ApiRouteStub, type AppDraft, type PageDraft } from "../../app-builder-service.js";
import {
  type AppSmokeCheck,
  buildAppPreviewReadiness,
  type GeneratedAppApiRoute,
  type GeneratedAppCrudFlow,
  type GeneratedAppPageMapEntry,
} from "../../app-preview-readiness.js";
import { type AuthenticatedRouteContext, stableAppId } from "../shared.js";
import { validateFileTree, type ValidationResult } from "../../codegen/validate.js";

export type AppBuilderCheckStatus = "pending" | "pass" | "warn" | "fail";

type GeneratedAppFileTreeValidator = typeof validateFileTree;

let generatedAppFileTreeValidator: GeneratedAppFileTreeValidator = validateFileTree;

export function setGeneratedAppFileTreeValidatorForTests(
  validator?: GeneratedAppFileTreeValidator,
): void {
  generatedAppFileTreeValidator = validator ?? validateFileTree;
}

export function buildAppSmokeStatus(
  draft: AppDraft,
  context: AuthenticatedRouteContext,
  runSmoke: boolean,
) {
  const readiness = buildAppPreviewReadiness({
    appId: stableAppId(draft.appName),
    workspaceId: context.workspace.id,
    preferredPath: draft.pageMap[0]?.path,
    pageMap: previewPages(draft.pageMap),
    apiRoutes: previewApiRoutes(draft.apiRouteStubs),
    crudFlows: previewCrudFlows(draft),
    build: runSmoke
      ? {
          phase: "passed",
          checkCount: previewSmokeCheckCount(draft),
          passedChecks: previewSmokeCheckCount(draft),
        }
      : {
          phase: "not-started",
          checkCount: previewSmokeCheckCount(draft),
          passedChecks: 0,
          message: "Smoke checks are ready to run after approval.",
        },
  });
  return smokeStatusFromChecks(
    readiness.smokeChecks,
    runSmoke ? "pass" : "pending",
    readiness.buildStatus.summary,
    [],
  );
}

/**
 * Runs required generated-source validation through the isolated Docker
 * validator. No unavailable/disabled path is converted into success.
 */
export async function runAppSmokeViaSandbox(
  draft: AppBuilderDraftContract,
  context: AuthenticatedRouteContext,
  runSmoke: boolean,
  options: { appId?: string; checkpointId?: string } = {},
) {
  const startedAt = new Date();
  const baseline = buildAppSmokeStatusFromDraft(draft, context, runSmoke);
  if (!runSmoke) return withSmokeExecution(baseline, startedAt, "not-run");

  let validation: ValidationResult;
  try {
    const artifact = buildGeneratedAppRuntimeArtifact({
      appId: options.appId ?? draft.app.slug ?? stableAppId(draft.app.name),
      workspaceId: context.workspace.id,
      checkpointId: options.checkpointId ?? "draft-validation",
      draft,
    });
    validation = await generatedAppFileTreeValidator(
      artifact.files.map((file) => ({ path: file.path, content: file.content })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return withSmokeExecution(
      {
        status: "fail" as const,
        message: "Required generated-app sandbox validation could not run.",
        checks: baseline.checks.map((check) => ({
          ...check,
          status: "fail" as const,
          detail: `${check.detail} · validation unavailable`,
        })),
        blockers: [`Required sandbox validation failed closed: ${message}`],
      },
      startedAt,
      "isolated-sandbox",
      "blocked",
    );
  }

  const phaseStatus = (phase: "typecheck" | "build"): AppBuilderCheckStatus => {
    const status = validation.phases[phase];
    return status === "passed" ? "pass" : status === "failed" ? "fail" : "warn";
  };
  const validationStatus: AppBuilderCheckStatus = validation.ok ? "pass" : "fail";
  const phaseChecks = [
    {
      name: "TypeScript typecheck",
      status: phaseStatus("typecheck"),
      detail: `tsc --noEmit via required isolated validator · ${validation.phases.typecheck}`,
    },
    {
      name: "Vite production build",
      status: phaseStatus("build"),
      detail: `vite build via required isolated validator · ${validation.phases.build}`,
    },
  ];
  const contractChecks = baseline.checks.map((check) => ({
    ...check,
    status: validationStatus,
    detail: `${check.detail} · generated contract included in the validated build; live HTTP reachability is a separate check`,
  }));
  const blockers = validation.errors
    .slice(0, 20)
    .map(
      (error) =>
        `${error.phase} ${error.file}${error.line ? `:${error.line}${error.column ? `:${error.column}` : ""}` : ""}: ${error.message}`,
    );

  return withSmokeExecution(
    {
      status: validationStatus,
      message: validation.ok
        ? `TypeScript and Vite passed required isolated sandbox validation in ${validation.durationMs}ms.`
        : validation.source === "blocked"
          ? "Required isolated TypeScript/Vite validation was blocked; no success was recorded."
          : `Generated TypeScript/Vite validation failed with ${validation.errors.length} error(s).`,
      checks: [...phaseChecks, ...contractChecks],
      blockers,
    },
    startedAt,
    "isolated-sandbox",
    validation.source,
  );
}

function withSmokeExecution<T extends ReturnType<typeof smokeStatusFromChecks>>(
  result: T,
  startedAt: Date,
  runner: "isolated-sandbox" | "not-run",
  validatorSource?: string,
) {
  const completedAt = new Date();
  return {
    ...result,
    execution: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      runner,
      ...(validatorSource ? { validatorSource } : {}),
    },
  };
}

export function buildAppSmokeStatusFromDraft(
  draft: AppBuilderDraftContract,
  context: AuthenticatedRouteContext,
  runSmoke: boolean,
) {
  const readiness = buildAppPreviewReadiness({
    appId: stableAppId(draft.app.name),
    workspaceId: context.workspace.id,
    preferredPath: draft.app.pages[0]?.route,
    pageMap: draft.app.pages.map((page) => ({
      key: stableAppId(page.route),
      title: page.name,
      path: page.route,
      visibility: page.access === "public" ? "public" : "private",
      supportsMobilePreview:
        page.access === "public" || page.route === "/" || page.route === "/book",
    })),
    apiRoutes: draft.app.apiRoutes.map((route) => ({
      key: `${route.method} ${route.path}`,
      method: route.method,
      path: route.path,
      authRequired: route.authRequired,
      smoke: true,
    })),
    crudFlows: draft.app.crudFlows.map((flow) => ({
      key: stableAppId(flow.entity),
      resource: flow.entity,
      apiBasePath: apiBasePathForDraftEntity(draft, flow.entity),
      operations: ["list", "create", "read", "update"],
      authRequired: true,
    })),
    build: runSmoke
      ? {
          phase: "passed",
          checkCount: draft.smokeBuildStatus.checks.length,
          passedChecks: draft.smokeBuildStatus.checks.length,
        }
      : {
          phase: "not-started",
          checkCount: draft.smokeBuildStatus.checks.length,
          passedChecks: 0,
          message: "Smoke checks are ready to run after approval.",
        },
  });
  return smokeStatusFromChecks(
    readiness.smokeChecks,
    runSmoke ? "pass" : "pending",
    readiness.buildStatus.summary,
    [],
  );
}

function previewPages(pages: PageDraft[]): GeneratedAppPageMapEntry[] {
  return pages.map((page) => ({
    key: stableAppId(page.path),
    title: page.name,
    path: page.path,
    visibility: page.access === "public" ? "public" : "private",
    supportsMobilePreview: page.access === "public" || page.path === "/" || page.path === "/book",
  }));
}

function previewApiRoutes(routes: ApiRouteStub[]): GeneratedAppApiRoute[] {
  return routes.map((route) => ({
    key: `${route.method} ${route.path}`,
    method: route.method,
    path: route.path,
    authRequired: route.access !== "public",
    smoke: true,
  }));
}

function previewCrudFlows(draft: AppDraft): GeneratedAppCrudFlow[] {
  return draft.crudFlows.map((flow) => ({
    key: stableAppId(flow.entity),
    resource: flow.entity,
    apiBasePath: collectionPathForEntity(draft, flow.entity),
    operations: ["list", "create", "read", "update"],
    authRequired: true,
  }));
}

function previewSmokeCheckCount(draft: AppDraft) {
  return buildAppPreviewReadiness({
    appId: stableAppId(draft.appName),
    workspaceId: "workspace",
    pageMap: previewPages(draft.pageMap),
    apiRoutes: previewApiRoutes(draft.apiRouteStubs),
    crudFlows: previewCrudFlows(draft),
  }).smokeChecks.length;
}

export function smokeStatusFromChecks(
  checks: AppSmokeCheck[],
  status: AppBuilderCheckStatus,
  message: string,
  blockers: string[],
) {
  return {
    status,
    message,
    checks: checks.map((check) => ({
      name: check.label,
      status,
      detail: `${check.method} ${check.path} via ${check.runMode}`,
    })),
    blockers,
  };
}

function collectionPathForEntity(draft: AppDraft, entityName: string) {
  return (
    draft.apiRouteStubs.find(
      (route) => route.method === "GET" && route.path.endsWith(`/${stableAppId(entityName)}s`),
    )?.path ?? `/api/app/generated/${stableAppId(draft.appName)}/${stableAppId(entityName)}s`
  );
}

function apiBasePathForDraftEntity(draft: AppBuilderDraftContract, entity: string) {
  const plural = `${stableAppId(entity)}s`;
  return (
    draft.app.apiRoutes.find((route) => route.method === "GET" && route.path.endsWith(`/${plural}`))
      ?.path ?? `/api/app/generated/${draft.app.slug}/${plural}`
  );
}

export function previewUrlForDraft(
  draft: AppBuilderDraftContract,
  context: AuthenticatedRouteContext,
  appId = draft.app.slug || stableAppId(draft.app.name),
) {
  const readiness = buildAppPreviewReadiness({
    appId,
    workspaceId: context.workspace.id,
    preferredPath: draft.app.pages[0]?.route,
    pageMap: draft.app.pages.map((page) => ({
      key: stableAppId(page.route),
      title: page.name,
      path: page.route,
      visibility: page.access === "public" ? "public" : "private",
      supportsMobilePreview:
        page.access === "public" || page.route === "/" || page.route === "/book",
    })),
    build: { phase: "passed" },
  });
  return readiness.preview.path;
}
