import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  "supabase/migrations/20261106150000_powerhub_private_storage_bucket_limits.sql",
);
const migration = readFileSync(migrationPath, "utf8");

describe("PowerHub private Storage bucket service-side limits", () => {
  it("preflights the existing private bucket and fails closed when it is missing", () => {
    expect(migration).toMatch(/to_regclass\('storage\.buckets'\)/i);
    expect(migration).toMatch(/POWERHUB_PRIVATE_STORAGE_BUCKET_MISSING/);
    expect(migration).toMatch(/where id = 'powerhub-private'/i);
  });

  it("enforces the 10 MiB limit and only the four server-validated MIME types", () => {
    expect(migration).toMatch(/file_size_limit\s*=\s*10485760/i);
    expect(migration).toMatch(/'image\/jpeg'/);
    expect(migration).toMatch(/'image\/png'/);
    expect(migration).toMatch(/'image\/webp'/);
    expect(migration).toMatch(/'application\/pdf'/);
    expect(migration).toMatch(/POWERHUB_STORAGE_FILE_SIZE_LIMIT_MISMATCH/);
    expect(migration).toMatch(/POWERHUB_STORAGE_MIME_ALLOW_LIST_MISMATCH/);
  });

  it("changes only bucket metadata and does not broaden object access", () => {
    expect(migration).not.toMatch(/storage\.objects/i);
    expect(migration).not.toMatch(/create\s+policy|drop\s+policy|grant\s+|revoke\s+/i);
    expect(migration).not.toMatch(/delete\s+from|truncate\s+|drop\s+table/i);
  });
});
