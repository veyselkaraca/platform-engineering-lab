import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNotifications1700000000000 implements MigrationInterface {
  name = 'CreateNotifications1700000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id UUID NOT NULL UNIQUE,
        order_id UUID NOT NULL,
        user_id UUID NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )`);
    await q.query('CREATE INDEX notifications_order_id_idx ON notifications (order_id)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE notifications');
  }
}
