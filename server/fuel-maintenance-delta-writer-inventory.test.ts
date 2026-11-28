import {describe,expect,it} from "vitest";
import {classify,inventory,roots,scanFile} from "../scripts/pr359-canonical/cb-a-writer-inventory.mjs";

describe("CB-A commit-wide lexical writer inventory (not runtime closure)",()=>{
 it("retains line locations, exact identifier boundaries and bypass candidates",()=>{
  const blob="a".repeat(40);
  const data=scanFile("supabase/migrations/1_test.sql",blob,
   "SELECT public.generator_fuel_events;\nSELECT generator_fuel_events_backup;\nALTER TABLE x DISABLE TRIGGER ALL;\nSELECT powerhub_refresh_fuel_maintenance_delta_after_generator_name_up();");
  expect(data.category).toBe("migration_history");
  expect(data.rows.map(r=>r.line)).toEqual([1,3,4]);
  expect(data.rows[0].roots).toContain("generator_fuel_events");
  expect(data.rows[1].signals).toContain("trigger_disable");
  expect(data.rows[2].roots).toContain("powerhub_refresh_fuel_maintenance_delta_after_generator_name_update");
  expect(classify("server/a.test.ts")).toBe("test_or_fixture");
  expect(classify(".github/workflows/a.yml")).toBe("automation_or_script");
  expect(classify("docs/security/evidence.json")).toBe("documentation");
  expect(classify("scripts/pr359-canonical/cb-a-writer-inventory.mjs")).toBe("audit_tooling");
 });
 it("scans the actual checked-out commit, including unrelated migration names and scripts",()=>{
  const report=inventory();
  expect(report.tracked_regular_blobs).toBeGreaterThan(0);
  expect(report.coverage).toHaveLength(roots.length);
  expect(report.coverage.every(r=>r.source_files>0&&r.migration_files>0)).toBe(true);
  expect(report.categories.migration_history).toBeGreaterThan(0);
  expect(report.full_caller_closure_approved).toBe(false);
  expect(report.canonical_baseline_approved).toBe(false);
  console.info("PR359_CB_A_WRITER_INVENTORY",JSON.stringify({
   commit:report.commit,tracked_regular_blobs:report.tracked_regular_blobs,
   matching_files:report.matching_files,categories:report.categories,coverage:report.coverage,
   source_candidates:report.files.filter(f=>!["documentation","test_or_fixture","audit_tooling"].includes(f.category)).map(f=>({file:f.file,blob:f.blob,lines:f.rows.length})),
   full_caller_closure_approved:false
  }));
 },120000);
});

it("discovers indirect projection sources without requiring a journal reference", () => {
  const relations = ["generators", "inventory_warehouses", "inventory_items", "suppliers", "inventory_stock_movements", "generator_fuel_readings"];
  for (const relation of relations) {
    expect(roots).toContain(relation);
    const data = scanFile("server/indirect-writer.ts", "a".repeat(40),
      "UPDATE public." + relation + " SET name = 'x';\nUPDATE public." + relation + "_backup SET name = 'x';");
    expect(data.rows).toEqual([{line:1,roots:[relation],signals:[]}]);
  }
});

it("uses the physical supplier relation and flags cascade and replica-only trigger candidates", () => {
  expect(roots).toContain("suppliers");
  expect(roots).not.toContain("inventory_suppliers");
  const data = scanFile("supabase/migrations/2_test.sql", "a".repeat(40),
    "UPDATE public.suppliers SET name = 'x';\nUPDATE public.inventory_suppliers SET name = 'x';\nREFERENCES public.suppliers(id) ON DELETE CASCADE;\nREFERENCES public.suppliers(id) ON UPDATE CASCADE;\nALTER TABLE public.suppliers ENABLE REPLICA TRIGGER t;");
  expect(data.rows).toEqual([
    {line:1,roots:["suppliers"],signals:[]},
    {line:3,roots:["suppliers"],signals:["fk_cascade"]},
    {line:4,roots:["suppliers"],signals:["fk_cascade"]},
    {line:5,roots:["suppliers"],signals:["trigger_replica_only"]},
  ]);
});
