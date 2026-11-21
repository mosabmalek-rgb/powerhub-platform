import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const evidence = JSON.parse(readFileSync("docs/security/pr359-phase1-production-three-catalog-evidence-20261117.json","utf8"));
test("Production missing SQL rows retain historical and shadow release blockers",()=>{
 assert.equal(evidence.schemaVersion,1);
 assert.deepEqual(evidence.historicalSqlUnavailableVersions,["20261026101438","20261026101445","20261026102654"]);
 assert.equal(evidence.historicalAttribution,"UNPROVEN");
 assert.equal(evidence.shadowUpgrade,"NOT_TESTED");
 assert.match(evidence.releaseDecision,/^NO_GO_/);
 assert.equal(evidence.currentCatalogPostconditions,"SCOPED_METADATA_PASS");
});
test("current Production/Staging finance report definition drift is explicit and cannot be waved through",()=>{
 const rows=evidence.financialDashboardDrift.functionDefinitionComparison;
 assert.equal(evidence.financialDashboardDrift.status,"MATERIAL_LOGIC_DIFFERENCE");
 assert.equal(rows.length,3);
 assert.equal(rows.find(x=>x.function==="powerhub_dashboard_financial_overview").same,false);
 assert.equal(rows.filter(x=>!x.same).length,1);
 for(const env of ["staging","production"]){
  const o=evidence.observations[env];
  assert.equal(o.functions.length,5);
  assert.equal(o.columns.length,4);
  assert.equal(o.indexes.length,3);
  assert.equal(o.lifecycleJobs.length,1);
  assert.equal(o.lifecycleJobs[0].schedule,"*/15 * * * *");
  assert.equal(o.lifecycleJobs[0].active,true);
  for(const f of o.functions){ assert.equal(f.anon_execute,false);assert.equal(f.authenticated_execute,false);assert.equal(f.service_execute,true);assert.equal(f.security_definer,true);}
  for(const f of o.functions.filter(x=>x.proname==="powerhub_process_subscription_lifecycle"||x.proname.startsWith("powerhub_dashboard_"))) assert.ok(f.config.includes('search_path=""'));
 }
 const st=evidence.observations.staging.functions.find(x=>x.proname==="powerhub_dashboard_financial_overview");
 const prod=evidence.observations.production.functions.find(x=>x.proname==="powerhub_dashboard_financial_overview");
 assert.equal(st.uses_invoice_applied_amount,true);
 assert.equal(st.filters_invoice_collection_purpose,true);
 assert.equal(prod.uses_invoice_applied_amount,false);
 assert.equal(prod.filters_invoice_collection_purpose,false);
});
