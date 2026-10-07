import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "server/_core/index.ts"), "utf8");

describe("HTTP security hardening contract", () => {
  it("sets baseline browser security headers and disables framework disclosure", () => {
    expect(source).toContain('app.disable("x-powered-by")');
    expect(source).toContain('X-Content-Type-Options');
    expect(source).toContain('Referrer-Policy');
    expect(source).toContain('X-Frame-Options');
    expect(source).toContain('Strict-Transport-Security');
  });

  it("bounds webhook payloads before the global upload parser", () => {
    expect(source).toContain('req.path.startsWith("/api/webhooks/whatsapp/")');
    expect(source).toContain("256 * 1024");
    expect(source).toContain("webhook_payload_too_large");
  });

  it("authenticates every scheduled job before rejecting non-POST methods", () => {
    const scheduledRoutes = source.match(/app\.all\("\/api\/scheduled\/[^"]+"/g) ?? [];
    const protectedPostChecks = source.match(/if \(req\.method !== "POST"\)/g) ?? [];
    expect(scheduledRoutes.length).toBeGreaterThanOrEqual(3);
    expect(protectedPostChecks.length).toBe(scheduledRoutes.filter((route) => !route.includes("/*")).length);
    expect(source).toContain('app.all("/api/scheduled/process-invoice-notifications"');
    expect(source).toContain('app.all("/api/scheduled/payment-documentation-retention"');
    expect(source).toContain('app.all("/api/scheduled/subscriber-retention"');
  });
});
