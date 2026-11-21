import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateFinancialPreflight,paymentSplitCheckFromSource,renderShadowFixture} from './pr359-financial-shadow-preflight.mjs';
const snapshot=JSON.parse(readFileSync('docs/security/pr359-phase1-financial-prelaunch-baseline-20261117.json','utf8'));
test('read-only prelaunch financial cash baseline and dependency order are fail closed',()=>{
 const r=validateFinancialPreflight(snapshot);
 assert.equal(r.sourceProof.length,4);
 assert.equal(Number(r.paymentBaselines.production.totalAmount),1260);
 assert.equal(r.paymentBaselines.production.rows,5);
 assert.equal(r.shadowTested,false);
 assert.equal(r.releaseDecision,'NO_GO');
});
test('a changed migration order or financial source baseline requires a new reconciliation',()=>{
 const c=structuredClone(snapshot);c.orderedFinanceMigrations.reverse();
 assert.throws(()=>validateFinancialPreflight(c),/order drift/);
 const a=structuredClone(snapshot);a.environments.production.payments.crossScopeInvoices=1;
 assert.throws(()=>validateFinancialPreflight(a),/Payment preflight failure/);
 const b=structuredClone(snapshot);b.releaseDecision='GO';
 assert.throws(()=>validateFinancialPreflight(b),/Audit may not grant/);
});
test('isolated PostgreSQL constraint fixture is extracted from ACTUAL migration source',()=>{
 const s=readFileSync('supabase/migrations/20261103131104_powerhub_subscriber_liability_and_cash_allocation.sql','utf8');
 const expr=paymentSplitCheckFromSource(s);
 assert.ok(expr.includes('round(invoice_applied_amount+subscriber_credit_amount,2)'));
 assert.ok(renderShadowFixture().includes(expr));
 assert.throws(()=>paymentSplitCheckFromSource('select 1;'),/missing/);
});
