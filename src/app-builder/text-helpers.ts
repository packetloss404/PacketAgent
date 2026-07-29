export function kebabPlural(value: string): string {
  return `${value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase()}s`;
}

export function appSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "generated-app"
  );
}

export function humanName(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`).toLowerCase();
}

export function humanPlural(value: string): string {
  return `${humanName(value)}s`;
}

export function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function generatedArtifactCopy(value: string): string {
  return value
    .replace(/\bAPI route stubs\b/gi, "API routes")
    .replace(/\broute stubs\b/gi, "routes")
    .replace(/\bstubs\b/gi, "routes")
    .replace(/\bstub\b/gi, "route");
}
