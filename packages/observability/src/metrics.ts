export type MetricLabels = Record<string, string>;

interface CounterState {
  help: string;
  values: Map<string, { labels: MetricLabels; value: number }>;
}

interface HistogramState {
  help: string;
  buckets: number[];
  values: Map<
    string,
    { labels: MetricLabels; counts: number[]; sum: number; count: number }
  >;
}

const DEFAULT_BUCKETS = [5, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

function labelKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key] ?? ""}`)
    .join(",");
}

function renderLabels(labels: MetricLabels, extra?: MetricLabels): string {
  const merged = { ...labels, ...(extra ?? {}) };
  const entries = Object.entries(merged);
  if (entries.length === 0) return "";
  const body = entries
    .map(([key, value]) => `${key}="${value.replaceAll('"', '\\"')}"`)
    .join(",");
  return `{${body}}`;
}

/**
 * A dependency-free Prometheus-compatible registry. Metric names are declared
 * up front in `metric-names.ts` so that no call site can invent a name that
 * embeds tenant data or a secret.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, CounterState>();
  private readonly histograms = new Map<string, HistogramState>();

  counter(name: string, labels: MetricLabels = {}, delta = 1): void {
    const state = this.counters.get(name) ?? { help: name, values: new Map() };
    const key = labelKey(labels);
    const existing = state.values.get(key) ?? { labels, value: 0 };
    existing.value += delta;
    state.values.set(key, existing);
    this.counters.set(name, state);
  }

  observe(
    name: string,
    valueMs: number,
    labels: MetricLabels = {},
    buckets: number[] = DEFAULT_BUCKETS,
  ): void {
    const state = this.histograms.get(name) ?? {
      help: name,
      buckets,
      values: new Map(),
    };
    const key = labelKey(labels);
    const existing = state.values.get(key) ?? {
      labels,
      counts: new Array<number>(state.buckets.length).fill(0),
      sum: 0,
      count: 0,
    };
    for (let index = 0; index < state.buckets.length; index += 1) {
      const bound = state.buckets[index] ?? Number.POSITIVE_INFINITY;
      if (valueMs <= bound) {
        existing.counts[index] = (existing.counts[index] ?? 0) + 1;
      }
    }
    existing.sum += valueMs;
    existing.count += 1;
    state.values.set(key, existing);
    this.histograms.set(name, state);
  }

  read(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(name)?.values.get(labelKey(labels))?.value ?? 0;
  }

  /** Total across every label combination for a counter. */
  total(name: string): number {
    const state = this.counters.get(name);
    if (!state) return 0;
    let sum = 0;
    for (const entry of state.values.values()) sum += entry.value;
    return sum;
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, state] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const entry of state.values.values()) {
        lines.push(`${name}${renderLabels(entry.labels)} ${entry.value}`);
      }
    }
    for (const [name, state] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const entry of state.values.values()) {
        state.buckets.forEach((bound, index) => {
          lines.push(
            `${name}_bucket${renderLabels(entry.labels, {
              le: String(bound),
            })} ${entry.counts[index] ?? 0}`,
          );
        });
        lines.push(
          `${name}_bucket${renderLabels(entry.labels, { le: "+Inf" })} ${entry.count}`,
        );
        lines.push(`${name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
        lines.push(`${name}_count${renderLabels(entry.labels)} ${entry.count}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
}
