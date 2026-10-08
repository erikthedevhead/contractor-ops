/** Queue names. Kept in one place so producers and the worker can't drift. */
export const Q = {
  webhookEvent: 'qbo.webhook-event',   // payload: { eventRowId }
  initialSync: 'qbo.initial-sync',     // payload: {}
  reconcile: 'qbo.cdc-reconcile',      // payload: {}
} as const;

export type QueueName = (typeof Q)[keyof typeof Q];
