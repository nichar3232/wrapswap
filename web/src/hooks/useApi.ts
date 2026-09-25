import { useEffect, useState } from "react";
export function useApi<T = any>(path: string | null, interval = 3000) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!path) return;
      try {
        const response = await fetch("/api" + path);
        const json = await response.json();
        if (!response.ok) throw Error(json.error || response.statusText);
        if (active) {
          setData(json);
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    setData(undefined);
    void run();
    const timer = setInterval(run, interval);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path, interval]);
  return { data, error };
}
