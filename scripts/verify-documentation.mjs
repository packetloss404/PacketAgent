import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(process.cwd());
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
const scriptNames = new Set(Object.keys(packageJson.scripts ?? {}));
const markdownFiles = execFileSync("git", ["ls-files", "--", "*.md"], {
  cwd: repositoryRoot,
  encoding: "utf8",
})
  .split(/\r?\n/u)
  .filter(Boolean);
const failures = [];

for (const relativePath of markdownFiles) {
  const absolutePath = resolve(repositoryRoot, relativePath);
  const markdown = readFileSync(absolutePath, "utf8");

  if (/[^\x00-\x7f]/u.test(markdown)) {
    failures.push(`${relativePath}: contains non-ASCII text`);
  }

  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/gu)) {
    const destination = parseDestination(match[1]);
    if (!destination || /^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(destination)) continue;

    const pathOnly = destination.split("#", 1)[0].split("?", 1)[0];
    if (!pathOnly) continue;

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathOnly);
    } catch {
      failures.push(`${relativePath}: link has invalid URL encoding: ${destination}`);
      continue;
    }

    const localTarget = resolve(dirname(absolutePath), decodedPath);
    if (!existsSync(localTarget)) {
      failures.push(`${relativePath}: missing local link target: ${destination}`);
    }
  }

  for (const match of markdown.matchAll(/npm run\s+([A-Za-z0-9:_-]+)/gu)) {
    if (!scriptNames.has(match[1])) {
      failures.push(`${relativePath}: documents missing npm script ${match[1]}`);
    }
  }
}

const historicalRecords = [
  "REPO_REVIEW.md",
  "REPO_REVIEW_NOTES.md",
  "docs/AGENT_PLAYBOOK_FEATURES.md",
  "docs/AGENT_PLAYBOOK_SPRINTS.md",
  "docs/HANDOFF.md",
  "docs/PHASE3_SCOPE.md",
];
for (const relativePath of historicalRecords) {
  const content = readFileSync(resolve(repositoryRoot, relativePath), "utf8");
  if (!/historical|archived/iu.test(content.slice(0, 800))) {
    failures.push(`${relativePath}: historical record is missing a visible status warning`);
  }
}

const authorityClaims = [
  ["BACKLOG.md", /no next automatic loop is\s+currently defined/iu],
  ["HANDOFF.md", /No autonomous implementation loop remains/iu],
  ["README.md", /PA0, W1-W10, and inherited R1-R8 sequence is complete/iu],
  ["dev/CODEX-HANDOFF.md", /PA0, W1-W10, and R1-R8 are complete/iu],
  ["dev/roadmap.md", /PA0, W1-W10, and R1-R8 is complete/iu],
  ["dev/worker-implementation-loops.md", /No automatic\s+loop remains/iu],
];
for (const [relativePath, expected] of authorityClaims) {
  const content = readFileSync(resolve(repositoryRoot, relativePath), "utf8");
  if (!expected.test(content)) {
    failures.push(`${relativePath}: missing canonical completed-loop boundary`);
  }
}

const backlog = readFileSync(resolve(repositoryRoot, "BACKLOG.md"), "utf8");
const uncheckedItems = [...backlog.matchAll(/^- \[ \] (.+)$/gmu)].map((match) => match[1]);
if (
  uncheckedItems.length !== 1 ||
  !uncheckedItems[0].startsWith("Run live PacketChat and PacketPhone interoperability checks")
) {
  failures.push(
    "BACKLOG.md: the only unchecked item must be the conditional live PacketChat/PacketPhone interoperability check",
  );
}

for (const relativePath of [
  "docs/assets/readme/builder-app-mode.png",
  "docs/assets/readme/worker-operations-mode.png",
]) {
  const absolutePath = resolve(repositoryRoot, relativePath);
  if (!existsSync(absolutePath) || statSync(absolutePath).size < 10_000) {
    failures.push(`${relativePath}: README screenshot is missing or unexpectedly small`);
    continue;
  }
  const signature = readFileSync(absolutePath).subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    failures.push(`${relativePath}: README screenshot is not a PNG`);
  }
}

if (failures.length > 0) {
  console.error("Documentation verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation verification passed: ${markdownFiles.length} Markdown files, local links, npm commands, authority boundaries, backlog state, and README screenshots.`,
  );
}

function parseDestination(rawDestination) {
  const trimmed = rawDestination.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<")) {
    const closing = trimmed.indexOf(">");
    return closing === -1 ? trimmed : trimmed.slice(1, closing);
  }
  return trimmed.split(/\s+/u, 1)[0];
}
