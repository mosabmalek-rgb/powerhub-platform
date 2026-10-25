import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSupabaseMigrationFile } from "./supabase-migration-file.mjs";
import { assertSupabaseMigrationTarget, SUPABASE_PROJECT_BY_TARGET } from "./supabase-migration-target.mjs";

function directUri(projectRef, suffix = "") {
  return `postgresql://postgres:secret%2Fpassword@db.${projectRef}.supabase.co:5432/postgres${suffix}`;
}

describe("Supabase migration release target guard", () => {
  it("accepts the matching direct database URI for staging", () => {
    expect(assertSupabaseMigrationTarget({
      target: "staging",
      projectRef: SUPABASE_PROJECT_BY_TARGET.staging,
      databaseUrl: directUri(SUPABASE_PROJECT_BY_TARGET.staging, "?sslmode=require"),
    })).toEqual({
      projectRef: SUPABASE_PROJECT_BY_TARGET.staging,
      hostname: `db.${SUPABASE_PROJECT_BY_TARGET.staging}.supabase.co`,
    });
  });

  it("rejects a project reference secret for the wrong environment", () => {
    expect(() => assertSupabaseMigrationTarget({
      target: "staging",
      projectRef: SUPABASE_PROJECT_BY_TARGET.production,
      databaseUrl: directUri(SUPABASE_PROJECT_BY_TARGET.staging),
    })).toThrow("SUPABASE_PROJECT_REF does not match");
  });

  it("rejects a connection URI that points to another project even if the ref secret matches", () => {
    expect(() => assertSupabaseMigrationTarget({
      target: "staging",
      projectRef: SUPABASE_PROJECT_BY_TARGET.staging,
      databaseUrl: directUri(SUPABASE_PROJECT_BY_TARGET.production),
    })).toThrow("SUPABASE_DB_URL host must match");
  });

  it("rejects non-postgres databases and malformed connection strings without leaking credentials", () => {
    expect(() => assertSupabaseMigrationTarget({
      target: "production",
      projectRef: SUPABASE_PROJECT_BY_TARGET.production,
      databaseUrl: directUri(SUPABASE_PROJECT_BY_TARGET.production).replace(/\/postgres(?=\?|$)/, "/other"),
    })).toThrow("must target the postgres database");
    expect(() => assertSupabaseMigrationTarget({
      target: "production",
      projectRef: SUPABASE_PROJECT_BY_TARGET.production,
      databaseUrl: "postgresql://secret-password",
    })).toThrow("host must match");
    expect(() => assertSupabaseMigrationTarget({
      target: "production",
      projectRef: SUPABASE_PROJECT_BY_TARGET.production,
      databaseUrl: "postgresql://bad host",
    })).toThrow("not a valid PostgreSQL");
  });
});


describe("Supabase migration release file path guard", () => {
  let temporaryRoot;
  let repositoryRoot;
  let migrationRoot;
  let validMigration;
  let outsideMigration;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "powerhub-migration-guard-"));
    repositoryRoot = path.join(temporaryRoot, "repo");
    migrationRoot = path.join(repositoryRoot, "supabase", "migrations");
    validMigration = path.join(migrationRoot, "20261025030000_safe_example.sql");
    outsideMigration = path.join(repositoryRoot, "outside", "20261025040000_outside_example.sql");
    await mkdir(migrationRoot, { recursive: true });
    await mkdir(path.dirname(outsideMigration), { recursive: true });
    await writeFile(validMigration, "select 1;\n", "utf8");
    await writeFile(outsideMigration, "select 2;\n", "utf8");
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("accepts an existing regular migration directly inside the repository migration directory", async () => {
    await expect(resolveSupabaseMigrationFile({
      repositoryRoot, migrationRoot, requestedPath: validMigration,
    })).resolves.toBe(validMigration);
  });

  it("rejects traversal and files outside the migration directory", async () => {
    await expect(resolveSupabaseMigrationFile({
      repositoryRoot, migrationRoot, requestedPath: outsideMigration,
    })).rejects.toThrow(/top-level file directly inside supabase\/migrations/i);
    await expect(resolveSupabaseMigrationFile({
      repositoryRoot,
      migrationRoot,
      requestedPath: path.join(migrationRoot, "nested", "20261025050000_nested_example.sql"),
    })).rejects.toThrow(/top-level file directly inside supabase\/migrations/i);
  });

  it("rejects a symlinked SQL target even when its filename resembles a migration", async () => {
    const symlinkedMigration = path.join(migrationRoot, "20261025060000_linked_example.sql");
    await symlink(outsideMigration, symlinkedMigration);
    await expect(resolveSupabaseMigrationFile({
      repositoryRoot, migrationRoot, requestedPath: symlinkedMigration,
    })).rejects.toThrow(/regular non-symlink file/i);
  });

  it("rejects a substituted migration root outside the repository", async () => {
    await expect(resolveSupabaseMigrationFile({
      repositoryRoot,
      migrationRoot: path.dirname(outsideMigration),
      requestedPath: outsideMigration,
    })).rejects.toThrow(/repository's supabase\/migrations directory/i);
  });
});
