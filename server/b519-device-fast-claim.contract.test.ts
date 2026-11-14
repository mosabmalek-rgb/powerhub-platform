import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(path.resolve(process.cwd(),
  "supabase/migrations/20261113001000_powerhub_b519_device_same_lease_read_fast_path.sql"), "utf8");
const rollback = fs.readFileSync(path.resolve(process.cwd(),
  "supabase/tests/b519_device_fast_claim_rollback.sql"), "utf8");

describe("B5.19 same-device claim fast path", () => {
  it("reads a fresh database lease on every matching-device request", () => {
    expect(migration).toContain("lock_row.user_id = p_user_id AND lock_row.device_id = p_device_id");
    expect(migration).toContain("lock_row.locked_until > now() + interval '47 hours'");
    expect(migration).toContain("lock_row.last_seen_at >= now() - interval '30 seconds'");
    expect(migration).toContain("RETURN QUERY SELECT true, v_existing.locked_until, v_existing.device_id");
  });
  it("retains the original advisory lock and row lock for other/expired devices", () => {
    expect(migration).toMatch(/pg_catalog\.pg_advisory_xact_lock\(/);
    expect(migration).toMatch(/FOR UPDATE;/);
    expect(migration).toContain("v_existing.device_id <> p_device_id");
    expect(migration).toContain("interval '15 minutes'");
    expect(migration).toContain("ON CONFLICT (user_id) DO UPDATE");
  });
  it("keeps database-only rollback assertions for replay and competing devices", () => {
    expect(rollback).toContain("FAST_CLAIM_CHANGED_ROW");
    expect(rollback).toContain("COMPETING_DEVICE_ALLOWED");
    expect(rollback).toContain("STALE_HANDOFF_DENIED");
    expect(rollback).toContain("RPC_ACL_DRIFT");
    expect(rollback).toContain("ROLLBACK;");
  });
});
