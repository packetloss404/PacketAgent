import { useCallback, useEffect, useRef, useState } from "react";

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useApiData<T>(
  fn: () => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  const requestIdRef = useRef(0);
  const dependencyKey = JSON.stringify(deps);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current();
      if (requestId !== requestIdRef.current) return;
      setData(result);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(loadTimer);
      requestIdRef.current += 1;
    };
  }, [dependencyKey, refresh]);

  return { data, loading, error, refresh };
}
