import { describe, expect, it } from "vitest";
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
