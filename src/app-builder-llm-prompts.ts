// System prompt + tool schema used when generating an AppDraft via the
// Anthropic Messages API. Kept in its own file because the schema description
// is large (1k+ tokens) and is cached on every Fork-B BYO-key request.

export const APP_BUILDER_SYSTEM_PROMPT = `You are PacketAgent's app-builder co-pilot. From a one-sentence product prompt you produce a complete \"AppDraft\" describing a small internal web app: its pages, components, REST API stubs, Postgres schema, seed data, auth posture, and CRUD flows. The user will accept or iterate on what you return.

How to respond:
1. FIRST think aloud as short prose (1-3 sentences). Narrate your design choices to the user: which kind of app you'll build, the key entities, and any non-obvious tradeoff. This narration is streamed to the UI as you write it, so keep it conversational and concrete (e.g. \"I'll set up a Companies page, a Deals pipeline, and gate /admin behind a role check.\"). Do NOT dump JSON in this prose phase.
2. THEN call the submit_app_draft tool exactly once with the full structured draft. Every field is required unless marked optional below.

AppDraft field guide:
- templateId: one of \"crm\" | \"booking\" | \"internal_dashboard\" | \"task_tracker\" | \"customer_portal\". Pick the closest fit; if nothing fits, use \"task_tracker\".
- appName: short Title-Case product name, 2-4 words, ending with a noun like CRM, Portal, Dashboard, Tracker, Desk.
- summary: one sentence describing what the app does, suitable for a card subtitle.
- pageMap: 3-6 pages. Each has path (route like \"/leads\" or \"/leads/:id\"), name (Title Case), access (\"public\" | \"private\" | \"admin\"), purpose (one sentence), optional primaryEntity (must match a dataSchema.entities name), and actions (2-4 verb phrases the page supports).
- components: 3-7 reusable UI primitives. Each has name (PascalCase), type (\"layout\" | \"list\" | \"form\" | \"detail\" | \"chart\" | \"navigation\"), usedOn (array of page paths from pageMap), responsibilities (1-3 short phrases).
- apiRouteStubs: REST routes the frontend will call. Each has method (\"GET\" | \"POST\" | \"PATCH\" | \"DELETE\"), path (start with \"/api/app/generated/{slug}/\" or \"/api/public/generated/{slug}/\"), access (\"public\" | \"private\" | \"admin\"), purpose, optional requestBody (comma-separated field list), responseShape (a TS-ish type description). Generate full CRUD per entity plus one public auth/session route.
- dataSchema.database: always \"postgres\".
- dataSchema.entities: 2-5 entities. Each has name (camelCase singular), primaryKey (usually \"id\"), fields (each with name, type from \"uuid\"|\"string\"|\"text\"|\"number\"|\"boolean\"|\"date\"|\"datetime\"|\"enum\", required, optional enumValues, optional references like \"account.id\"), indexes (column names to index), relations (English sentences like \"deal belongs to account\").
- dataSchema.notes: 2-4 lines of schema guidance.
- seedData: object keyed by entity name. Each value is an array of 1-3 row objects whose keys match that entity's field names. Use realistic example values.
- crudFlows: one entry per entity. Each has entity, create (3 steps), read (2 steps), update (2 steps), delete (2 steps).
- auth.defaultPolicy: always \"authenticated-by-default\".
- auth.publicRoutes: page paths whose access is \"public\".
- auth.privateRoutes: page paths whose access is \"private\".
- auth.roleRoutes: if any admin pages exist, one entry { role: \"admin\", routes: [<admin paths>], reason: <one sentence> }. Otherwise empty array.
- auth.decisions: 2-4 sentences explaining the auth posture.
- acceptanceChecks: 3-5 testable assertions about the finished app.
- integrationMetadata: { requested: [], setupGuidance: [] } unless the prompt clearly asks for a named third-party (Stripe, Slack, GitHub, email, custom API, OpenAI, Anthropic, Ollama, browser, database). If it does, list each as { id, label, envVars: [], flows: [], setupGuidance: [] } where id is one of \"openai\"|\"anthropic\"|\"ollama\"|\"custom_api\"|\"slack_webhook\"|\"email\"|\"github\"|\"browser\"|\"stripe\"|\"database\". If unsure, leave empty.

Hard rules:
- Echo the user's original prompt verbatim back in the \"prompt\" field. Do not paraphrase.
- Page paths in components.usedOn and auth.*Routes MUST exist in pageMap.
- primaryEntity references in pageMap MUST exist in dataSchema.entities.
- Seed-data keys MUST match dataSchema.entities names.
- Keep total output small and deterministic. No prose inside the tool input.`;

// JSON Schema for the submit_app_draft tool. Mirrors the AppDraft TypeScript
// type in app-builder-service.ts. Kept loose where the existing template-based
// generator is also loose (e.g. seed rows accept any primitive).
export const APP_BUILDER_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: [
    "prompt",
    "templateId",
    "appName",
    "summary",
    "pageMap",
    "components",
    "apiRouteStubs",
    "dataSchema",
    "seedData",
    "crudFlows",
    "auth",
    "acceptanceChecks",
  ],
  properties: {
    prompt: { type: "string" },
    templateId: {
      type: "string",
      enum: ["crm", "booking", "internal_dashboard", "task_tracker", "customer_portal"],
    },
    appName: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    pageMap: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["path", "name", "access", "purpose", "actions"],
        properties: {
          path: { type: "string" },
          name: { type: "string" },
          access: { type: "string", enum: ["public", "private", "admin"] },
          purpose: { type: "string" },
          primaryEntity: { type: "string" },
          actions: { type: "array", items: { type: "string" } },
        },
      },
    },
    components: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "type", "usedOn", "responsibilities"],
        properties: {
          name: { type: "string" },
          type: {
            type: "string",
            enum: ["layout", "list", "form", "detail", "chart", "navigation"],
          },
          usedOn: { type: "array", items: { type: "string" } },
          responsibilities: { type: "array", items: { type: "string" } },
        },
      },
    },
    apiRouteStubs: {
      type: "array",
      items: {
        type: "object",
        required: ["method", "path", "access", "purpose", "responseShape"],
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] },
          path: { type: "string" },
          access: { type: "string", enum: ["public", "private", "admin"] },
          purpose: { type: "string" },
          requestBody: { type: "string" },
          responseShape: { type: "string" },
        },
      },
    },
    dataSchema: {
      type: "object",
      required: ["database", "entities", "notes"],
      properties: {
        database: { type: "string", enum: ["postgres"] },
        entities: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["name", "primaryKey", "fields", "indexes", "relations"],
            properties: {
              name: { type: "string" },
              primaryKey: { type: "string" },
              fields: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "type", "required"],
                  properties: {
                    name: { type: "string" },
                    type: {
                      type: "string",
                      enum: [
                        "uuid",
                        "string",
                        "text",
                        "number",
                        "boolean",
                        "date",
                        "datetime",
                        "enum",
                      ],
                    },
                    required: { type: "boolean" },
                    enumValues: { type: "array", items: { type: "string" } },
                    references: { type: "string" },
                  },
                },
              },
              indexes: { type: "array", items: { type: "string" } },
              relations: { type: "array", items: { type: "string" } },
            },
          },
        },
        notes: { type: "array", items: { type: "string" } },
      },
    },
    seedData: {
      type: "object",
      additionalProperties: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
    },
    crudFlows: {
      type: "array",
      items: {
        type: "object",
        required: ["entity", "create", "read", "update", "delete"],
        properties: {
          entity: { type: "string" },
          create: { type: "array", items: { type: "string" } },
          read: { type: "array", items: { type: "string" } },
          update: { type: "array", items: { type: "string" } },
          delete: { type: "array", items: { type: "string" } },
        },
      },
    },
    auth: {
      type: "object",
      required: ["defaultPolicy", "publicRoutes", "privateRoutes", "roleRoutes", "decisions"],
      properties: {
        defaultPolicy: { type: "string", enum: ["authenticated-by-default"] },
        publicRoutes: { type: "array", items: { type: "string" } },
        privateRoutes: { type: "array", items: { type: "string" } },
        roleRoutes: {
          type: "array",
          items: {
            type: "object",
            required: ["role", "routes", "reason"],
            properties: {
              role: { type: "string", enum: ["admin"] },
              routes: { type: "array", items: { type: "string" } },
              reason: { type: "string" },
            },
          },
        },
        decisions: { type: "array", items: { type: "string" } },
      },
    },
    acceptanceChecks: { type: "array", items: { type: "string" } },
    integrationMetadata: {
      type: "object",
      properties: {
        requested: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "label", "envVars", "flows", "setupGuidance"],
            properties: {
              id: {
                type: "string",
                enum: [
                  "openai",
                  "anthropic",
                  "ollama",
                  "custom_api",
                  "slack_webhook",
                  "email",
                  "github",
                  "browser",
                  "stripe",
                  "database",
                ],
              },
              label: { type: "string" },
              envVars: { type: "array", items: { type: "string" } },
              flows: { type: "array", items: { type: "string" } },
              setupGuidance: { type: "array", items: { type: "string" } },
            },
          },
        },
        setupGuidance: { type: "array", items: { type: "string" } },
      },
    },
  },
};

export const APP_BUILDER_TOOL_NAME = "submit_app_draft";
export const APP_BUILDER_TOOL_DESCRIPTION =
  "Submit the structured AppDraft for a generated internal web app. Call this exactly once, after narrating your design choices in plain prose.";
