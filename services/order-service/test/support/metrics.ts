// Reads the metrics the code under test emits: installs an in-memory MeterProvider as the global one.
// Instruments created at import time (metrics.getMeter) attach to it, so import this file before running the code.
import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';

class TestReader extends MetricReader {
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

const reader = new TestReader();
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

type Attributes = Record<string, string | number | boolean>;

// Sum over the data points of `name` whose attributes contain `attributes`. Histograms report their sample count.
export async function metricValue(name: string, attributes: Attributes = {}): Promise<number> {
  const { resourceMetrics } = await reader.collect();
  let total = 0;
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (metric.descriptor.name !== name) continue;
      for (const point of metric.dataPoints) {
        if (!Object.entries(attributes).every(([k, v]) => point.attributes[k] === v)) continue;
        const value = point.value as number | { count: number };
        total += typeof value === 'number' ? value : value.count;
      }
    }
  }
  return total;
}
