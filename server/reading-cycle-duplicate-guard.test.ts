import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
const migration = read("supabase/migrations/20261102121500_powerhub_reading_cycle_duplicate_guard.sql");
const mobileApi = read("server/mobile-api.ts");
const powerhub = read("server/powerhub.ts");

describe("single operational reading per configured cycle", () => {
  it("uses the canonical server cycle calculator and serializes all subscriber writers", () => {
    expect(migration).toContain("pg_advisory_xact_lock(new.subscriber_id)");
    expect(migration).toContain("public.powerhub_cycle_for_reading(new.tenant_id, v_site_id, new.reading_at)");
    expect(migration).toContain("before insert or update of tenant_id, subscriber_id, reading_at, status, is_opening_baseline");
    expect(migration).toContain("READING_ALREADY_EXISTS_IN_CYCLE");
  });

  it("does not count opening baselines or rejected readings as cycle occupancy", () => {
    expect(migration).toContain("new.is_opening_baseline is true");
    expect(migration).toContain("new.status is not distinct from 'rejected'");
    expect(migration).toContain("mr.is_opening_baseline is not true");
    expect(migration).toContain("mr.status is distinct from 'rejected'");
  });

  it("returns the current server-derived cycle and any non-rejected reading per subscriber", () => {
    expect(mobileApi).toContain('rpc("powerhub_cycle_for_reading"');
    expect(mobileApi).toContain("currentCycleReading");
    expect(mobileApi).toContain("readingValue: String(reading.reading_value)");
    expect(mobileApi).toContain("readingValue: string;");
    expect(mobileApi).toContain("hasReadingInCurrentCycle");
    expect(mobileApi).toContain('.neq("status", "rejected")');
    expect(mobileApi).toContain('.eq("is_opening_baseline", false)');
  });

  it("rejects a mobile duplicate before upload and maps a concurrent database conflict to HTTP 409", () => {
    expect(mobileApi).toContain("READING_ALREADY_EXISTS_IN_CYCLE");
    expect(mobileApi).toContain('insertError?.code === "23505"');
    expect(mobileApi).not.toContain("READING_ALREADY_EXISTS_TODAY");
  });

  it("maps the same database conflict to a user-facing platform CONFLICT", () => {
    expect(powerhub).toContain("meter_readings_one_operational_reading_per_cycle");
    expect(powerhub).toContain("توجد قراءة غير مرفوضة لهذا المشترك ضمن دورة القراءة الحالية");
    expect(powerhub).not.toContain("يقتصر تجاوز ذلك على المالك أو المدير أو المحاسب");
  });
});
