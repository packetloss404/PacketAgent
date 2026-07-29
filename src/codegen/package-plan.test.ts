import assert from "node:assert/strict";
import test from "node:test";
import { planGeneratedAppPackageInstall } from "./package-plan.js";

test("package plan allows the generated React/Vite toolchain without executing it", () => {
  const plan = planGeneratedAppPackageInstall([
    {
      path: "package.json",
      content: JSON.stringify({
        packageManager: "npm@11.5.1",
        scripts: { dev: "vite", preinstall: "node prepare.js" },
        dependencies: {
          react: "^19.0.0",
          "react-dom": "^19.0.0",
          vite: "~7.3.6",
        },
        devDependencies: {
          typescript: "5.9.2",
          "@vitejs/plugin-react": "^5.0.2",
        },
      }),
    },
  ]);

  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.command, ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.equal(plan.executionPolicy.executed, false);
  assert.equal(plan.executionPolicy.requiredSandboxDriver, "docker");
  assert.equal(plan.executionPolicy.lifecycleScripts, false);
  assert.deepEqual(plan.lifecycleScripts, ["preinstall"]);
  assert.ok(plan.packages.every((entry) => entry.decision === "allowed"));
});

test("package plan blocks unapproved packages and non-registry specs", () => {
  const plan = planGeneratedAppPackageInstall([
    {
      path: "package.json",
      content: JSON.stringify({
        dependencies: {
          lodash: "^4.17.21",
          react: "git+ssh://git@example.test/react.git",
          vite: "file:../vite",
        },
      }),
    },
  ]);

  assert.equal(plan.status, "blocked");
  assert.equal(plan.command, undefined);
  assert.equal(plan.packages.find((entry) => entry.name === "lodash")?.decision, "blocked");
  assert.equal(plan.packages.find((entry) => entry.name === "react")?.decision, "blocked");
  assert.equal(plan.executionPolicy.executed, false);
});

test("package plan treats missing dependencies as no install and malformed JSON as invalid", () => {
  assert.equal(planGeneratedAppPackageInstall([]).status, "not_required");
  assert.equal(
    planGeneratedAppPackageInstall([{ path: "package.json", content: "{" }]).status,
    "invalid",
  );
});
