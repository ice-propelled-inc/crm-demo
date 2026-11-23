import { useCallback, useEffect, useState } from "react";
import { api } from "./api/client";

/** GET `path`; `reload()` fetches again. */
export function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, setError };
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
