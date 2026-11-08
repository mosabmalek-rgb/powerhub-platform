export const SUPABASE_PROJECT_BY_TARGET = Object.freeze({
  staging: "iyuryuhaylhisjfcrwkz",
  production: "vvcdiqcyhaloxesvpppc",
});

/** Validate the selected project and connection route without logging credentials. */
export function assertSupabaseMigrationTarget({ target, projectRef, databaseUrl }) {
  const expectedProjectRef = SUPABASE_PROJECT_BY_TARGET[target];
  if (!expectedProjectRef) throw new Error("Migration target must be staging or production.");
  if (projectRef !== expectedProjectRef) {
    throw new Error(`SUPABASE_PROJECT_REF does not match the selected ${target} project; refusing to connect to an unexpected database.`);
  }
  if (typeof databaseUrl !== "string" || !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error("SUPABASE_DB_URL must be a PostgreSQL connection URI stored as an environment secret.");
  }

  // libpq and WHATWG URL parsing disagree on unescaped @ in credentials.
  // Reject it before trusting the parsed host or passing the URI to psql.
  const authority = databaseUrl.match(/^postgres(?:ql)?:\/\/([^/?#]+)/i)?.[1] ?? "";
  if (authority.split("@").length > 2) {
    throw new Error("SUPABASE_DB_URL credentials must be percent-encoded in the PostgreSQL URI.");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("SUPABASE_DB_URL is not a valid PostgreSQL connection URI.");
  }

  const requestedSslModes = parsed.searchParams.getAll("sslmode").map((mode) => mode.trim().toLowerCase());
  const allowedSslModes = new Set(["require", "verify-ca", "verify-full"]);
  if (requestedSslModes.some((mode) => !allowedSslModes.has(mode)) || new Set(requestedSslModes).size > 1) {
    throw new Error("SUPABASE_DB_URL must enforce TLS; sslmode must be require, verify-ca, or verify-full.");
  }
  if ([...parsed.searchParams.keys()].some((key) => key !== "sslmode") || parsed.hash) {
    throw new Error("SUPABASE_DB_URL must not override connection parameters or include a fragment.");
  }

  const expectedHost = `db.${expectedProjectRef}.supabase.co`;
  const direct = parsed.hostname === expectedHost && parsed.username === "postgres";
  const sessionPooler = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(parsed.hostname)
    && parsed.username === `postgres.${expectedProjectRef}`;
  if (!direct && !sessionPooler) {
    throw new Error(`SUPABASE_DB_URL host and username must match the selected ${target} project; refusing to connect to a differently configured database.`);
  }
  if (parsed.port !== "5432") throw new Error("SUPABASE_DB_URL must use PostgreSQL port 5432.");
  if (parsed.pathname !== "/postgres") throw new Error("SUPABASE_DB_URL must target the postgres database.");
  if (!parsed.password) throw new Error("SUPABASE_DB_URL must include a database password.");

  return { projectRef: expectedProjectRef, hostname: parsed.hostname };
}
