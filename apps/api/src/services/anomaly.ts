/**
 * Streaming anomaly detection on a metric series: robust z-score of the latest points against a trailing
 * baseline (median / MAD). Two consecutive breaches are required to avoid paging on a single spike.
 */
export interface Detection { anomalous: boolean; zscore: number; baseline: number; value: number }

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function robustZ(history: number[], value: number) {
  const base = median(history);
  const mad = median(history.map((x) => Math.abs(x - base))) || Math.max(Math.abs(base) * 0.05, 1e-6);
  return { z: (0.6745 * (value - base)) / mad, base };
}

/** `series` oldest→newest. Upward deviations only (errors, latency, saturation). */
export function detect(series: number[], { threshold = 6, minHistory = 12, consecutive = 2, minAbsoluteDelta = 0 } = {}): Detection {
  const value = series.at(-1) ?? 0;
  if (series.length < minHistory + consecutive) return { anomalous: false, zscore: 0, baseline: value, value };
  const history = series.slice(0, -consecutive);
  const recent = series.slice(-consecutive);
  const scored = recent.map((v) => robustZ(history, v));
  const z = scored.at(-1)!.z;
  const base = scored.at(-1)!.base;
  const anomalous = scored.every((s) => s.z >= threshold) && value - base >= minAbsoluteDelta;
  return { anomalous, zscore: Math.round(z * 10) / 10, baseline: Math.round(base * 1000) / 1000, value };
}

/** Per-metric sensitivity: small absolute changes in error rate shouldn't page. */
export const METRIC_RULES: Record<string, { threshold: number; minAbsoluteDelta: number; label: string }> = {
  error_rate: { threshold: 6, minAbsoluteDelta: 0.02, label: "Error rate" },
  latency_p95_ms: { threshold: 6, minAbsoluteDelta: 150, label: "p95 latency" },
  saturation: { threshold: 7, minAbsoluteDelta: 0.15, label: "Saturation" },
};
