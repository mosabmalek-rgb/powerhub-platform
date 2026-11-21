import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateFinancialLiveEvidence} from './pr359-finance-live-cash-proof.mjs';
const original=JSON.parse(readFileSync('docs/security/pr359-phase1-finance-live-cash-proof-20261117.json','utf8'));
test('Production and Staging captured cash, invoices and payment links are conserved',()=>{
 const r=validateFinancialLiveEvidence(original);
 assert.equal(r.evidence.production.payments,5);
 assert.equal(r.evidence.staging.payments,6);
 assert.equal(r.evidence.production.outstanding,'3387.30');
 assert.equal(r.evidence.staging.outstanding,'2005.50');
 assert.equal(r.coreFinanceOrder.length,4);
 assert.equal(r.releaseDecision,'NO_GO');
 assert.equal(r.shadowUpgrade,'NOT_TESTED');
});
test('A missing cash link, incorrect money sum, cross-scope payment or duplicate receipt fails closed',()=>{
 for(const mutation of [
   s=>s.environments.production.cashLinks.missing_cash++,
   s=>s.environments.staging.cashLinks.duplicate_cash++,
   s=>s.environments.production.payments.cross_scope_invoice++,
   s=>s.environments.production.invoiceBalances.total_due='3387.31',
   s=>s.environments.production.invoiceCash.paid_mismatches++,
   s=>s.environments.production.cashLinks.wrong_cash_type++
 ]) {const s=structuredClone(original);mutation(s);assert.throws(()=>validateFinancialLiveEvidence(s));}
});
test('Wrong migration sequence, renamed history and false release claim are rejected',()=>{
 for(const mutation of [
  s=>s.environments.staging.coreFinanceHistory.reverse(),
  s=>s.environments.staging.coreFinanceHistory[0].sqlAvailable=false,
  s=>s.environments.production.coreFinanceHistory.push(s.environments.staging.coreFinanceHistory[0]),
  s=>s.productionDerivedShadow='PASS',
  s=>s.releaseDecision='GO',
  s=>s.environments.production.payments.total_amount='1260.001'
 ]){const s=structuredClone(original);mutation(s);assert.throws(()=>validateFinancialLiveEvidence(s));}
});
