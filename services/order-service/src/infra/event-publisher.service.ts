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
    const conn = await this.connectWithTimeout();
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

  // amqplib's own `timeout` option does not bound a DNS lookup stuck retrying (observed: EAI_AGAIN right after the
  // broker container restarts can keep `connect()` unsettled for 90+ seconds instead of failing in ~2s). Node's
  // dns.lookup() cannot be cancelled once started, so race it against an explicit timer instead: if the timer wins,
  // the caller sees a bounded failure while the orphaned attempt is closed if it ever does settle.
  private connectWithTimeout(): Promise<ChannelModel> {
    const attempt = connect(this.config.get('RABBITMQ_URL'), { timeout: CONNECT_TIMEOUT_MS });
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('connect ETIMEDOUT (outer bound)')), CONNECT_TIMEOUT_MS);
      timer.unref();
    });
    return Promise.race([attempt, timeout]).catch((err) => {
      attempt.then((conn) => conn.close().catch(() => undefined)).catch(() => undefined);
      throw err;
    });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.conn?.close();
    } catch (err) {
      this.log.warn(`RabbitMQ close failed: ${(err as Error).message}`);
    }
  }
}
