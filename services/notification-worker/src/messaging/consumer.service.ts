import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelModel, ConfirmChannel, ConsumeMessage, connect } from 'amqplib';
import { Env } from '../config/env';
import { NotificationsService } from '../notifications/notifications.service';
import { PermanentError, parseOrderCreated } from './order-created.event';
import { messages, processingDuration } from './messaging.metrics';
import { DLQ, MAIN_QUEUE } from './topology';

const CONNECT_TIMEOUT_MS = 2000;
const CONFIRM_TIMEOUT_MS = 2000;
const DRAIN_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

// RabbitMQ records every dead-lettering in the x-death header. Rejections from the main queue are our failed attempts.
export function failedAttempts(msg: ConsumeMessage): number {
  const deaths: unknown = msg.properties.headers?.['x-death'];
  if (!Array.isArray(deaths)) return 0;
  return deaths
    .filter((d: { queue?: string; reason?: string }) => d.queue === MAIN_QUEUE && d.reason === 'rejected')
    .reduce((sum: number, d: { count?: unknown }) => sum + Number(d.count ?? 0), 0);
}

// Consumes order.created. Failure handling (engineering standards: Reliability):
//   malformed message      -> DLQ immediately (retrying cannot help)
//   transient failure      -> nack -> retry queue (TTL) -> main queue, up to MAX_ATTEMPTS, then DLQ
// The worker survives broker outages: it reconnects with capped backoff and reports not-ready meanwhile.
@Injectable()
export class ConsumerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(ConsumerService.name);
  private readonly url: string;
  private readonly prefetch: number;
  private readonly maxAttempts: number;
  private conn?: ChannelModel;
  private channel?: ConfirmChannel;
  private consumerTag?: string;
  private stopping = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    config: ConfigService<Env, true>,
    private readonly notifications: NotificationsService,
  ) {
    this.url = config.get('RABBITMQ_URL');
    this.prefetch = config.get('WORKER_PREFETCH');
    this.maxAttempts = config.get('MAX_ATTEMPTS');
  }

  isConnected(): boolean {
    return this.channel !== undefined && !this.stopping;
  }

  onApplicationBootstrap(): void {
    // Not awaited: a broker that is down at startup must not block the HTTP server or health endpoints.
    this.loop = this.run();
  }

  async handleMessage(ch: ConfirmChannel, msg: ConsumeMessage): Promise<void> {
    const started = process.hrtime.bigint();
    let outcome: string;
    try {
      outcome = (await this.notifications.record(parseOrderCreated(msg.content))) ? 'processed' : 'duplicate';
      ch.ack(msg);
    } catch (err) {
      outcome = await this.handleFailure(ch, msg, err);
    }
    messages.add(1, { outcome });
    processingDuration.record(Number(process.hrtime.bigint() - started) / 1e9, { outcome });
  }

  // Returns the outcome for the metrics: retried | dead_lettered | dead_letter_failed.
  private async handleFailure(ch: ConfirmChannel, msg: ConsumeMessage, err: unknown): Promise<string> {
    const cause = err instanceof Error ? err.message : String(err);
    const id = msg.properties.messageId ?? 'unknown';
    try {
      if (err instanceof PermanentError) {
        await this.deadLetter(ch, msg, `permanent failure: ${cause}`);
        return 'dead_lettered';
      }
      const attempts = failedAttempts(msg) + 1;
      if (attempts >= this.maxAttempts) {
        await this.deadLetter(ch, msg, `gave up after ${attempts} attempts: ${cause}`);
        return 'dead_lettered';
      }
      this.log.warn(`notification.retry messageId=${id} attempt=${attempts}/${this.maxAttempts} cause=${cause}`);
      ch.nack(msg, false, false);
      return 'retried';
    } catch (dlqErr) {
      // Could not dead-letter: use the delayed retry path rather than lose the message or hot-loop on it.
      this.log.error(`notification.dead_letter_failed messageId=${id} cause=${(dlqErr as Error).message}`);
      ch.nack(msg, false, false);
      return 'dead_letter_failed';
    }
  }

  private async deadLetter(ch: ConfirmChannel, msg: ConsumeMessage, reason: string): Promise<void> {
    const headers = Object.fromEntries(Object.entries(msg.properties.headers ?? {}).filter(([k]) => k !== 'x-death'));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DLQ publish confirm timed out')), CONFIRM_TIMEOUT_MS);
      ch.publish(
        '',
        DLQ,
        msg.content,
        {
          persistent: true,
          contentType: msg.properties.contentType,
          messageId: msg.properties.messageId,
          correlationId: msg.properties.correlationId,
          headers: { ...headers, 'x-failure-reason': reason, 'x-failed-attempts': failedAttempts(msg) + 1 },
        },
        (err) => {
          clearTimeout(timer);
          if (err) reject(err instanceof Error ? err : new Error(String(err)));
          else resolve();
        },
      );
    });
    ch.ack(msg);
    this.log.error(
      `notification.dead_lettered messageId=${msg.properties.messageId ?? 'unknown'} correlationId=${msg.properties.correlationId ?? 'unknown'} reason=${reason}`,
    );
  }

  private async run(): Promise<void> {
    let delay = 1000;
    while (!this.stopping) {
      const startedAt = Date.now();
      try {
        await this.consumeUntilClosed();
      } catch (err) {
        this.log.warn(`RabbitMQ consumer error: ${(err as Error).message}`);
      }
      if (this.stopping) break;
      // Reset the backoff after a healthy stretch; otherwise grow it up to the cap.
      delay = Date.now() - startedAt > 30_000 ? 1000 : Math.min(delay * 2, MAX_BACKOFF_MS);
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        sleep(delay).then(resolve, resolve);
      });
    }
  }

  private async consumeUntilClosed(): Promise<void> {
    const conn = await connect(this.url, { timeout: CONNECT_TIMEOUT_MS });
    // Without an error listener a broker-initiated error would crash the process.
    conn.on('error', (err) => this.log.warn(`RabbitMQ connection error: ${err.message}`));
    try {
      const ch = await conn.createConfirmChannel();
      ch.on('error', (err) => this.log.warn(`RabbitMQ channel error: ${err.message}`));
      // Either side closing (e.g. the queue was deleted) ends this session and triggers a reconnect.
      const closed = new Promise<void>((resolve) => {
        conn.once('close', resolve);
        ch.once('close', resolve);
      });
      await ch.prefetch(this.prefetch);
      const { consumerTag } = await ch.consume(MAIN_QUEUE, (msg) => {
        if (msg) this.track(this.handleMessage(ch, msg));
      });
      this.conn = conn;
      this.channel = ch;
      this.consumerTag = consumerTag;
      this.log.log(`Consuming ${MAIN_QUEUE} (prefetch=${this.prefetch}, maxAttempts=${this.maxAttempts})`);
      await closed;
      if (!this.stopping) this.log.warn('RabbitMQ session ended; reconnecting');
    } finally {
      this.conn = undefined;
      this.channel = undefined;
      this.consumerTag = undefined;
      await conn.close().catch((err: Error) => this.log.debug(`close after session end: ${err.message}`));
    }
  }

  private track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((err: Error) => this.log.error(`unhandled message error: ${err.message}`))
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  // Graceful shutdown (NFR-6): stop new deliveries, let in-flight messages finish, then close.
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    try {
      if (this.channel && this.consumerTag) await this.channel.cancel(this.consumerTag);
    } catch (err) {
      this.log.warn(`cancel consumer failed: ${(err as Error).message}`);
    }
    await Promise.race([Promise.allSettled([...this.inFlight]), sleep(DRAIN_TIMEOUT_MS)]);
    try {
      await this.conn?.close();
    } catch (err) {
      this.log.warn(`RabbitMQ close failed: ${(err as Error).message}`);
    }
    await this.loop;
  }
}
