import type { GeneratedFile } from "./llm-author.js";

export const GENERATED_APP_PACKAGE_ALLOWLIST = [
  "@tailwindcss/postcss",
  "@tailwindcss/vite",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "autoprefixer",
  "postcss",
  "react",
  "react-dom",
  "tailwindcss",
  "typescript",
  "vite",
] as const;

export type GeneratedAppPackagePlanStatus = "ready" | "blocked" | "not_required" | "invalid";

export interface GeneratedAppPackageDecision {
  name: string;
  requested: string;
  kind: "dependency" | "devDependency" | "optionalDependency" | "peerDependency";
  decision: "allowed" | "blocked";
  reason: string;
}

export interface GeneratedAppPackageInstallPlan {
  version: "packetagent.package-install-plan/v1";
  status: GeneratedAppPackagePlanStatus;
  packageManager: "npm";
  packageJsonPath?: "package.json";
  packages: GeneratedAppPackageDecision[];
  lifecycleScripts: string[];
  command?: string[];
  errors: string[];
  executionPolicy: {
    executed: false;
    requiredSandboxDriver: "docker";
    networkPolicy: "npm-registry-only";
    lifecycleScripts: false;
    timeoutMs: number;
    maxOutputBytes: number;
  };
}

const ALLOWED_PACKAGES = new Set<string>(GENERATED_APP_PACKAGE_ALLOWLIST);
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SAFE_SEMVER_SPEC = /^(?:\^|~)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_SECTIONS = [
  ["dependencies", "dependency"],
  ["devDependencies", "devDependency"],
  ["optionalDependencies", "optionalDependency"],
  ["peerDependencies", "peerDependency"],
] as const;

export function planGeneratedAppPackageInstall(
  files: GeneratedFile[],
): GeneratedAppPackageInstallPlan {
  const base = basePlan();
  const packageFile = files.find(
    (file) => file.path.replaceAll("\\", "/").replace(/^\.\/+/, "") === "package.json",
  );
  if (!packageFile) return { ...base, status: "not_required" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(packageFile.content);
  } catch {
    return {
      ...base,
      status: "invalid",
      packageJsonPath: "package.json",
      errors: ["package.json is not valid JSON."],
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ...base,
      status: "invalid",
      packageJsonPath: "package.json",
      errors: ["package.json must contain one JSON object."],
    };
  }

  const manifest = parsed as Record<string, unknown>;
  const packages: GeneratedAppPackageDecision[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>();

  for (const [section, kind] of DEPENDENCY_SECTIONS) {
    const value = manifest[section];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${section} must be an object of package names to semver specs.`);
      continue;
    }
    for (const [rawName, rawRequested] of Object.entries(value)) {
      const name = rawName.trim().toLowerCase();
      const requested = typeof rawRequested === "string" ? rawRequested.trim() : "";
      const prior = seen.get(name);
      if (prior !== undefined && prior !== requested) {
        errors.push(`${name} requests conflicting versions (${prior} and ${requested}).`);
      }
      seen.set(name, requested);
      const reason = packageBlockReason(name, requested);
      packages.push({
        name,
        requested,
        kind,
        decision: reason ? "blocked" : "allowed",
        reason: reason ?? "Package and semver spec are allowed by the generated-app policy.",
      });
    }
  }

  const packageManager = typeof manifest.packageManager === "string" ? manifest.packageManager : "";
  if (packageManager && !/^npm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageManager)) {
    errors.push("Only an exact npm packageManager declaration is supported.");
  }

  const scripts =
    manifest.scripts && typeof manifest.scripts === "object" && !Array.isArray(manifest.scripts)
      ? Object.keys(manifest.scripts as Record<string, unknown>)
      : [];
  const lifecycleScripts = scripts
    .filter((name) => /^(?:pre|post)?(?:install|uninstall|publish|pack)$/.test(name))
    .sort();
  packages.sort(
    (left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind),
  );

  const blocked = packages.some((entry) => entry.decision === "blocked") || errors.length > 0;
  const status: GeneratedAppPackagePlanStatus =
    packages.length === 0 ? (blocked ? "blocked" : "not_required") : blocked ? "blocked" : "ready";

  return {
    ...base,
    status,
    packageJsonPath: "package.json",
    packages,
    lifecycleScripts,
    ...(status === "ready"
      ? { command: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"] }
      : {}),
    errors,
  };
}

function packageBlockReason(name: string, requested: string): string | null {
  if (!SAFE_PACKAGE_NAME.test(name)) return "Package name is malformed.";
  if (!ALLOWED_PACKAGES.has(name)) return "Package is outside the generated-app allowlist.";
  if (!SAFE_SEMVER_SPEC.test(requested)) {
    return "Version must be an exact, caret, or tilde semantic version; URLs, aliases, tags, and local paths are blocked.";
  }
  return null;
}

function basePlan(): GeneratedAppPackageInstallPlan {
  return {
    version: "packetagent.package-install-plan/v1",
    status: "not_required",
    packageManager: "npm",
    packages: [],
    lifecycleScripts: [],
    errors: [],
    executionPolicy: {
      executed: false,
      requiredSandboxDriver: "docker",
      networkPolicy: "npm-registry-only",
      lifecycleScripts: false,
      timeoutMs: 120_000,
      maxOutputBytes: 1_000_000,
    },
  };
}
