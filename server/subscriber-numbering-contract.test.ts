import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("subscriber numbering/contact contract", () => {
  const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260916190000_enforce_subscriber_phone_required.sql"), "utf8");

  it("requires phone at the database boundary", () => {
    expect(migration).toContain("alter column phone set not null");
    expect(migration).toContain("subscribers_phone_required_check");
  });

  it("keeps WhatsApp optional", () => {
    expect(migration).toContain("whatsapp_number is optional");
    expect(migration).toContain("comment on column public.subscribers.whatsapp_number");
  });
});
