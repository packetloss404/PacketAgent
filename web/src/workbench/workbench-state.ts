import { createContext, useContext } from "react";

import type { Session } from "@/lib/types";

export interface WorkbenchContextValue {
  session: Session;
  signOut: () => Promise<void>;
}

export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function useWorkbench() {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("useWorkbench must be used within WorkbenchProvider");
  return value;
}

export function useWorkspaceName() {
  return useWorkbench().session.workspace.name || "Workspace";
}

export function useUser() {
  return useWorkbench().session.user;
}

export function useRole() {
  return useWorkbench().session.workspace.role ?? "viewer";
}
