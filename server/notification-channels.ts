export type InvoiceNotificationChannel = "whatsapp" | "sms";

type MessagingConfiguration = {
  channel: InvoiceNotificationChannel;
  isActive: boolean;
};

export type InvoiceDeliveryPolicy = {
  isEnabled: boolean;
  whatsappEnabled: boolean;
  smsEnabled: boolean;
};

export const defaultInvoiceDeliveryPolicy: InvoiceDeliveryPolicy = {
  isEnabled: true,
  whatsappEnabled: true,
  smsEnabled: true,
};

export function invoiceDeliveryPolicyFromSetting(setting?: { isEnabled: boolean; value?: unknown } | null): InvoiceDeliveryPolicy {
  if (!setting) return defaultInvoiceDeliveryPolicy;
  const value = setting.value && typeof setting.value === "object" && !Array.isArray(setting.value)
    ? setting.value as Record<string, unknown>
    : {};
  return {
    isEnabled: setting.isEnabled,
    whatsappEnabled: value.whatsappEnabled !== false,
    smsEnabled: value.smsEnabled !== false,
  };
}

export function isInvoiceDeliveryChannelEnabled(channel: InvoiceNotificationChannel, policy: InvoiceDeliveryPolicy = defaultInvoiceDeliveryPolicy) {
  return policy.isEnabled && (channel === "whatsapp" ? policy.whatsappEnabled : policy.smsEnabled);
}

/**
 * Produces one queued invoice notification for every tenant channel that is
 * enabled locally and allowed centrally by the platform administrator.
 */
export function resolveInvoiceNotificationChannels(
  configurations: readonly MessagingConfiguration[],
  policy: InvoiceDeliveryPolicy = defaultInvoiceDeliveryPolicy,
): InvoiceNotificationChannel[] {
  if (!policy.isEnabled) return [];
  const channels = Array.from(
    new Set(
      configurations
        .filter((configuration) => configuration.isActive && isInvoiceDeliveryChannelEnabled(configuration.channel, policy))
        .map((configuration) => configuration.channel),
    ),
  );

  return channels.length ? channels : (isInvoiceDeliveryChannelEnabled("whatsapp", policy) ? ["whatsapp"] : []);
}
