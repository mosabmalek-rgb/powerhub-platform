import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("D36 trial balance PostgREST transaction mode", () => {
  it("uses a read-write RPC transaction for source locks without granting public execution", () => {
    const sql = readFileSync("supabase/migrations/20261116001000_powerhub_financial_d36_trial_balance_postgrest_transaction_mode.sql", "utf8");
    expect(sql).toMatch(/ALTER FUNCTION public\.powerhub_financial_gl_trial_balance\(bigint,bigint,text\) VOLATILE/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.powerhub_financial_gl_trial_balance\(bigint,bigint,text\)\s+FROM PUBLIC, anon, authenticated/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.powerhub_financial_gl_trial_balance\(bigint,bigint,text\)\s+TO service_role/i);
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO|FROM)?\s*public\.financial_gl_/i);
  });
});
