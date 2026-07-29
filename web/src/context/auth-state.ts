import { createContext, useContext } from "react";

import type { Session } from "@/lib/types";

export interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  refreshSession: () => Promise<Session | null>;
  signIn: (body: { email: string; password: string }) => Promise<void>;
  signUp: (body: { displayName: string; email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  setSession: (session: Session | null) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return value;
}
