// Failure behavior of the async path against the real stack (AGENTS.md sections 17 and 28): retry, dead-lettering,
// replay, broker restarts and graceful shutdown of notification-worker.
// DISRUPTIVE: stops and restarts PostgreSQL, RabbitMQ and the worker of the local compose stack, and takes a few
// minutes. Not part of the regular test glob; run it on purpose:
//   node --test --test-reporter=spec --test-concurrency=1 tests/chaos/broker-failures.chaos.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { DLQ, MAIN_QUEUE, orderCreatedEvent, peek, publishEvent, queueInfo, repoRoot, takeMatching } from '../support/broker.mjs';
import { COMPOSE, docker, logsSince, psql, sleep, status } from '../support/compose.mjs';
import { call, eventually, IDS, registerUser, tokens, URLS } from '../support/stack.mjs';

const sql = (query) => psql('notification_worker', query);
const notificationCount = (eventId) => Number(sql(`SELECT count(*) FROM notifications WHERE event_id = '${eventId}'`));

const workerReady = () => status(`${URLS.worker}/health/ready`).then((s) => s === 200);
const waitWorkerReady = () => eventually(workerReady, { timeoutMs: 90_000, intervalMs: 1000 });
async function waitPostgres() {
  await eventually(async () => {
    try {
      docker('exec', '-T', 'postgres', 'pg_isready', '-q');
      return true;
    } catch {
      return false;
    }
  }, { timeoutMs: 60_000, intervalMs: 1000 });
}
async function waitBroker() {
  await eventually(() => queueInfo(MAIN_QUEUE).then((q) => q !== null, () => false), { timeoutMs: 90_000, intervalMs: 1000 });
}

describe('async path under failure', { concurrency: false }, () => {
  const dlqIds = new Set();

  before(() => docker('up', '-d', '--wait'));
  after(async () => {
    // Leave the stack as found, and remove only what this file dead-lettered.
    for (const service of ['postgres', 'rabbitmq', 'notification-worker']) docker('start', service);
    await waitPostgres();
    await waitBroker();
    await waitWorkerReady();
    if (dlqIds.size > 0) await takeMatching(DLQ, (m) => dlqIds.has(m.properties.message_id));
  });

  it('a transient database failure is retried after the delay and the notification is not lost', { timeout: 180_000 }, async () => {
    docker('stop', 'postgres');
    const since = new Date().toISOString();
    const event = await publishEvent(orderCreatedEvent());
    await sleep(3000); // first attempt fails while the database is down
    docker('start', 'postgres');
    await waitPostgres();

    await eventually(() => notificationCount(event.eventId) === 1, { timeoutMs: 90_000, intervalMs: 1000 });
    assert.match(logsSince('notification-worker', since), new RegExp(`notification\\.retry messageId=${event.eventId} attempt=1/3`));
    assert.equal((await peek(DLQ)).some((m) => m.properties.message_id === event.eventId), false, 'a recovered message must not be dead-lettered');
  });

  it('a failure that outlasts the retry budget is dead-lettered with its reason, and the replay script recovers it', { timeout: 240_000 }, async () => {
    await waitWorkerReady();
    docker('stop', 'postgres');
    const event = await publishEvent(orderCreatedEvent());
    dlqIds.add(event.eventId);

    // 3 attempts, 10 s apart (retry queue TTL), then the DLQ.
    const dead = await eventually(async () => (await peek(DLQ)).find((m) => m.properties.message_id === event.eventId) ?? null, { timeoutMs: 120_000, intervalMs: 2000 });
    assert.match(dead.properties.headers['x-failure-reason'], /^gave up after 3 attempts: /);
    assert.equal(dead.properties.headers['x-failed-attempts'], 3);
    assert.equal(dead.properties.correlation_id, event.correlationId);
    assert.equal(JSON.parse(dead.payload).eventId, event.eventId, 'the original message is preserved for replay');

    docker('start', 'postgres');
    await waitPostgres();
    await waitWorkerReady();
    execFileSync('sh', ['scripts/replay-dlq.sh'], { cwd: repoRoot, stdio: 'pipe' }); // the runbook's recovery step
    await eventually(() => notificationCount(event.eventId) === 1, { timeoutMs: 60_000, intervalMs: 1000 });
    assert.equal((await peek(DLQ)).some((m) => m.properties.message_id === event.eventId), false, 'replay empties the DLQ of it');
  });

  it('messages survive a broker restart while the worker is down, and are processed once it is back', { timeout: 240_000 }, async () => {
    docker('stop', 'notification-worker');
    const events = [];
    for (let i = 0; i < 5; i++) events.push(await publishEvent(orderCreatedEvent()));
    const mine = async () => (await peek(MAIN_QUEUE)).filter((m) => events.some((e) => e.eventId === m.properties.message_id)).length;
    assert.equal(await mine(), 5);

    docker('restart', 'rabbitmq');
    await waitBroker();
    assert.equal(await mine(), 5, 'persistent messages in a durable queue survive a broker restart');

    docker('start', 'notification-worker');
    await waitWorkerReady();
    for (const e of events) await eventually(() => notificationCount(e.eventId) === 1, { timeoutMs: 60_000, intervalMs: 1000 });
  });

  it('a broker restart while the worker runs: it reports not-ready, reconnects by itself and consumes again', { timeout: 240_000 }, async () => {
    await waitWorkerReady();
    let sawNotReady = false;
    const restart = spawn('docker', [...COMPOSE, 'restart', 'rabbitmq'], { cwd: repoRoot, stdio: 'ignore' });
    const finished = new Promise((r) => restart.on('exit', r));
    let done = false;
    finished.then(() => (done = true));
    while (!done) {
      if (!(await workerReady())) sawNotReady = true;
      await sleep(250);
    }
    await waitBroker();
    await waitWorkerReady(); // no restart of the worker: it reconnected on its own
    assert.ok(sawNotReady, 'readiness must reflect that the worker is not consuming');

    const event = await publishEvent(orderCreatedEvent());
    await eventually(() => notificationCount(event.eventId) === 1, { timeoutMs: 60_000, intervalMs: 1000 });
  });

  it('SIGTERM while busy: exits cleanly (code 0), loses nothing and duplicates nothing', { timeout: 300_000 }, async () => {
    const N = 3000;
    const userId = randomUUID(); // tags this run's notifications
    docker('stop', 'notification-worker');
    const events = Array.from({ length: N }, () => orderCreatedEvent({ userId }));
    for (let i = 0; i < N; i += 25) await Promise.all(events.slice(i, i + 25).map(publishEvent));

    docker('start', 'notification-worker');
    const count = () => Number(sql(`SELECT count(*) FROM notifications WHERE user_id = '${userId}'`));
    await eventually(() => count() >= 50, { timeoutMs: 60_000, intervalMs: 100 });
    docker('stop', 'notification-worker'); // SIGTERM, 10 s grace (compose default)

    const container = docker('ps', '-a', '-q', 'notification-worker').trim();
    const exitCode = execFileSync('docker', ['inspect', '-f', '{{.State.ExitCode}}', container], { encoding: 'utf8' }).trim();
    assert.equal(exitCode, '0', 'a graceful shutdown drains in-flight messages and exits 0 (137 would mean it was killed)');
    const atStop = count();
    assert.ok(atStop > 0 && atStop < N, `the stop must land mid-run to prove anything (processed ${atStop} of ${N})`);

    docker('start', 'notification-worker');
    await waitWorkerReady();
    await eventually(() => count() === N, { timeoutMs: 120_000, intervalMs: 1000 });
    assert.equal(Number(sql(`SELECT count(DISTINCT event_id) FROM notifications WHERE user_id = '${userId}'`)), N, 'no duplicates');
    await eventually(async () => {
      const q = await queueInfo(MAIN_QUEUE);
      return q.messages === 0 && q.messages_unacknowledged === 0;
    }, { timeoutMs: 30_000, intervalMs: 1000 });
  });

  it('broker down at publish: the order is still accepted, the failure is logged, and publishing resumes on its own', { timeout: 240_000 }, async () => {
    const t = await tokens();
    await registerUser(t.admin, { id: IDS.customer, email: 'dev-customer@example.invalid', name: 'Dev Customer' });
    const place = () =>
      call('POST', `${URLS.gateway}/v1/orders`, { token: t.customer, headers: { 'idempotency-key': randomUUID() }, body: { userId: IDS.customer, amount: 7, description: 'broker down' } });
    const notificationsOf = async (orderId) => (await call('GET', `${URLS.gateway}/v1/notifications?orderId=${orderId}`, { token: t.admin })).body;

    docker('stop', 'rabbitmq');
    const since = new Date().toISOString();
    const lost = await place();
    assert.equal(lost.status, 201, 'the order is committed before publishing (ADR-001), so a broker outage must not fail it');
    assert.match(logsSince('order-service', since), new RegExp(`order\.publish_failed orderId=${lost.body.id}`));

    docker('start', 'rabbitmq');
    await waitBroker();
    await waitWorkerReady();
    // Known limitation (ADR-001): there is no outbox, so the event of that order is gone for good.
    await sleep(3000);
    assert.deepEqual(await notificationsOf(lost.body.id), []);

    // The publisher reconnects by itself on the next publish.
    const next = await eventually(async () => {
      const res = await place();
      return res.status === 201 ? res : null;
    }, { timeoutMs: 60_000, intervalMs: 2000 });
    await eventually(async () => (await notificationsOf(next.body.id)).length === 1, { timeoutMs: 60_000, intervalMs: 1000 });
  });

  it('after all of that, every service recovered on its own and the smoke test passes', { timeout: 300_000 }, async () => {
    docker('up', '-d', '--wait');
    for (const url of [URLS.user, URLS.order, URLS.worker, URLS.gateway]) {
      await eventually(async () => (await status(`${url}/health/ready`)) === 200, { timeoutMs: 90_000, intervalMs: 2000 });
    }
    execFileSync('sh', ['scripts/smoke-test.sh', URLS.user, URLS.order, URLS.worker, URLS.gateway], { cwd: repoRoot, stdio: 'pipe' });
  });
});
