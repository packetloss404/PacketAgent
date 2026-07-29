import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  composeServiceHardening,
  containerHardeningControlsPass,
  dockerInspectionHardening,
  isNonRootIdentity,
  liveContainerHardeningProbePass,
  parseComposeService,
} from "./container-hardening.js";
import { generatedAppDockerComposeYaml } from "./generated-app-publish-package.js";

test("container hardening classifiers require every declared boundary", () => {
  const controls = composeServiceHardening({
    user: "65534:65534",
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    pids_limit: 32,
    init: true,
  });
  assert.equal(containerHardeningControlsPass(controls, 32), true);
  assert.equal(
    containerHardeningControlsPass({ ...controls, capabilitiesDropped: false }, 32),
    false,
  );
  assert.equal(
    liveContainerHardeningProbePass(
      {
        uid: 65534,
        gid: 65534,
        capEff: "0000000000000000",
        noNewPrivs: "1",
        pidsMax: "32",
        rootWriteDenied: true,
      },
      32,
    ),
    true,
  );
  assert.equal(isNonRootIdentity(""), false);
  assert.equal(isNonRootIdentity("root"), false);
  assert.equal(isNonRootIdentity("0:0"), false);
  assert.equal(isNonRootIdentity("node"), true);
  assert.equal(
    containerHardeningControlsPass(
      dockerInspectionHardening({
        Config: { User: "node" },
        HostConfig: {
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          PidsLimit: 128,
          Init: true,
        },
      }),
      128,
    ),
    true,
  );
});

test("checked-in and generated container definitions declare the R5.6 matrix", () => {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const rootDockerfile = readFileSync(resolve(repositoryRoot, "Dockerfile"), "utf8");
  const rootCompose = readFileSync(resolve(repositoryRoot, "docker-compose.yml"), "utf8");
  const validatorDockerfile = readFileSync(
    resolve(repositoryRoot, "src/sandbox/codegen-validator.Dockerfile"),
    "utf8",
  );
  const generatedCompose = generatedAppDockerComposeYaml();

  assert.match(rootDockerfile, /^USER packetagent$/m);
  assert.match(validatorDockerfile, /^USER 65534:65534$/m);
  for (const [name, compose, user, pids] of [
    ["PacketAgent", rootCompose, "packetagent", "256"],
    ["generated app", generatedCompose, "node", "128"],
  ] as const) {
    assert.match(compose, new RegExp(`^    user: ${user}$`, "m"), `${name} user`);
    assert.match(compose, /^    read_only: true$/m, `${name} read-only root`);
    assert.match(compose, /^    cap_drop:\r?\n      - ALL$/m, `${name} capabilities`);
    assert.match(compose, /^      - no-new-privileges:true$/m, `${name} no-new-privileges`);
    assert.match(compose, new RegExp(`^    pids_limit: ${pids}$`, "m"), `${name} PID limit`);
    assert.match(compose, /^    init: true$/m, `${name} init`);
  }
});

test("Compose JSON parsing fails closed on absent services", () => {
  const service = parseComposeService(
    JSON.stringify({
      services: {
        worker: {
          user: "node",
          read_only: true,
          cap_drop: ["ALL"],
          security_opt: ["no-new-privileges"],
          pids_limit: 64,
          init: true,
        },
      },
    }),
    "worker",
  );
  assert.equal(service.user, "node");
  assert.throws(() => parseComposeService('{"services":{}}', "worker"), /did not contain service/);
  assert.throws(() => parseComposeService("not-json", "worker"), /invalid JSON/);
});
