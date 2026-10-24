import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../supabase/migrations/20261024210000_powerhub_offline_write_acl_hardening.sql",
  import.meta.url,
);
const readMigration = () => readFile(migrationUrl, "utf8");

describe("offline server-write ACL hardening migration", () => {
  it("revokes direct write privileges from public browser roles on core records", async () => {
    const migration = await readMigration();
    expect(migration).toMatch(
      /revoke\s+insert,\s*update,\s*delete,\s*truncate\s+on table\s+public\.invoices,\s*public\.offline_sync_operations,\s*public\.payments,\s*public\.subscribers\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
  });

  it("revokes direct execution of subscriber update and payment approval RPCs", async () => {
    const migration = await readMigration();
    expect(migration).toMatch(
      /revoke\s+execute\s+on function\s+public\.powerhub_update_subscriber\s*\(\s*bigint,\s*bigint,\s*bigint,\s*bigint,\s*text,\s*text,\s*text,\s*text,\s*text,\s*timestamptz,\s*uuid\s*\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
    expect(migration).toMatch(
      /revoke\s+execute\s+on function\s+public\.powerhub_approve_payment_documentation\s*\(\s*bigint,\s*bigint,\s*bigint,\s*bigint\s*\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
  });

  it("does not replace the audited server path with browser-role write grants", async () => {
    const migration = await readMigration();
    expect(migration).not.toMatch(/grant\s+(?:insert|update|delete|truncate|all)\b/i);
    expect(migration).not.toMatch(/grant\s+execute\s+on function\b/i);
  });
});
