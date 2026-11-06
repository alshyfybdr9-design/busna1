"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError, type AppError } from "./errors";

/** Minimal data hook: loading / error / data / reload, with stale-response guard. */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (silent = false) => {
    const id = ++seq.current;
    if (!silent) setLoading(true);
    try {
      const result = await fnRef.current();
      if (id === seq.current) { setData(result); setError(null); }
    } catch (err) {
      if (id === seq.current) setError(toAppError(err));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run(); }, deps);

  return { data, error, loading, reload: run, setData };
}

/** Throws Supabase errors so useQuery can catch them. */
export function must<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data as T;
}
