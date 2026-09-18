import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { HealthCheck, HealthCheckService, HealthIndicatorService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { ConsumerService } from '../messaging/consumer.service';

// Probes are unauthenticated by design.
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly indicators: HealthIndicatorService,
    private readonly consumer: ConsumerService,
  ) {}

  // Liveness: process is up. Must not depend on external systems, so a broker outage never restarts the pod.
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // Readiness: a worker that is not consuming is not functional, so RabbitMQ is a hard dependency here.
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 2000 }),
      () => {
        const session = this.indicators.check('consumer');
        return this.consumer.isConnected() ? session.up() : session.down({ message: 'not consuming' });
      },
    ]);
  }
}
