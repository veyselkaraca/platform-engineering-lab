import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheService } from '../infra/cache.service';
import { EventPublisher } from '../infra/event-publisher.service';
import { UserDirectory } from '../users/user-directory.service';
import { IdempotencyKey } from './idempotency-key.entity';
import { Order } from './order.entity';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order, IdempotencyKey])],
  controllers: [OrdersController],
  providers: [OrdersService, UserDirectory, CacheService, EventPublisher],
})
export class OrdersModule {}
