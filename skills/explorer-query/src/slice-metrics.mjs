import { SliceMaterializationError } from "./slice-errors.mjs";

export function createSliceMetrics({ onRecord } = {}) {
  const counters = new Map();
  const values = new Map();
  return {
    record(name, value = 1) {
      if (typeof onRecord === "function") onRecord(name, value);
      if (typeof value === "number") {
        counters.set(name, (counters.get(name) || 0) + value);
      } else {
        values.set(name, value);
      }
    },
    summary() {
      return {
        ...Object.fromEntries([...counters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        ...Object.fromEntries([...values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      };
    },
  };
}

export function recordMetric(metrics, name, value = 1) {
  if (!metrics) return;
  if (typeof metrics.record !== "function") {
    throw new SliceMaterializationError("slice metrics collector is invalid", { code: "METRICS_FAILED" });
  }
  try {
    metrics.record(name, value);
  } catch (err) {
    throw new SliceMaterializationError("slice metrics collector failed", { code: "METRICS_FAILED", cause: err });
  }
}

export function missesByReason(misses = []) {
  const out = {};
  for (const miss of misses) {
    const reason = miss?.miss_reason || miss?.reason || "unknown";
    out[reason] = (out[reason] || 0) + 1;
  }
  return out;
}
