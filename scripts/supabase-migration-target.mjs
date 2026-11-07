import { createHash } from "node:crypto";

export const SUPABASE_PROJECT_BY_TARGET = Object.freeze({
  staging: "iyuryuhaylhisjfcrwkz",
  production: "vvcdiqcyhaloxesvpppc",
});

const PINNED_HISTORICAL_MIGRATION_VERSION_COLLISIONS = new Map([
  ["0010", [
    "0010_fix_subscriber_create_rpc_ambiguity.sql",
    "0010_powerhub_update_subscriber_rpc.sql",
  ]],
  ["0060", [
    "0060_admin_subscription_upgrade_enrichment_rpc.sql",
    "0060_powerhub_request_owner_access_recovery.sql",
  ]],
  ["20260916190000", [
    "20260916190000_enforce_subscriber_phone_required.sql",
    "20260916190000_powerhub_owner_subscription_main_site.sql",
  ]],
  ["20260922123000", [
    "20260922123000_powerhub_unified_field_user_guard.sql",
    "20260922123000_powerhub_unified_field_user_policy.sql",
  ]],
  ["20260926123000", [
    "20260926123000_powerhub_advanced_dashboard_synchronization.sql",
    "20260926123000_powerhub_upgrade_review_hardening.sql",
  ]],
  ["20261013170000", [
    "20261013170000_powerhub_fix_sms_claim_tenant_id_ambiguity.sql",
    "20261013170000_powerhub_unified_message_history_filters.sql",
  ]],
]);

function sortedMigrationNames(names) {
  return [...names].sort();
}

/**
 * Validate the complete local migration inventory. Historical duplicate
 * versions are permitted only while their exact, reviewed filenames remain
 * pinned; every new or altered collision fails closed.
 */
export function assertSupabaseMigrationFileInventory(filenames) {
  if (!Array.isArray(filenames)) {
    throw new Error("Migration file inventory must be an array.");
  }

  const byVersion = new Map();
  for (const filename of filenames) {
    if (typeof filename !== "string") {
      throw new Error("Migration inventory contains a non-string filename.");
    }
    const match = filename.match(/^(\d+)_([a-zA-Z0-9_]+)\.sql$/);
    if (!match) {
      throw new Error("Invalid migration filename in local inventory: " + filename);
    }
    const version = match[1];
    const group = byVersion.get(version) ?? [];
    group.push(filename);
    byVersion.set(version, group);
  }

  for (const [version, names] of byVersion) {
    if (names.length < 2) continue;
    const expected = PINNED_HISTORICAL_MIGRATION_VERSION_COLLISIONS.get(version);
    if (!expected || JSON.stringify(sortedMigrationNames(names)) !== JSON.stringify(sortedMigrationNames(expected))) {
      throw new Error(
        "Unapproved duplicate migration version " + version + ": " +
        names.join(", ") +
        ". Only exact pinned historical collisions may remain until explicit reconciliation.",
      );
    }
  }

  for (const [version, expected] of PINNED_HISTORICAL_MIGRATION_VERSION_COLLISIONS) {
    const actual = byVersion.get(version) ?? [];
    if (JSON.stringify(sortedMigrationNames(actual)) !== JSON.stringify(sortedMigrationNames(expected))) {
      throw new Error(
        "Pinned historical migration collision " + version +
        " changed. Review and explicitly reconcile its source and database history before editing these filenames.",
      );
    }
  }

  return {
    fileCount: filenames.length,
    uniqueVersionCount: byVersion.size,
    historicalCollisionCount: PINNED_HISTORICAL_MIGRATION_VERSION_COLLISIONS.size,
  };
}

/**
 * A selected migration can never be released while any other local file uses
 * the same version, including files in a pinned historical collision group.
 */
export function assertSupabaseMigrationReleaseVersionIsUnique({ filename, migrationFiles }) {
  if (typeof filename !== "string" || !Array.isArray(migrationFiles)) {
    throw new Error("Migration release uniqueness check requires a filename and migration file inventory.");
  }

  const match = filename.match(/^(\d+)_([a-zA-Z0-9_]+)\.sql$/);
  if (!match) {
    throw new Error("Migration release candidate must have a numeric version and SQL filename.");
  }
  if (!migrationFiles.includes(filename)) {
    throw new Error("Selected migration is not present in the validated source inventory.");
  }

  const version = match[1];
  const collisions = migrationFiles.filter(
    (entry) => entry !== filename && entry.startsWith(version + "_"),
  );
  if (collisions.length) {
    throw new Error(
      "Migration " + filename + " cannot be released while local files share version " +
      version + ": " + collisions.join(", "),
    );
  }

  return version;
}


/**
 * Validate the selected release target against both independent secrets and
 * the actual direct-database URI. Never print the URI or its credentials.
 */
export function assertSupabaseMigrationTarget({ target, projectRef, databaseUrl }) {
  const expectedProjectRef = SUPABASE_PROJECT_BY_TARGET[target];
  if (!expectedProjectRef) {
    throw new Error("Migration target must be staging or production.");
  }
  if (projectRef !== expectedProjectRef) {
    throw new Error(`SUPABASE_PROJECT_REF does not match the selected ${target} project; refusing to connect to an unexpected database.`);
  }
  if (typeof databaseUrl !== "string" || !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error("SUPABASE_DB_URL must be a PostgreSQL direct connection URI stored as an environment secret.");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("SUPABASE_DB_URL is not a valid PostgreSQL connection URI.");
  }

  const requestedSslModes = parsed.searchParams.getAll("sslmode").map((mode) => mode.trim().toLowerCase());
  const allowedSslModes = new Set(["require", "verify-ca", "verify-full"]);
  if (
    requestedSslModes.some((mode) => !allowedSslModes.has(mode)) ||
    new Set(requestedSslModes).size > 1
  ) {
    throw new Error("SUPABASE_DB_URL must enforce TLS; sslmode must be require, verify-ca, or verify-full.");
  }

  const expectedHost = `db.${expectedProjectRef}.supabase.co`;
  if (parsed.hostname !== expectedHost) {
    throw new Error(`SUPABASE_DB_URL host must match the selected ${target} project (${expectedHost}); refusing to connect to a differently configured database.`);
  }
  if (parsed.pathname !== "/postgres") {
    throw new Error("SUPABASE_DB_URL must target the postgres database.");
  }
  if (!parsed.username || !parsed.password) {
    throw new Error("SUPABASE_DB_URL must include a database username and password.");
  }

  return { projectRef: expectedProjectRef, hostname: parsed.hostname };
}


/**
 * Hash the exact UTF-8 SQL bytes using SHA-256. This is compared with the
 * complete SQL payload retained in supabase_migrations.schema_migrations.
 */
export function computeSupabaseMigrationContentSha256(sql) {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new Error("Migration SQL content must be a non-empty string.");
  }
  return createHash("sha256").update(Buffer.from(sql, "utf8")).digest("hex");
}

/**
 * Build a safe ledger INSERT that preserves the exact UTF-8 SQL payload.
 * Base64 avoids SQL string-literal escaping ambiguities (quotes, backslashes,
 * CRLF/LF and non-ASCII text) while retaining the source bytes on PostgreSQL.
 */
export function buildSupabaseMigrationLedgerInsert({ version, name, sql }) {
  if (!/^\d{14}$/.test(version) || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error("Migration ledger insert requires a valid 14-digit version and snake_case name.");
  }
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new Error("Migration ledger insert requires non-empty SQL content.");
  }

  const sqlBase64 = Buffer.from(sql, "utf8").toString("base64");
  return [
    "INSERT INTO supabase_migrations.schema_migrations (version, name, statements)",
    `VALUES ('${version}', '${name}', ARRAY[convert_from(decode('${sqlBase64}', 'base64'), 'UTF8')]);`,
  ].join("\n");
}

/**
 * Parse tuples-only psql output without collapsing multiple migration records.
 * The third column is a SHA-256 hash of the exact retained SQL payload, or
 * "unavailable" for legacy rows whose statements array is NULL/empty.
 */
export function parseSupabaseMigrationHistoryRows(output) {
  if (typeof output !== "string") throw new Error("Migration history query output must be a string.");
  if (output.trim() === "") return [];
  return output.split(/\r?\n/).filter((row) => row.length > 0).map((row) => {
    const fields = row.split("|");
    if (fields.length !== 3) {
      throw new Error("Migration history query returned an unexpected row.");
    }
    const [version, name, contentSha] = fields;
    if (!/^\d{14}$/.test(version)) {
      throw new Error("Migration history query returned a row with an invalid 14-digit version.");
    }
    if (!/^[a-z0-9_]+$/.test(name)) {
      throw new Error("Migration history query returned a row with an invalid migration name.");
    }
    if (contentSha !== "unavailable" && !/^[a-f0-9]{64}$/.test(contentSha)) {
      throw new Error("Migration history query returned an invalid SQL SHA-256 value.");
    }
    return { version, name, contentSha };
  });
}

/**
 * Classify one migration against the live migration ledger.
 * An exact version/name match is already applied only when the retained SQL
 * bytes also match the checked-in migration. Missing or changed payloads fail
 * closed and require an evidence-backed manual reconciliation.
 */
export function classifySupabaseMigrationHistory({ version, name, contentSha, records }) {
  if (!/^\d{14}$/.test(version) || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error("Migration history lookup requires a valid 14-digit version and snake_case name.");
  }
  if (!/^[a-f0-9]{64}$/.test(contentSha)) {
    throw new Error("Migration history lookup requires the SHA-256 hash of the selected SQL file.");
  }
  if (!Array.isArray(records)) {
    throw new Error("Migration history records must be an array.");
  }

  for (const record of records) {
    if (!record || !/^\d{14}$/.test(record.version) || !/^[a-z0-9_]+$/.test(record.name)) {
      throw new Error("Migration history contains a malformed version/name record.");
    }
    if (record.contentSha !== "unavailable" && !/^[a-f0-9]{64}$/.test(record.contentSha)) {
      throw new Error("Migration history contains a malformed stored SQL SHA-256 value.");
    }
  }

  const sameVersion = records.filter((record) => record.version === version);
  const sameName = records.filter((record) => record.name === name);

  if (sameVersion.length > 1) {
    throw new Error(`Migration version "${version}" appears more than once in the database ledger.`);
  }
  if (sameName.length > 1) {
    const versions = sameName.map((record) => record.version).sort().join(", ");
    throw new Error(`Migration name "${name}" appears more than once in the database ledger (versions: ${versions}); reconcile history before releasing it.`);
  }
  if (sameVersion.length === 1) {
    if (sameVersion[0].name !== name) {
      throw new Error(`Ledger version "${version}" already exists with a different name ("${sameVersion[0].name}").`);
    }
    if (sameVersion[0].contentSha === "unavailable") {
      throw new Error(`Migration "${version}_${name}" is recorded but its stored SQL payload is unavailable; verify schema postconditions and reconcile history instead of assuming it is applied.`);
    }
    if (sameVersion[0].contentSha !== contentSha) {
      throw new Error(`Migration "${version}_${name}" is recorded with different SQL content; reconcile the source and live schema instead of skipping or replaying it.`);
    }
    return "already-applied";
  }
  if (sameName.length === 1) {
    throw new Error(`Migration name "${name}" is already recorded under version "${sameName[0].version}", but this file uses "${version}". Reconcile migration history instead of replaying it.`);
  }

  return "not-applied";
}
