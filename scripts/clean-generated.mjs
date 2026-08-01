import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(process.cwd());
const targets = [
  "dist",
  "web/dist",
  "coverage",
  ".vite",
  "exports",
  "data/artifacts",
  "data/generated-apps",
  "data/published-apps",
  "tmp/release-verification",
];

for (const target of targets) {
  const absolute = resolve(root, target);
  const scoped = relative(root, absolute);
  if (!scoped || scoped.startsWith("..") || resolve(root, scoped) !== absolute) {
    throw new Error(`refusing to clean path outside the PacketAgent workspace: ${target}`);
  }
  await rm(absolute, { recursive: true, force: true });
  console.log(`removed ${target}`);
}
