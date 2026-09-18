import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';

// Probes are unauthenticated by design.
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  // Liveness: process is up. Must not depend on external systems.
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // Readiness: hard dependencies only (PostgreSQL).
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.db.pingCheck('database', { timeout: 2000 })]);
  }
}
