import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelModel, ConfirmChannel, connect } from 'amqplib';
import { Env } from '../config/env';

export const ORDERS_EXCHANGE = 'orders';
const CONNECT_TIMEOUT_MS = 2000;
const CONFIRM_TIMEOUT_MS = 2000;

export interface DomainEvent {
  eventId: string;
  type: string;
  occurredAt: string;
  correlationId: string;
  data: Record<string, unknown>;
}

// Publishes with broker confirms. Connects lazily and reconnects on the next publish after a drop,
// so a RabbitMQ outage never blocks startup. Topology is declared by messaging/rabbitmq/definitions.
@Injectable()
export class EventPublisher implements OnModuleDestroy {
  private readonly log = new Logger(EventPublisher.name);
  private conn?: ChannelModel;
  private channel?: ConfirmChannel;
  private opening?: Promise<ConfirmChannel>;

  constructor(private readonly config: ConfigService<Env, true>) {}

  async publish(routingKey: string, event: DomainEvent): Promise<void> {
    const channel = await this.getChannel();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('publish confirm timed out')), CONFIRM_TIMEOUT_MS);
      channel.publish(
        ORDERS_EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true,
          contentType: 'application/json',
          type: event.type,
          messageId: event.eventId,
          correlationId: event.correlationId,
          timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
        },
        (err) => {
          clearTimeout(timer);
          if (err) reject(err instanceof Error ? err : new Error(String(err)));
          else resolve();
        },
      );
    });
  }

  private getChannel(): Promise<ConfirmChannel> {
    if (this.channel) return Promise.resolve(this.channel);
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async open(): Promise<ConfirmChannel> {
    const conn = await connect(this.config.get('RABBITMQ_URL'), { timeout: CONNECT_TIMEOUT_MS });
    // Without an error listener a broker-initiated error would crash the process.
    conn.on('error', (err) => this.log.warn(`RabbitMQ connection error: ${err.message}`));
    conn.on('close', () => {
      this.log.warn('RabbitMQ connection closed; will reconnect on next publish');
      this.conn = undefined;
      this.channel = undefined;
    });
    try {
      const channel = await conn.createConfirmChannel();
      channel.on('error', (err) => this.log.warn(`RabbitMQ channel error: ${err.message}`));
      channel.on('close', () => {
        if (this.channel === channel) this.channel = undefined;
      });
      this.conn = conn;
      this.channel = channel;
      return channel;
    } catch (err) {
      await conn.close().catch((closeErr: Error) => this.log.debug(`close after failed open: ${closeErr.message}`));
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.conn?.close();
    } catch (err) {
      this.log.warn(`RabbitMQ close failed: ${(err as Error).message}`);
    }
  }
}
