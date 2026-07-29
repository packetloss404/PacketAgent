import type { ReactNode } from "react";

import type { Session } from "@/lib/types";
import { WorkbenchContext } from "./workbench-state";

export function WorkbenchProvider({
  session,
  signOut,
  children,
}: {
  session: Session;
  signOut: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <WorkbenchContext.Provider value={{ session, signOut }}>{children}</WorkbenchContext.Provider>
  );
}
