import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('platform-lab.orders');

export const ordersCreated = meter.createCounter('orders.created', { description: 'Orders stored', unit: '{order}' });

// ADR-001 known limitation made visible: the order is stored but its event never reached the broker.
export const eventPublishFailures = meter.createCounter('order.events.publish.failures', {
  description: 'order.created events that could not be published',
  unit: '{event}',
});

// outcome: cache_hit | found | not_found | unavailable
export const userLookups = meter.createCounter('user.lookups', { description: 'User existence lookups by outcome', unit: '{lookup}' });

// operation: get | set; outcome: hit | miss | error | ok
export const cacheOperations = meter.createCounter('cache.operations', { description: 'Redis cache operations by outcome', unit: '{operation}' });
