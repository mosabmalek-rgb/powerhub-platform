export const SUPABASE_PROJECT_BY_TARGET = Object.freeze({
  staging: "iyuryuhaylhisjfcrwkz",
  production: "vvcdiqcyhaloxesvpppc",
});

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
 * Classify one migration against the live migration ledger.
 * A matching name under another timestamp is drift, not permission to replay.
 */
export function classifySupabaseMigrationHistory({ version, name, records }) {
  if (!/^\\d{14}$/.test(version) || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error("Migration history lookup requires a valid 14-digit version and snake_case name.");
  }
  if (!Array.isArray(records)) {
    throw new Error("Migration history records must be an array.");
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
    return "already-applied";
  }
  if (sameName.length === 1) {
    throw new Error(`Migration name "${name}" is already recorded under version "${sameName[0].version}", but this file uses "${version}". Reconcile migration history instead of replaying it.`);
  }

  return "not-applied";
}
