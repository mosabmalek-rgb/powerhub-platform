import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSupabaseMigrationFile } from "./supabase-migration-file.mjs";
import {
  assertSupabaseMigrationTarget,
  buildSupabaseMigrationLedgerInsert,
  assertSupabaseMigrationFileInventory,
  assertSupabaseMigrationReleaseVersionIsUnique,
  classifySupabaseMigrationHistory,
  computeSupabaseMigrationContentSha256,
  parseSupabaseMigrationHistoryRows,
  SUPABASE_PROJECT_BY_TARGET,
} from "./supabase-migration-target.mjs";

function directUri(projectRef, suffix = "") {
  return `postgresql://postgres:secret%2Fpassword@db.${projectRef}.supabase.co:5432/postgres${suffix}`;
}

function poolerUri(projectRef, suffix = "") {
  return `postgresql://postgres.${projectRef}:secret%40password@aws-0-us-east-1.pooler.supabase.com:5432/postgres${suffix}`;
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

  it("accepts project-bound session pooler URIs for both targets", () => {
    for (const target of ["staging", "production"]) {
      const ref = SUPABASE_PROJECT_BY_TARGET[target];
      expect(assertSupabaseMigrationTarget({
        target, projectRef: ref, databaseUrl: poolerUri(ref, "?sslmode=require"),
      })).toEqual({ projectRef: ref, hostname: "aws-0-us-east-1.pooler.supabase.com" });
    }
  });

  it("rejects cross-project pooler credentials, transaction mode, and URI overrides", () => {
    const ref = SUPABASE_PROJECT_BY_TARGET.staging;
    const other = SUPABASE_PROJECT_BY_TARGET.production;
    for (const uri of [
      poolerUri(other),
      poolerUri(ref).replace(`postgres.${ref}`, `postgres.${other}`),
      poolerUri(ref).replace(":5432/", ":6543/"),
      poolerUri(ref).replace("aws-0-us-east-1.pooler.supabase.com", "other.example.com"),
      poolerUri(ref).replace("secret%40password", "secret@password"),
      poolerUri(ref, "?host=other.example.com"),
    ]) {
      expect(() => assertSupabaseMigrationTarget({
        target: "staging", projectRef: ref, databaseUrl: uri,
      })).toThrow();
    }
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
    })).toThrow("SUPABASE_DB_URL host and username must match");
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
    })).toThrow("host and username must match");
    expect(() => assertSupabaseMigrationTarget({
      target: "production",
      projectRef: SUPABASE_PROJECT_BY_TARGET.production,
      databaseUrl: "postgresql://bad host",
    })).toThrow("not a valid PostgreSQL");
  });
});


describe("Supabase migration ledger SQL payload persistence", () => {
  it("stores exact UTF-8 SQL safely, including quotes, backslashes, Arabic text and mixed line endings", () => {
    const sql = "select 'quoted';\n-- path \\ segment\nselect 'مرحبا';\r\n";
    const encoded = Buffer.from(sql, "utf8").toString("base64");
    expect(buildSupabaseMigrationLedgerInsert({
      version: "20261107150951",
      name: "powerhub_public_default_privilege_hardening",
      sql,
    })).toBe(
      "INSERT INTO supabase_migrations.schema_migrations (version, name, statements)\n" +
      "VALUES ('20261107150951', 'powerhub_public_default_privilege_hardening', " +
      "ARRAY[convert_from(decode('" + encoded + "', 'base64'), 'UTF8')]);",
    );
  });

  it("rejects malformed identifiers and empty SQL", () => {
    expect(() => buildSupabaseMigrationLedgerInsert({
      version: "latest", name: "valid_name", sql: "select 1;",
    })).toThrow(/valid 14-digit version/i);
    expect(() => buildSupabaseMigrationLedgerInsert({
      version: "20261107150951", name: "Invalid-Name", sql: "select 1;",
    })).toThrow(/snake_case name/i);
    expect(() => buildSupabaseMigrationLedgerInsert({
      version: "20261107150951", name: "valid_name", sql: "   ",
    })).toThrow(/non-empty SQL/i);
  });
});

describe("Supabase migration history row parser", () => {
  it("parses migration rows with exact retained SQL SHA-256 values using LF and CRLF", () => {
    const firstSql = "select 1;\n";
    const secondSql = "select 2;\n";
    const first = "20261107150951|powerhub_public_default_privilege_hardening|" +
      computeSupabaseMigrationContentSha256(firstSql);
    const second = "20261106224902|powerhub_payment_delta_purpose_projection|" +
      computeSupabaseMigrationContentSha256(secondSql);
    const expected = [
      { version: "20261107150951", name: "powerhub_public_default_privilege_hardening", contentSha: computeSupabaseMigrationContentSha256(firstSql) },
      { version: "20261106224902", name: "powerhub_payment_delta_purpose_projection", contentSha: computeSupabaseMigrationContentSha256(secondSql) },
    ];
    expect(parseSupabaseMigrationHistoryRows(first + "\n" + second)).toEqual(expected);
    expect(parseSupabaseMigrationHistoryRows(first + "\r\n" + second + "\r\n")).toEqual(expected);
    expect(parseSupabaseMigrationHistoryRows("20261107150951|powerhub_public_default_privilege_hardening|unavailable")[0].contentSha)
      .toBe("unavailable");
    expect(parseSupabaseMigrationHistoryRows("")).toEqual([]);
  });

  it("rejects malformed rows rather than silently accepting partial history", () => {
    const validSha = computeSupabaseMigrationContentSha256("select 1;");
    expect(() => parseSupabaseMigrationHistoryRows("bad-version|migration|" + validSha)).toThrow(/14-digit version/i);
    expect(() => parseSupabaseMigrationHistoryRows("20261107150951|migration")).toThrow(/unexpected row/i);
    expect(() => parseSupabaseMigrationHistoryRows("20261107150951|migration|not-a-sha")).toThrow(/SHA-256/i);
    expect(() => parseSupabaseMigrationHistoryRows("20261107150951|invalid-name!|" + validSha)).toThrow(/migration name/i);
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

  it("treats an exact version/name/content record as already applied", () => {
    expect(classifySupabaseMigrationHistory({
      ...candidate,
      records: [stored(candidate.version, candidate.name)],
    })).toBe("already-applied");
  });

  it("allows a migration only when neither its version nor name exists", () => {
    expect(classifySupabaseMigrationHistory({
      ...candidate,
      records: [stored("20261106224902", "powerhub_payment_delta_purpose_projection")],
    })).toBe("not-applied");
  });

  it("blocks an exact version/name record whose stored SQL content differs", () => {
    expect(() => classifySupabaseMigrationHistory({
      ...candidate,
      records: [stored(candidate.version, candidate.name, "select 2;\n")],
    })).toThrow(/different SQL content/i);
  });

  it("blocks an exact identity whose historical SQL payload is unavailable", () => {
    expect(() => classifySupabaseMigrationHistory({
      ...candidate,
      records: [{ version: candidate.version, name: candidate.name, contentSha: "unavailable" }],
    })).toThrow(/payload is unavailable/i);
  });

  it("blocks a version already recorded under a different name", () => {
    expect(() => classifySupabaseMigrationHistory({
      ...candidate,
      records: [stored(candidate.version, "another_migration")],
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

  it("rejects malformed migration release identifiers and missing content hashes", () => {
    for (const version of ["latest", "2026110715095", "202611071509510", "2026110715095a"]) {
      expect(() => classifySupabaseMigrationHistory({
        ...candidate, version, records: [],
      })).toThrow(/valid 14-digit version/i);
    }
    expect(() => classifySupabaseMigrationHistory({
      ...candidate, contentSha: "bad-hash", records: [],
    })).toThrow(/SHA-256 hash/i);
  });

  it("computes SHA-256 from the exact UTF-8 SQL bytes", () => {
    expect(computeSupabaseMigrationContentSha256("hello\n"))
      .toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");
  });
});


const pinnedHistoricalMigrationFiles = [
  "0010_fix_subscriber_create_rpc_ambiguity.sql",
  "0010_powerhub_update_subscriber_rpc.sql",
  "0060_admin_subscription_upgrade_enrichment_rpc.sql",
  "0060_powerhub_request_owner_access_recovery.sql",
  "20260916190000_enforce_subscriber_phone_required.sql",
  "20260916190000_powerhub_owner_subscription_main_site.sql",
  "20260922123000_powerhub_unified_field_user_guard.sql",
  "20260922123000_powerhub_unified_field_user_policy.sql",
  "20260926123000_powerhub_advanced_dashboard_synchronization.sql",
  "20260926123000_powerhub_upgrade_review_hardening.sql",
  "20261013170000_powerhub_fix_sms_claim_tenant_id_ambiguity.sql",
  "20261013170000_powerhub_unified_message_history_filters.sql",
];

describe("Supabase migration source inventory guard", () => {
  it("accepts only the exact pinned historical collision groups", () => {
    expect(assertSupabaseMigrationFileInventory([
      ...pinnedHistoricalMigrationFiles,
      "20261107120000_powerhub_inventory_supplier_site_rls_scope.sql",
    ])).toEqual({
      fileCount: 13,
      uniqueVersionCount: 7,
      historicalCollisionCount: 6,
    });
  });

  it("rejects a new duplicate 14-digit version anywhere in the source inventory", () => {
    expect(() => assertSupabaseMigrationFileInventory([
      ...pinnedHistoricalMigrationFiles,
      "20261107120000_new_migration_a.sql",
      "20261107120000_new_migration_b.sql",
    ])).toThrow(/Unapproved duplicate migration version 20261107120000/i);
  });

  it("rejects deletion or renaming of a pinned historical collision member", () => {
    const changedInventory = pinnedHistoricalMigrationFiles.filter(
      (filename) => filename !== "20260916190000_enforce_subscriber_phone_required.sql",
    );
    expect(() => assertSupabaseMigrationFileInventory(changedInventory))
      .toThrow(/Pinned historical migration collision 20260916190000 changed/i);
  });

  it("rejects malformed filenames in the complete local inventory", () => {
    expect(() => assertSupabaseMigrationFileInventory([
      ...pinnedHistoricalMigrationFiles,
      "not-a-versioned-migration.sql",
    ])).toThrow(/Invalid migration filename/i);
  });

  it("blocks releasing any candidate whose version is shared by another local file", () => {
    const candidate = "20260916190000_enforce_subscriber_phone_required.sql";
    expect(() => assertSupabaseMigrationReleaseVersionIsUnique({
      filename: candidate,
      migrationFiles: pinnedHistoricalMigrationFiles,
    })).toThrow(/cannot be released while local files share version 20260916190000/i);
  });

  it("accepts a selected candidate only when it is present and its version is unique", () => {
    const candidate = "20261107120000_powerhub_inventory_supplier_site_rls_scope.sql";
    expect(assertSupabaseMigrationReleaseVersionIsUnique({
      filename: candidate,
      migrationFiles: [...pinnedHistoricalMigrationFiles, candidate],
    })).toBe("20261107120000");
  });

  it("rejects a selected migration absent from the validated source inventory", () => {
    expect(() => assertSupabaseMigrationReleaseVersionIsUnique({
      filename: "20261107120000_missing.sql",
      migrationFiles: pinnedHistoricalMigrationFiles,
    })).toThrow(/not present in the validated source inventory/i);
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

