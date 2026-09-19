import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/pg-errors';
import { EventPublisher } from '../infra/event-publisher.service';
import { UserDirectory } from '../users/user-directory.service';
import { CreateOrderDto } from './create-order.dto';
import { IdempotencyKey } from './idempotency-key.entity';
import { eventPublishFailures, ordersCreated } from './orders.metrics';
import { Order } from './order.entity';

export interface CreateResult {
  order: Order;
  created: boolean;
}

@Injectable()
export class OrdersService {
  private readonly log = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(IdempotencyKey) private readonly keys: Repository<IdempotencyKey>,
    private readonly dataSource: DataSource,
    private readonly users: UserDirectory,
    private readonly events: EventPublisher,
  ) {}

  // ponytail: a repeated Idempotency-Key returns the original order without comparing the payload;
  // reject mismatching payloads (422) if clients start reusing keys carelessly.
  async create(
    dto: CreateOrderDto,
    idempotencyKey: string | undefined,
    correlationId: string,
    authorization?: string,
  ): Promise<CreateResult> {
    if (idempotencyKey) {
      const existing = await this.findByKey(idempotencyKey);
      if (existing) return this.replay(existing, dto);
    }

    if (!(await this.users.exists(dto.userId, correlationId, authorization))) {
      throw new UnprocessableEntityException('User does not exist');
    }

    let order: Order;
    try {
      order = await this.dataSource.transaction(async (m) => {
        const saved = await m.save(m.create(Order, { ...dto, status: 'CREATED' }));
        if (idempotencyKey) await m.insert(IdempotencyKey, { key: idempotencyKey, orderId: saved.id });
        return saved;
      });
    } catch (err) {
      // A concurrent request with the same key won the race: return its order.
      if (idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.findByKey(idempotencyKey);
        if (existing) return this.replay(existing, dto);
      }
      throw err;
    }

    ordersCreated.add(1);
    await this.publishCreated(order, correlationId);
    return { order, created: true };
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.orders.findOneBy({ id });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  // Keys are global, so a replay must never hand one caller's order to another: a key used for a different
  // user's order is a conflict, not a replay.
  private replay(existing: Order, dto: CreateOrderDto): CreateResult {
    if (existing.userId !== dto.userId) throw new ConflictException('Idempotency-Key was already used');
    return { order: existing, created: false };
  }

  private async findByKey(key: string): Promise<Order | null> {
    const record = await this.keys.findOneBy({ key });
    return record ? this.orders.findOneBy({ id: record.orderId }) : null;
  }

  // The order is already committed, so a publish failure must not fail the request (ADR-001 known limitation).
  private async publishCreated(order: Order, correlationId: string): Promise<void> {
    try {
      await this.events.publish('order.created', {
        eventId: randomUUID(),
        type: 'order.created',
        occurredAt: new Date().toISOString(),
        correlationId,
        data: { orderId: order.id, userId: order.userId, amount: order.amount, description: order.description },
      });
    } catch (err) {
      eventPublishFailures.add(1);
      this.log.error(`order.publish_failed orderId=${order.id} correlationId=${correlationId} cause=${(err as Error).message}`);
    }
  }
}
