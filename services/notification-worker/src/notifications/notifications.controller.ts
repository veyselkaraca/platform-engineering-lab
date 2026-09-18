import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

// Read-only lookup used by operators and the smoke/e2e checks to confirm an event was processed.
// AuthN/AuthZ arrives with the Keycloak slice.
@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  byOrder(@Query('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.notifications.findByOrder(orderId);
  }
}
