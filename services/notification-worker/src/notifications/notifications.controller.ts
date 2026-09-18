import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import { CurrentPrincipal, isAdmin, Roles } from '../auth/auth.decorators';
import { Principal } from '../auth/token-verifier';
import { NotificationsService } from './notifications.service';

// Read-only lookup used by clients and the smoke/e2e checks to confirm an event was processed.
// A customer sees only their own notifications; an admin sees all.
@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Roles('customer', 'admin')
  byOrder(@Query('orderId', new ParseUUIDPipe()) orderId: string, @CurrentPrincipal() principal: Principal) {
    return this.notifications.findByOrder(orderId, isAdmin(principal) ? undefined : principal.sub);
  }
}
