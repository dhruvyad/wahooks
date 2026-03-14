"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

interface UseApiDataOptions {
  revalidateInterval?: number;
}

interface UseApiDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  mutate: (updater?: T | ((prev: T | null) => T | null)) => void;
}

export function useApiData<T>(
  key: string,
  fetchFn: () => Promise<T>,
  options?: UseApiDataOptions
): UseApiDataResult<T> {
  const cached = cache.get(key) as CacheEntry<T> | undefined;

  const [data, setData] = useState<T | null>(cached?.data ?? null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  const dataRef = useRef(data);
  dataRef.current = data;

  const fetchFnRef = useRef(fetchFn);
  fetchFnRef.current = fetchFn;
  const keyRef = useRef(key);
  keyRef.current = key;

  const revalidate = useCallback(async () => {
    try {
      const result = await fetchFnRef.current();
      cache.set(keyRef.current, { data: result, timestamp: Date.now() });
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // If we have cached data, show it immediately and revalidate in background
    const entry = cache.get(key) as CacheEntry<T> | undefined;
    if (entry) {
      setData(entry.data);
      setLoading(false);
      // Revalidate in background
      revalidate();
    } else {
      setLoading(true);
      revalidate();
    }
  }, [key, revalidate]);

  useEffect(() => {
    if (!options?.revalidateInterval) return;

    const interval = setInterval(revalidate, options.revalidateInterval);
    return () => clearInterval(interval);
  }, [options?.revalidateInterval, revalidate]);

  const mutate = useCallback(
    (updater?: T | ((prev: T | null) => T | null)) => {
      if (updater === undefined) {
        // Just revalidate
        revalidate();
        return;
      }
      const newData =
        typeof updater === "function"
          ? (updater as (prev: T | null) => T | null)(dataRef.current)
          : updater;
      if (newData !== null) {
        cache.set(keyRef.current, { data: newData, timestamp: Date.now() });
      }
      setData(newData);
    },
    [revalidate]
  );

  return { data, loading, error, mutate };
}
