export type AutomationTemplateValues = Record<string, string | null | undefined>;
export type AutomationLinkRequirements = { invoiceLink: boolean; portalLink: boolean };
export type GeneratedAutomationLinks = { invoiceLink?: string | null; portalLink?: string | null };
export type AutomationLinkResolver = (requirements: AutomationLinkRequirements) => Promise<GeneratedAutomationLinks>;

/** Resolve generated links before replacing template variables. */
export async function renderAutomationTemplate(
  body: string,
  values: AutomationTemplateValues,
  resolveLinks: AutomationLinkResolver,
): Promise<string> {
  const requirements: AutomationLinkRequirements = {
    invoiceLink: /{{\s*invoice_link\s*}}/.test(body),
    portalLink: /{{\s*portal_link\s*}}/.test(body),
  };
  const links = requirements.invoiceLink || requirements.portalLink
    ? await resolveLinks(requirements)
    : {};

  return body.replace(/{{\s*([a-z_]+)\s*}}/g, (_match, key: string) => {
    if (key === "invoice_link") return links.invoiceLink ?? "";
    if (key === "portal_link") return links.portalLink ?? "";
    return values[key] ?? "";
  });
}
