import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { shutdownTelemetry } from './telemetry';

// Flushes buffered telemetry when the application shuts down (SIGTERM), so the last seconds are not lost.
@Injectable()
export class TelemetryLifecycle implements OnApplicationShutdown {
  onApplicationShutdown(): Promise<void> {
    return shutdownTelemetry();
  }
}
