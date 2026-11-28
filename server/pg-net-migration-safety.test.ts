import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrations = path.resolve("supabase/migrations");
const installSql = readFileSync(
  path.join(
    migrations,
    "20260923130000_powerhub_supabase_cron_invoice_notifications.sql",
  ),
  "utf8",
);
const placementSql = readFileSync(
  path.join(
    migrations,
    "20260924180000_powerhub_move_pg_net_to_extensions.sql",
  ),
  "utf8",
);

describe("PowerHub pg_net migration safety", () => {
  it("installs new pg_net instances in the non-exposed extensions schema", () => {
    expect(installSql).toMatch(
      /create extension if not exists pg_net with schema extensions/i,
    );
    expect(installSql).toMatch(/create schema if not exists extensions/i);
  });

  it("does not hardcode an application origin or scheduled-route secret", () => {
    expect(installSql).not.toMatch(
      /powerhub-platform\.vercel\.app|\/api\/scheduled\/|powerhub_cron_secret|powerhub_app_base_url/i,
    );
  });

  it("does not create or alter scheduled jobs during migration", () => {
    expect(installSql).not.toMatch(/cron\s*\.\s*(?:schedule|unschedule)\s*\(/i);
    expect(placementSql).not.toMatch(/cron\s*\.\s*(?:schedule|unschedule)\s*\(/i);
  });

  it("checks placement without changing Supabase-managed extension ownership or grants", () => {
    expect(placementSql).toMatch(/pg_extension[\s\S]*extnamespace/i);
    expect(placementSql).toMatch(/raise warning/i);
    expect(placementSql).not.toMatch(/alter extension|revoke all|grant all/i);
    expect(placementSql).not.toMatch(
      /powerhub-platform\.vercel\.app|\/api\/scheduled\/|powerhub_cron_secret|powerhub_app_base_url/i,
    );
  });
});
