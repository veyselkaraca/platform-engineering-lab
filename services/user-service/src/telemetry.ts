// OpenTelemetry bootstrap (docs/features/observability). Must be the FIRST import of main.ts: instrumentations patch
// modules (http, express, pg, pino, ...) as they are first required, so nothing that loads them may run before this.
//
// Traces, metrics and logs go over OTLP/HTTP to the collector (OTEL_EXPORTER_OTLP_ENDPOINT). Everything is bounded:
// exports time out, queues are capped and data is dropped when the collector is unavailable, so telemetry can never
// stall or fail a request (OB-1). OTEL_SDK_DISABLED=true switches it off (tests, tooling).
import { metrics } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

const EXPORT_TIMEOUT_MS = 3000;
const METRIC_INTERVAL_MS = 15_000;
export const SHUTDOWN_TIMEOUT_MS = 5000;

const disabled = process.env.OTEL_SDK_DISABLED === 'true';
const isProbe = (url?: string) => url === '/health' || (url?.startsWith('/health/') ?? false);

let sdk: NodeSDK | undefined;

if (!disabled) {
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ timeoutMillis: EXPORT_TIMEOUT_MS }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ timeoutMillis: EXPORT_TIMEOUT_MS }),
        exportIntervalMillis: METRIC_INTERVAL_MS,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ timeoutMillis: EXPORT_TIMEOUT_MS }), maxQueueSize: 2048, exportTimeoutMillis: EXPORT_TIMEOUT_MS }),
    ],
    instrumentations: [
      // Probe traffic would drown real traces and skew the request metrics (OB-3). Headers are never recorded (OB-11).
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => isProbe(req.url) }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      // Statements are recorded with placeholders only, never with parameter values (OB-11).
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      // Adds trace_id / span_id to every pino line and sends the lines to the collector as OTLP logs (OB-3).
      new PinoInstrumentation(),
      new RuntimeNodeInstrumentation(),
    ],
  });
  sdk.start();

  // Process resource use (OB-4): two observables, no need for host-wide metrics of the container VM.
  const meter = metrics.getMeter('process');
  meter
    .createObservableGauge('process.memory.usage', { unit: 'By', description: 'Resident set size' })
    .addCallback((r) => r.observe(process.memoryUsage().rss));
  meter
    .createObservableCounter('process.cpu.time', { unit: 's', description: 'CPU time by mode' })
    .addCallback((r) => {
      const usage = process.cpuUsage();
      r.observe(usage.user / 1e6, { 'cpu.mode': 'user' });
      r.observe(usage.system / 1e6, { 'cpu.mode': 'system' });
    });
}

// Flushes what is buffered; bounded, so a dead collector cannot delay the exit.
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  await Promise.race([sdk.shutdown().catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref())]);
}
