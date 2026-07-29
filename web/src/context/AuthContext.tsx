import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "@/lib/api";
import type { Session } from "@/lib/types";
import { AuthContext } from "./auth-state";

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [session, setSessionState] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const setSession = useCallback((nextSession: Session | null) => {
    setSessionState(nextSession);
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const nextSession = await api.getSession();
      setSessionState(nextSession);
      return nextSession;
    } catch (error) {
      if ((error as Error & { status?: number }).status === 401) {
        setSessionState(null);
        return null;
      }
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  const signIn = useCallback(async (body: { email: string; password: string }) => {
    const nextSession = await api.signIn(body);
    setSessionState(nextSession);
  }, []);

  const signUp = useCallback(
    async (body: { displayName: string; email: string; password: string }) => {
      const nextSession = await api.signUp(body);
      setSessionState(nextSession);
    },
    [],
  );

  const signOut = useCallback(async () => {
    await api.signOut();
    setSessionState(null);
    navigate("/", { replace: true });
  }, [navigate]);

  useEffect(() => {
    let active = true;
    void api
      .getSession()
      .then((nextSession) => {
        if (active) setSessionState(nextSession);
      })
      .catch(() => {
        if (active) setSessionState(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo(
    () => ({ session, loading, refreshSession, signIn, signUp, signOut, setSession }),
    [session, loading, refreshSession, signIn, signUp, signOut, setSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
