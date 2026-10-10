const incrementalAutomaticEvents = new Set(["subscriber_created", "payment_received"]);

export function isIncrementalAutomaticEvent(eventType: string): boolean {
  return incrementalAutomaticEvents.has(eventType);
}

/**
 * Automatic event scans run in minute buckets for events that must be
 * processed promptly. Scheduled broadcasts and recurring reminders retain
 * their daily uniqueness window.
 */
export function buildAutomaticOccurrenceKey(eventType: string, now: Date): string {
  const bucket = isIncrementalAutomaticEvent(eventType)
    ? String(Math.floor(now.getTime() / 60_000))
    : now.toISOString().slice(0, 10);
  return "event:" + eventType + ":" + bucket;
}
