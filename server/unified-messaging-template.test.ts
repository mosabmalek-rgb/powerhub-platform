import { describe, expect, it, vi } from "vitest";
import { renderAutomationTemplate } from "./unified-messaging-template";

describe("unified automation template rendering", () => {
  it("resolves generated link placeholders before rendering subscriber values", async () => {
    const resolveLinks = vi.fn().mockResolvedValue({
      invoiceLink: "https://powerhub.example/invoice/secret-token",
      portalLink: "https://powerhub.example/portal?g=GZ-1",
    });
    const rendered = await renderAutomationTemplate(
      "مرحباً {{subscriber_name}}، {{invoice_link}} | {{portal_link}}",
      { subscriber_name: "أحمد", invoice_no: "INV-5" },
      resolveLinks,
    );
    expect(resolveLinks).toHaveBeenCalledWith({ invoiceLink: true, portalLink: true });
    expect(rendered).toBe("مرحباً أحمد، https://powerhub.example/invoice/secret-token | https://powerhub.example/portal?g=GZ-1");
    expect(rendered).not.toMatch(/{{\s*(invoice_link|portal_link|subscriber_name)\s*}}/);
  });

  it("does not call the link resolver for templates without link placeholders", async () => {
    const resolveLinks = vi.fn();
    await expect(renderAutomationTemplate("مرحباً {{subscriber_name}}", { subscriber_name: "أحمد" }, resolveLinks))
      .resolves.toBe("مرحباً أحمد");
    expect(resolveLinks).not.toHaveBeenCalled();
  });

  it("clears a requested but unavailable link instead of leaving a raw token", async () => {
    const resolveLinks = vi.fn().mockResolvedValue({ invoiceLink: null, portalLink: "" });
    await expect(renderAutomationTemplate("{{invoice_link}}/{{portal_link}}", {}, resolveLinks)).resolves.toBe("/");
  });
});
