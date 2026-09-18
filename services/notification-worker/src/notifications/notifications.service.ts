import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OrderCreatedEvent } from '../messaging/order-created.event';

export interface Notification {
  id: string;
  eventId: string;
  orderId: string;
  userId: string;
  createdAt: string;
}

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(private readonly dataSource: DataSource) {}

  // Idempotent (FR-7): UNIQUE(event_id) makes a redelivered event a no-op. Returns false for a duplicate.
  // The stored row is the (simulated) delivery; a real provider would be called here.
  async record(event: OrderCreatedEvent): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      'INSERT INTO notifications (event_id, order_id, user_id) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING RETURNING id',
      [event.eventId, event.orderId, event.userId],
    );
    const ctx = `eventId=${event.eventId} orderId=${event.orderId} userId=${event.userId} correlationId=${event.correlationId}`;
    if (rows.length === 0) {
      this.log.log(`notification.duplicate_ignored ${ctx}`);
      return false;
    }
    this.log.log(`notification.sent ${ctx}`);
    return true;
  }

  findByOrder(orderId: string): Promise<Notification[]> {
    return this.dataSource.query(
      `SELECT id, event_id AS "eventId", order_id AS "orderId", user_id AS "userId", created_at AS "createdAt"
       FROM notifications WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
    );
  }
}
