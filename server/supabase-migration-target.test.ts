import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSupabaseMigrationFile } from "../scripts/supabase-migration-file.mjs";
import { assertSupabaseMigrationTarget, classifySupabaseMigrationHistory, computeSupabaseMigrationContentSha256, parseSupabaseMigrationHistoryRows, SUPABASE_PROJECT_BY_TARGET } from "../scripts/supabase-migration-target.mjs";

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

  it("rejects URL options that disable TLS or permit an insecure fallback", () => {
    for (const mode of ["disable", "allow", "prefer", ""]) {
      expect(() => assertSupabaseMigrationTarget({
        target: "staging",
        projectRef: SUPABASE_PROJECT_BY_TARGET.staging,
        databaseUrl: directUri(SUPABASE_PROJECT_BY_TARGET.staging, `?sslmode=${mode}`),
      })).toThrow("must enforce TLS");
    }
    expect(assertSupabaseMigrationTarget({
      target: "staging",
      projectRef: SUPABASE_PROJECT_BY_TARGET.staging,
      databaseUrl: directUri(SUPABASE_PROJECT_BY_TARGET.staging, "?sslmode=verify-full"),
    }).hostname).toBe(`db.${SUPABASE_PROJECT_BY_TARGET.staging}.supabase.co`);
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


describe("Supabase migration history row parser", () => {
  it("parses rows with exact retained SQL SHA-256 values using LF and CRLF", () => {
    const sql1 = "select 1;\n";
    const sql2 = "select 2;\n";
    const first = "20261107150951|powerhub_public_default_privilege_hardening|" + computeSupabaseMigrationContentSha256(sql1);
    const second = "20261106224902|powerhub_payment_delta_purpose_projection|" + computeSupabaseMigrationContentSha256(sql2);
    const expected = [
      { version: "20261107150951", name: "powerhub_public_default_privilege_hardening", contentSha: computeSupabaseMigrationContentSha256(sql1) },
      { version: "20261106224902", name: "powerhub_payment_delta_purpose_projection", contentSha: computeSupabaseMigrationContentSha256(sql2) },
    ];
    expect(parseSupabaseMigrationHistoryRows(first + "\n" + second)).toEqual(expected);
    expect(parseSupabaseMigrationHistoryRows(first + "\r\n" + second + "\r\n")).toEqual(expected);
    expect(parseSupabaseMigrationHistoryRows("20261107150951|powerhub_public_default_privilege_hardening|unavailable")[0].contentSha).toBe("unavailable");
    expect(parseSupabaseMigrationHistoryRows("")).toEqual([]);
  });

  it("rejects malformed rows rather than silently accepting partial history", () => {
    const digest = computeSupabaseMigrationContentSha256("select 1;");
    expect(() => parseSupabaseMigrationHistoryRows("bad-version|migration|" + digest)).toThrow(/14-digit version/i);
    expect(() => parseSupabaseMigrationHistoryRows("20261107150951|migration")).toThrow(/unexpected row/i);
    expect(() => parseSupabaseMigrationHistoryRows("20261107150951|migration|bad-digest")).toThrow(/SHA-256/i);
  });
});

describe("Supabase migration history reconciliation guard", () => {
  const candidate = {
    version: "20261107150951",
    name: "powerhub_public_default_privilege_hardening",
    contentSha: computeSupabaseMigrationContentSha256("select 1;\n"),
  };
  const stored = (version, name, sql = "select 1;\n") => ({
    version, name, contentSha: computeSupabaseMigrationContentSha256(sql),
  });

  it("treats only an exact version/name/content record as already applied", () => {
    expect(classifySupabaseMigrationHistory({ ...candidate, records: [stored(candidate.version, candidate.name)] }))
      .toBe("already-applied");
  });

  it("allows a migration only when neither its version nor name exists", () => {
    expect(classifySupabaseMigrationHistory({
      ...candidate, records: [stored("20261106224902", "powerhub_payment_delta_purpose_projection")],
    })).toBe("not-applied");
  });

  it("blocks exact identity with changed stored SQL", () => {
    expect(() => classifySupabaseMigrationHistory({
      ...candidate, records: [stored(candidate.version, candidate.name, "select 2;\n")],
    })).toThrow(/different SQL content/i);
  });

  it("blocks exact identity when the stored SQL payload is unavailable", () => {
    expect(() => classifySupabaseMigrationHistory({
      ...candidate, records: [{ version: candidate.version, name: candidate.name, contentSha: "unavailable" }],
    })).toThrow(/payload is unavailable/i);
  });

  it("blocks a version already recorded under a different name", () => {
    expect(() => classifySupabaseMigrationHistory({
      ...candidate, records: [stored(candidate.version, "another_migration")],
    })).toThrow(/different name/i);
  });

  it("blocks a migration name already recorded under a different timestamp", () => {
    expect(() => classifySupabaseMigrationHistory({
      version: "20261022211000",
      name: "powerhub_fuel_event_append_only_acl",
      contentSha: computeSupabaseMigrationContentSha256("select 1;\n"),
      records: [stored("20261022131742", "powerhub_fuel_event_append_only_acl")],
    })).toThrow(/already recorded under version/i);
  });

  it("blocks duplicate migration names in a drifted ledger", () => {
    expect(() => classifySupabaseMigrationHistory({
      version: "20261101210000",
      name: "powerhub_image_retention_metadata",
      contentSha: computeSupabaseMigrationContentSha256("select 1;\n"),
      records: [
        stored("20261101200609", "powerhub_image_retention_metadata"),
        stored("20261102171227", "powerhub_image_retention_metadata"),
      ],
    })).toThrow(/appears more than once/i);
  });

  it("rejects malformed migration identifiers and missing content hashes", () => {
    for (const version of ["latest", "2026110715095", "202611071509510", "2026110715095a"]) {
      expect(() => classifySupabaseMigrationHistory({ ...candidate, version, records: [] }))
        .toThrow(/valid 14-digit version/i);
    }
    expect(() => classifySupabaseMigrationHistory({ ...candidate, contentSha: "bad-hash", records: [] }))
      .toThrow(/SHA-256 hash/i);
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
