import type {
  ReleaseConfirmationCollection,
  ReleaseConfirmationRecord,
  WorkspaceBriefCollection,
  WorkspaceBriefRecord,
} from "./types.js";

// LEAF module: collection-shape helpers used by both backends and the barrel
// mutators. Imports only types.

export function workspaceBriefEntries(
  collection: WorkspaceBriefCollection,
): WorkspaceBriefRecord[] {
  return Array.isArray(collection) ? collection : Object.values(collection);
}

export function releaseConfirmationEntries(
  collection: ReleaseConfirmationCollection,
): ReleaseConfirmationRecord[] {
  return Array.isArray(collection) ? collection : Object.values(collection);
}
