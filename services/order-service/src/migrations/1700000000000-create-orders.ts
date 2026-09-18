import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrders1700000000000 implements MigrationInterface {
  name = 'CreateOrders1700000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        description VARCHAR NOT NULL,
        status VARCHAR NOT NULL DEFAULT 'CREATED',
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE idempotency_keys (
        key VARCHAR(200) PRIMARY KEY,
        order_id UUID NOT NULL REFERENCES orders(id),
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE idempotency_keys');
    await q.query('DROP TABLE orders');
  }
}
