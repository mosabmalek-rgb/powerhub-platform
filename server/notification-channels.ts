export type InvoiceNotificationChannel = "whatsapp" | "sms";

type MessagingConfiguration = {
  channel: InvoiceNotificationChannel;
  isActive: boolean;
};

/**
 * Produces one queued invoice notification for every active tenant channel.
 * The WhatsApp fallback preserves the existing local queue behaviour until a
 * tenant configures one or both provider channels.
 */
export function resolveInvoiceNotificationChannels(
  configurations: readonly MessagingConfiguration[],
): InvoiceNotificationChannel[] {
  const channels = Array.from(
    new Set(
      configurations
        .filter((configuration) => configuration.isActive)
        .map((configuration) => configuration.channel),
    ),
  );

  return channels.length ? channels : ["whatsapp"];
}
