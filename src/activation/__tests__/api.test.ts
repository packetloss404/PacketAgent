import assert from "node:assert/strict";
import test from "node:test";
import { readActivationStatus } from "../api";
import {
  InMemoryActivationMilestoneRepository,
  InMemoryActivationSignalRepository,
  InMemoryActivationStatusReadModelRepository,
} from "../repositories";
import { deriveActivationStatus } from "../service";
import { emptySnapshot, subject } from "./fixtures";

test("readActivationStatus returns computed status and persists optional read model", async () => {
  const signals = new InMemoryActivationSignalRepository();
  const milestones = new InMemoryActivationMilestoneRepository();
  const readModel = new InMemoryActivationStatusReadModelRepository();

  signals.setSnapshot(subject, {
    ...emptySnapshot,
    hasBrief: true,
    hasRequirements: true,
    hasPlan: true,
  });

  const result = await readActivationStatus(
    {
      signals,
      milestones,
      derive: deriveActivationStatus,
      readModel,
    },
    { subject },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status.stage, "definition");

  const saved = await readModel.load(subject);
  assert.equal(saved?.stage, "definition");
});
