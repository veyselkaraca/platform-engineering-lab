import { Controller, Get } from '@nestjs/common';

// Deliberately independent of the upstream services: if user-service is down the gateway must keep serving
// everything else. Failing readiness here would turn one broken backend into a full outage.
@Controller('health')
export class HealthController {
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  ready() {
    return { status: 'ok' };
  }
}
