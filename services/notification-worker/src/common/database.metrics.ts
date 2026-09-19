import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('platform-lab.database');

// OB-6: requests answered 503 because the database could not be reached.
const unavailable = meter.createCounter('database.unavailable.responses', {
  description: 'Requests answered 503 because the database was unreachable',
  unit: '{response}',
});

export const recordDatabaseUnavailable = (): void => unavailable.add(1);
