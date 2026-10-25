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
