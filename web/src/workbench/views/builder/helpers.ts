import type { AppBuilderDraft, AppBuilderPublishState, BuilderModelPresetId } from "@/lib/types";
import { SMARTER_TIER_LADDER } from "./constants";
import type { ChatMessage, IterationTargetOption } from "./types";

export function buildFixErrorsPrompt(errors: string[]): string {
  return `Fix these TypeScript errors:\n${errors.join("\n")}`;
}

export function getPreviewNavigationTarget(previewUrl: string | null, appId: string | null) {
  const cleanPreviewUrl = previewUrl?.trim();
  if (cleanPreviewUrl) {
    if (/^https?:\/\//i.test(cleanPreviewUrl) || cleanPreviewUrl.startsWith("/"))
      return cleanPreviewUrl;
    return `/${cleanPreviewUrl}`;
  }
  return appId ? `/builder/preview/workspace/${encodeURIComponent(appId)}` : null;
}

export function publishReadinessHeading(
  state: Pick<AppBuilderPublishState, "canPublish" | "publishedUrl"> | null,
): string {
  if (!state) return "Loading publish handoff";
  return state.canPublish ? "Ready for local publish handoff" : "Publish handoff blocked";
}

export function publishPrimaryActionLabel(working: boolean): string {
  return working ? " Publishing..." : " Publish";
}

export function nextSmarterPreset(current: BuilderModelPresetId): BuilderModelPresetId | null {
  const idx = SMARTER_TIER_LADDER.indexOf(current);
  if (idx < 0) return null; // e.g. "local"
  if (idx >= SMARTER_TIER_LADDER.length - 1) return null;
  return SMARTER_TIER_LADDER[idx + 1] ?? null;
}

/**
 * Build a short context snippet describing an assistant message so the
 * "Tell me what to change" affordance can prepend a useful hint to the
 * iteration composer (e.g. "About this change (diff: contacts page): ").
 */
export function describeMessageForContext(msg: ChatMessage | undefined): string {
  if (!msg) return "";
  if (msg.body.kind === "plan") {
    const name = msg.body.draft?.app?.name;
    return name ? `plan: ${name}` : "plan";
  }
  if (msg.body.kind === "diff") {
    const label = msg.body.iteration?.target?.label;
    return label ? `diff: ${label}` : "diff";
  }
  if (msg.body.kind === "prose" || msg.body.kind === "text") {
    const text = msg.body.text.replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }
  return "";
}

export function newId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function stableTargetKey(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase()).replace(/%/g, "_");
}

export function buildIterationTargetOptions(
  draft: AppBuilderDraft | null,
): IterationTargetOption[] {
  if (!draft) {
    return [{ id: "app:draft", kind: "app", label: "Whole app", group: "App" }];
  }
  const appKey = stableTargetKey(draft.app.slug || draft.app.name || "app");
  return [
    {
      id: `app:${appKey}`,
      kind: "app",
      label: draft.app.name || "Whole app",
      path: draft.app.slug,
      group: "App",
    },
    ...draft.app.pages.map((page) => ({
      id: `page:${stableTargetKey(page.route || page.name)}`,
      kind: "page" as const,
      label: `${page.name} (${page.route})`,
      path: page.route,
      group: "Pages",
    })),
    ...draft.app.dataSchema.map((entity) => ({
      id: `data_entity:${stableTargetKey(entity.name)}`,
      kind: "data_entity" as const,
      label: entity.name,
      path: entity.name,
      group: "Data",
    })),
    ...draft.app.apiRoutes.map((route) => ({
      id: `api_route:${stableTargetKey(`${route.method}:${route.path}`)}`,
      kind: "api_route" as const,
      label: `${route.method} ${route.path}`,
      path: route.path,
      group: "API",
    })),
    ...(draft.app.authDecisions.length > 0
      ? [
          {
            id: `auth:${appKey}`,
            kind: "auth" as const,
            label: `Auth (${draft.app.authDecisions.map((decision) => decision.area).join(", ")})`,
            path: "auth",
            group: "Auth",
          },
        ]
      : []),
    {
      id: `smoke:${appKey}`,
      kind: "smoke",
      label: `Smoke / build (${draft.smokeBuildStatus.status})`,
      path: "smoke",
      group: "Quality",
    },
  ];
}

export function escapeCssIdent(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[\0-\x1f\x7f]|^-?\d|^-$|[^\w-]/g, (char, offset) => {
    if (char === "\0") return "\uFFFD";
    const code = char.charCodeAt(0).toString(16).toUpperCase();
    return offset === 0 || /[\0-\x1f\x7f]/.test(char) ? `\\${code} ` : `\\${char}`;
  });
}

export function cssPathFor(el: Element): string {
  const segments: string[] = [];
  let current: Element | null = el;
  while (current && current.nodeType === 1 && segments.length < 6) {
    const node: Element = current;
    const tag = node.tagName.toLowerCase();
    let segment = tag;
    const id = node.getAttribute("id");
    if (id) {
      segment = `${tag}#${escapeCssIdent(id)}`;
      segments.unshift(segment);
      break;
    }
    const classes = (node.getAttribute("class") ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    if (classes.length > 0)
      segment += classes.map((className) => `.${escapeCssIdent(className)}`).join("");
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTagSiblings: Element[] = Array.from(parent.children).filter(
        (sibling) => sibling.tagName === node.tagName,
      );
      if (sameTagSiblings.length > 1) {
        const index = sameTagSiblings.indexOf(node) + 1;
        segment += `:nth-of-type(${index})`;
      }
    }
    segments.unshift(segment);
    current = parent;
  }
  return segments.join(" > ");
}
