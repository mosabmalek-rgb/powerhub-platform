const incrementalAutomaticEvents = new Set(["subscriber_created", "payment_received", "invoice_overdue"]);

export function isIncrementalAutomaticEvent(eventType: string): boolean {
  return incrementalAutomaticEvents.has(eventType);
}

/**
 * Automatic event scans run in minute buckets for events that must be
 * processed promptly, including due-hour invoice reminder thresholds.
 * Scheduled broadcasts and recurring reminders retain their daily uniqueness window.
 */
export function buildAutomaticOccurrenceKey(eventType: string, now: Date): string {
  const bucket = isIncrementalAutomaticEvent(eventType)
    ? String(Math.floor(now.getTime() / 60_000))
    : now.toISOString().slice(0, 10);
  return "event:" + eventType + ":" + bucket;
}

/**
 * Returns true only after an invoice's due timestamp plus the configured
 * delay has passed and its current outstanding balance meets the optional
 * minimum. Timestamps are compared as absolute instants, independent of host TZ.
 */
export function isInvoiceOverdueEligible(input: {
  dueDate: string | Date | null | undefined;
  balanceDue: number | string | null | undefined;
  now: Date;
  afterDueHours: number;
  minBalance?: number | null;
}): boolean {
  if (input.dueDate == null) return false;
  const dueTimestamp = input.dueDate instanceof Date
    ? input.dueDate.getTime()
    : Date.parse(input.dueDate);
  const balance = Number(input.balanceDue);
  if (!Number.isFinite(dueTimestamp) || !Number.isFinite(balance) || balance <= 0) return false;
  if (!Number.isFinite(input.afterDueHours) || input.afterDueHours < 0) return false;
  if (input.now.getTime() < dueTimestamp + input.afterDueHours * 60 * 60 * 1000) return false;
  if (input.minBalance != null && (!Number.isFinite(input.minBalance) || balance < input.minBalance)) return false;
  return true;
}


/** Stable once-per-invoice key for unscheduled overdue reminders; scheduled runs
 * retain the occurrence suffix so intentionally recurring reminders remain distinct. */
export function buildInvoiceOverdueOperationKey(
  automationId: number | string,
  invoiceId: number | string,
  occurrenceKey: string,
  automaticUnscheduled: boolean,
): string {
  return `automation:${automationId}:invoice:${invoiceId}:${automaticUnscheduled ? "eligible" : occurrenceKey}`;
}
