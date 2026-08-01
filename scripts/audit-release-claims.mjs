import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const root = resolve(process.cwd());
const roots = ["README.md", "docs/SELF_HOST.md", "web/src", "src"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".md"]);
const disallowed = [
  /coming\s+soon/gi,
  /coming\s+in\s+(?:a\s+)?future/gi,
  /fake[-\s]+success/gi,
  /demo[-\s]+only/gi,
  /TODO\s+Phase\b/gi,
  /\bstub\s+(?:provider|fallback)\b/gi,
];

const files = [];
for (const candidate of roots) await collect(resolve(root, candidate), files);

const findings = [];
for (const file of files.sort()) {
  const contents = await readFile(file, "utf8");
  for (const pattern of disallowed) {
    pattern.lastIndex = 0;
    for (const match of contents.matchAll(pattern)) {
      const index = match.index ?? 0;
      const line = contents.slice(0, index).split(/\r?\n/).length;
      findings.push(`${relative(root, file)}:${line}: ${match[0]}`);
    }
  }
}

if (findings.length > 0) {
  throw new Error(`unsupported release claims found:\n${findings.join("\n")}`);
}

console.log(JSON.stringify({ auditedFiles: files.length, unsupportedClaims: 0 }, null, 2));

async function collect(path, target) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    if (sourceExtensions.has(extname(path))) target.push(path);
    return;
  }
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) {
      await collect(child, target);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(extname(entry.name))) continue;
    if (/\.(?:test|spec)\.[^.]+$/i.test(entry.name)) continue;
    target.push(child);
  }
}
