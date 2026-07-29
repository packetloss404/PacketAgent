import type {
  ApiRouteStub,
  AppDraft,
  AppDraftTemplateId,
  ComponentDraft,
  CrudFlowDraft,
  EntitySchemaDraft,
  PageDraft,
  Phase71IntegrationDraft,
  Phase71IntegrationMetadata,
  RouteAccess,
} from "./types.js";
import {
  PHASE_71_INTEGRATIONS,
  STOP_WORDS,
  TEMPLATE_DEFINITIONS,
  type TemplateDefinition,
} from "./template-data.js";
import {
  buildAuth,
  cloneComponents,
  cloneEntities,
  clonePages,
  cloneSeedData,
  component,
  editableFieldNames,
  requiredFieldNames,
} from "./draft-helpers.js";
import {
  appSlug,
  escapeRegExp,
  humanName,
  humanPlural,
  kebabPlural,
  titleCase,
} from "./text-helpers.js";

export function generateAppDraftFromPrompt(prompt: string): AppDraft {
  const trimmed = (prompt ?? "").trim();
  if (trimmed.length < 8) {
    throw new Error("prompt must be at least 8 characters");
  }

  const template = chooseTemplate(trimmed);
  const appName = buildAppName(trimmed, template);
  const pageMap = clonePages(template.pages);
  const components = cloneComponents(template.components);
  const entities = cloneEntities(template.entities);
  const integrationMetadata = buildPhase71IntegrationMetadata(trimmed);
  const apiRouteStubs = buildApiRoutes(entities, pageMap, appSlug(appName));
  const auth = buildAuth(pageMap);

  return {
    prompt: trimmed,
    templateId: template.id,
    appName,
    summary: buildSummary(appName, trimmed, template),
    integrationMetadata,
    pageMap,
    components: applyIntegrationComponents(components, pageMap, integrationMetadata.requested),
    apiRouteStubs: applyIntegrationApiRoutes(
      apiRouteStubs,
      appSlug(appName),
      integrationMetadata.requested,
    ),
    dataSchema: {
      database: "postgres",
      entities,
      notes: [
        "Use uuid primary keys for generated records.",
        "Keep createdAt and updatedAt server-owned where present.",
        "Scope tenant/customer-owned rows before returning private data.",
        ...integrationMetadata.setupGuidance,
      ],
    },
    seedData: cloneSeedData(template.seeds),
    crudFlows: buildCrudFlows(entities),
    auth,
    acceptanceChecks: [
      `${appName} uses the ${template.summaryNoun} heuristic selected from the prompt.`,
      ...template.acceptanceChecks,
      ...integrationMetadata.requested.map(
        (integration) =>
          `${integration.label} setup guidance references ${integration.envVars.join(", ")} without blocking unrelated app features.`,
      ),
      "Generated API routes return validation errors for missing required fields.",
      "Generated seed data can render every primary page without empty states.",
    ],
  };
}

export function listAppDraftTemplateIds(): AppDraftTemplateId[] {
  return TEMPLATE_DEFINITIONS.map((entry) => entry.id);
}

export function detectPhase71Integrations(prompt: string): Phase71IntegrationDraft[] {
  const source = String(prompt ?? "");
  return PHASE_71_INTEGRATIONS.filter((integration) =>
    integration.signals.some((signal) => signal.test(source)),
  ).map(({ signals: _signals, ...integration }) => ({
    ...integration,
    envVars: [...integration.envVars],
    flows: [...integration.flows],
    setupGuidance: [...integration.setupGuidance],
  }));
}

function buildPhase71IntegrationMetadata(prompt: string): Phase71IntegrationMetadata {
  const requested = detectPhase71Integrations(prompt);
  return {
    requested,
    setupGuidance: requested.flatMap((integration) => integration.setupGuidance),
  };
}

function applyIntegrationComponents(
  components: ComponentDraft[],
  pages: PageDraft[],
  integrations: Phase71IntegrationDraft[],
): ComponentDraft[] {
  if (integrations.length === 0) return components;
  const targetPage =
    pages.find((entry) => entry.access !== "public")?.path ?? pages[0]?.path ?? "/";
  return [
    ...components,
    component(
      "IntegrationSetupPanel",
      "detail",
      [targetPage],
      integrations.map(
        (integration) =>
          `show ${integration.label} setup state for ${integration.envVars.join(", ")}`,
      ),
    ),
  ];
}

function applyIntegrationApiRoutes(
  routes: ApiRouteStub[],
  slug: string,
  integrations: Phase71IntegrationDraft[],
): ApiRouteStub[] {
  if (integrations.length === 0) return routes;
  const integrationRoutes = integrations.flatMap((integration): ApiRouteStub[] => [
    {
      method: "GET",
      path: `/api/app/generated/${slug}/integrations/${integration.id}/setup`,
      access: "private",
      purpose: `Check ${integration.label} setup state and required env vars: ${integration.envVars.join(", ")}.`,
      responseShape: "{ ready, missingEnvVars, setupGuidance }",
    },
    {
      method: "POST",
      path: `/api/app/generated/${slug}/integrations/${integration.id}/actions`,
      access: "private",
      purpose: `Run draft-safe ${integration.label} flow: ${integration.flows[0]}`,
      requestBody: "action, payload",
      responseShape: "{ queued, setupRequired, message }",
    },
  ]);
  return [...routes, ...integrationRoutes];
}

function chooseTemplate(prompt: string): TemplateDefinition {
  const lower = prompt.toLowerCase();
  let best =
    TEMPLATE_DEFINITIONS.find((entry) => entry.id === "task_tracker") ?? TEMPLATE_DEFINITIONS[0];
  let bestScore = 0;

  for (const template of TEMPLATE_DEFINITIONS) {
    const score = template.keywords.reduce((total, keyword) => {
      const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "gi");
      return total + Array.from(lower.matchAll(pattern)).length;
    }, 0);
    if (score > bestScore) {
      best = template;
      bestScore = score;
    }
  }

  return best;
}

function buildAppName(prompt: string, template: TemplateDefinition): string {
  const suffixTokens = new Set(template.nameSuffix.toLowerCase().split(/\s+/).filter(Boolean));
  const domainWords = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2)
    .filter((word) => !STOP_WORDS.has(word))
    .filter((word) => !template.keywords.includes(word))
    .filter((word) => !suffixTokens.has(word))
    .slice(0, 2);

  const prefix = domainWords.length > 0 ? titleCase(domainWords.join(" ")) : "Workspace";
  return `${prefix} ${template.nameSuffix}`;
}

function buildSummary(appName: string, prompt: string, template: TemplateDefinition): string {
  const source = prompt.replace(/\s+/g, " ");
  const clipped = source.length > 140 ? `${source.slice(0, 137).trim()}...` : source;
  return `${appName} is a deterministic ${template.summaryNoun} draft for: ${clipped}`;
}

function buildApiRoutes(
  entities: EntitySchemaDraft[],
  pages: PageDraft[],
  slug: string,
): ApiRouteStub[] {
  const adminEntities = new Set(
    pages
      .filter((entry) => entry.access === "admin" && entry.primaryEntity)
      .map((entry) => entry.primaryEntity),
  );
  const routes: ApiRouteStub[] = [];

  for (const entityDraft of entities) {
    const access: RouteAccess = adminEntities.has(entityDraft.name) ? "admin" : "private";
    const collectionPath = `/api/app/generated/${slug}/${kebabPlural(entityDraft.name)}`;
    routes.push({
      method: "GET",
      path: collectionPath,
      access,
      purpose: `List ${humanPlural(entityDraft.name)} with filters and pagination.`,
      responseShape: `${entityDraft.name}[]`,
    });
    routes.push({
      method: "POST",
      path: collectionPath,
      access,
      purpose: `Create a ${humanName(entityDraft.name)} after validating required fields.`,
      requestBody: requiredFieldNames(entityDraft).join(", "),
      responseShape: entityDraft.name,
    });
    routes.push({
      method: "GET",
      path: `${collectionPath}/:id`,
      access,
      purpose: `Fetch one ${humanName(entityDraft.name)} by id.`,
      responseShape: entityDraft.name,
    });
    routes.push({
      method: "PATCH",
      path: `${collectionPath}/:id`,
      access,
      purpose: `Update editable ${humanName(entityDraft.name)} fields.`,
      requestBody: editableFieldNames(entityDraft).join(", "),
      responseShape: entityDraft.name,
    });
    routes.push({
      method: "DELETE",
      path: `${collectionPath}/:id`,
      access,
      purpose: `Archive or delete a ${humanName(entityDraft.name)}.`,
      responseShape: "{ ok: true }",
    });
  }

  routes.unshift({
    method: "POST",
    path: `/api/public/generated/${slug}/auth/session`,
    access: "public",
    purpose: "Create an authenticated session for private app areas.",
    requestBody: "email, password",
    responseShape: "{ user, workspace, token }",
  });

  return routes;
}

function buildCrudFlows(entities: EntitySchemaDraft[]): CrudFlowDraft[] {
  return entities.map((entityDraft) => {
    const label = humanName(entityDraft.name);
    return {
      entity: entityDraft.name,
      create: [
        `Open the ${label} form from the relevant page action.`,
        `Validate required fields: ${requiredFieldNames(entityDraft).join(", ")}.`,
        `POST the payload and insert the returned ${label} into the current list.`,
      ],
      read: [
        `GET the ${label} collection for list views.`,
        `GET one ${label} by id for detail or edit views.`,
      ],
      update: [
        `PATCH changed editable fields: ${editableFieldNames(entityDraft).join(", ")}.`,
        "Refresh dependent list, detail, and summary components.",
      ],
      delete: [
        `Confirm destructive intent for the selected ${label}.`,
        `DELETE the ${label} by id, then remove it from visible lists.`,
      ],
    };
  });
}
