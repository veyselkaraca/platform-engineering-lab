import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('platform-lab.auth');

// IDN-7: refusals by reason (missing, expired, not_yet_valid, signature, issuer, audience, claims, malformed,
// keys_unavailable, role, not_owner). Low cardinality on purpose: no user ids, no routes.
const rejections = meter.createCounter('auth.rejections', {
  description: 'Requests refused by authentication or authorization, by reason',
  unit: '{rejection}',
});

export const recordAuthRejection = (reason: string): void => rejections.add(1, { reason });
