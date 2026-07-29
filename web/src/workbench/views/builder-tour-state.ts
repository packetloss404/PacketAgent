const STORAGE_KEY = "packetagent_builder_tour_seen";

export function readBuilderTourSeen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

export function markBuilderTourSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Storage can be blocked; the in-memory tour state still closes.
  }
}

export function resetBuilderTour(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked; remounting still gives the caller a safe no-op.
  }
}
