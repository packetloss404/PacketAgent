import type {
  AppDraft,
  AuthDraft,
  ComponentDraft,
  EntitySchemaDraft,
  FieldSchemaDraft,
  PageDraft,
  RouteAccess,
  SeedRecord,
} from "./types.js";

export function buildAuth(pages: PageDraft[]): AuthDraft {
  const publicRoutes = pages
    .filter((entry) => entry.access === "public")
    .map((entry) => entry.path);
  const privateRoutes = pages
    .filter((entry) => entry.access === "private")
    .map((entry) => entry.path);
  const adminRoutes = pages.filter((entry) => entry.access === "admin").map((entry) => entry.path);

  return {
    defaultPolicy: "authenticated-by-default",
    publicRoutes,
    privateRoutes,
    roleRoutes:
      adminRoutes.length > 0
        ? [
            {
              role: "admin",
              routes: adminRoutes,
              reason: "Administration pages mutate shared configuration or customer access.",
            },
          ]
        : [],
    decisions: [
      "Only explicitly public pages can be viewed without a session.",
      "Private API routes require an authenticated workspace user.",
      "Admin routes require an admin role in addition to authentication.",
    ],
  };
}

export function buildGeneratedPageData(draft: AppDraft) {
  return draft.pageMap.map((pageDraft) => ({
    route: pageDraft.path,
    name: pageDraft.name,
    access: pageDraft.access,
    purpose: pageDraft.purpose,
    primaryEntity: pageDraft.primaryEntity,
    actions: pageDraft.actions,
    components: draft.components
      .filter((componentDraft) => componentDraft.usedOn.includes(pageDraft.path))
      .map((componentDraft) => componentDraft.name),
  }));
}

export function page(
  path: string,
  name: string,
  access: RouteAccess,
  purpose: string,
  primaryEntity: string | undefined,
  actions: string[],
): PageDraft {
  return { path, name, access, purpose, primaryEntity, actions };
}

export function component(
  name: string,
  type: ComponentDraft["type"],
  usedOn: string[],
  responsibilities: string[],
): ComponentDraft {
  return { name, type, usedOn, responsibilities };
}

export function entity(
  name: string,
  fields: FieldSchemaDraft[],
  indexes: string[],
  relations: string[],
): EntitySchemaDraft {
  return { name, primaryKey: "id", fields, indexes, relations };
}

export function field(
  name: string,
  type: FieldSchemaDraft["type"],
  required: boolean,
  enumValues?: string[],
  references?: string,
): FieldSchemaDraft {
  return { name, type, required, enumValues, references };
}

export function clonePages(pages: PageDraft[]): PageDraft[] {
  return pages.map((entry) => ({ ...entry, actions: [...entry.actions] }));
}

export function cloneComponents(components: ComponentDraft[]): ComponentDraft[] {
  return components.map((entry) => ({
    ...entry,
    usedOn: [...entry.usedOn],
    responsibilities: [...entry.responsibilities],
  }));
}

export function cloneEntities(entities: EntitySchemaDraft[]): EntitySchemaDraft[] {
  return entities.map((entry) => ({
    ...entry,
    fields: entry.fields.map((fieldDraft) => ({
      ...fieldDraft,
      enumValues: fieldDraft.enumValues ? [...fieldDraft.enumValues] : undefined,
    })),
    indexes: [...entry.indexes],
    relations: [...entry.relations],
  }));
}

export function cloneSeedData(
  seedData: Record<string, SeedRecord[]>,
): Record<string, SeedRecord[]> {
  return Object.fromEntries(
    Object.entries(seedData).map(([key, records]) => [
      key,
      records.map((record) => ({ ...record })),
    ]),
  );
}

export function requiredFieldNames(entityDraft: EntitySchemaDraft): string[] {
  return entityDraft.fields
    .filter((entry) => entry.required && entry.name !== "id")
    .map((entry) => entry.name);
}

export function editableFieldNames(entityDraft: EntitySchemaDraft): string[] {
  return entityDraft.fields
    .filter((entry) => entry.name !== "id" && !entry.name.endsWith("At"))
    .map((entry) => entry.name);
}
