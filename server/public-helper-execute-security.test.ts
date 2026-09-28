import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("public helper EXECUTE boundary", () => {
  it("revokes direct browser execution for internal SMS/announcement helpers", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260928200000_revoke_public_helper_execute.sql"),
      "utf8",
    );

    expect(migration).toContain(
      "revoke all on function public.powerhub_next_invoice_sms_run(timestamptz, text, text, timestamptz) from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "revoke all on function public.powerhub_sync_sms_lease() from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "revoke all on function public.powerhub_touch_platform_announcement() from public, anon, authenticated;",
    );
  });
});
