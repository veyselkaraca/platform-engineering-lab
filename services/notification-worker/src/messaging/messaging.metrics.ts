import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('platform-lab.notifications');

// OB-5. outcome: processed | duplicate | retried | dead_lettered | dead_letter_failed
// (`reason` on dead_lettered: permanent | exhausted). Queue depth itself comes from the broker's own metrics.
export const messages = meter.createCounter('notification.messages', { description: 'order.created messages handled, by outcome', unit: '{message}' });

export const processingDuration = meter.createHistogram('notification.processing.duration', {
  description: 'Time to handle one message, from delivery to ack/nack',
  unit: 's',
});
