import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Polls an async source. Keeps the last good data on transient errors so the page never blanks, and exposes
 * when it was last updated so stale data is visible rather than silent.
 */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [loading, setLoading] = useState(true);
  const live = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async () => {
    try {
      const v = await fnRef.current();
      if (!live.current) return;
      setData(v);
      setError(undefined);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (!live.current) return;
      setError((e as Error).message || String(e));
    } finally {
      if (live.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    setLoading(true);
    run();
    // Hidden tabs do not poll; the visibility handler refreshes as soon as the tab is shown again.
    const t = ms > 0 ? setInterval(() => document.visibilityState !== 'hidden' && run(), ms) : undefined;
    const onVis = () => document.visibilityState === 'visible' && run();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      live.current = false;
      if (t) clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, updatedAt, loading, refresh: run };
}

/** Re-renders every `ms` so relative times ("12s ago") stay honest. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
