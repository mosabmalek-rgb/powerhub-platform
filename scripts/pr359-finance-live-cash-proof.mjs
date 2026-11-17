import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const versions=[
 ['20261103131052','powerhub_subscriber_credit_ledger'],
 ['20261103131104','powerhub_subscriber_liability_and_cash_allocation'],
 ['20261103131125','powerhub_statement_operating_collection_summary'],
 ['20261103145232','powerhub_legacy_unlinked_payments_to_subscriber_credit']
];
const cents=x=>{
 assert.match(x,/^\\d+\\.\\d{2}$/,'Exact two-decimal amount text required');
 const [a,b]=x.split('.');
 return BigInt(a)*100n+BigInt(b);
};
const nonnegative=(x,label)=>assert.ok(Number.isSafeInteger(x)&&x>=0,label+' must be a nonnegative integer');
export function validateFinancialLiveEvidence(snapshot) {
 assert.equal(snapshot?.schemaVersion,1);
 assert.match(snapshot.sourceHead,/^[0-9a-f]{40}$/);
 assert.equal(snapshot.releaseDecision,'NO_GO');
 assert.equal(snapshot.historicMigrationExecution,'UNPROVEN');
 assert.equal(snapshot.productionDerivedShadow,'NOT_TESTED');
 assert.equal(snapshot.projects.production,'vvcdiqcyhaloxesvpppc');
 assert.equal(snapshot.projects.staging,'iyuryuhaylhisjfcrwkz');
 const evidence={};
 for(const env of ['production','staging']) {
   const v=snapshot.environments?.[env];assert.ok(v,'Missing environment '+env);
   const p=v.payments,c=v.cashLinks,i=v.invoiceCash,b=v.invoiceBalances,l=v.cashLedgerSize;
   assert.ok(p&&c&&i&&b&&l,'Missing financial evidence '+env);
   for(const [scope,obj,keys] of [
      ['payments',p,['rows','completed','nonpositive','orphan_invoice','excess_precision','completed_unlinked','cross_scope_invoice']],
      ['cashLinks',c,['missing_cash','payment_rows','duplicate_cash','wrong_cash_type','cross_tenant_cash','exactly_one_cash_row','incorrect_cash_amount']],
      ['invoiceCash',i,['invoice_rows','paid_mismatches']],
      ['invoiceBalances',b,['rows','negative_amounts','balance_mismatches']],
      ['cashLedgerSize',l,['rows','payment_linked_rows']]
   ])for(const k of keys)nonnegative(obj[k],env+'.'+scope+'.'+k);
   assert.equal(p.completed,p.rows,'Incomplete payments not covered '+env);
   for(const k of ['nonpositive','orphan_invoice','excess_precision','completed_unlinked','cross_scope_invoice'])assert.equal(p[k],0,env+'.'+k);
   for(const k of ['missing_cash','duplicate_cash','wrong_cash_type','cross_tenant_cash','incorrect_cash_amount'])assert.equal(c[k],0,env+'.'+k);
   assert.equal(c.payment_rows,p.rows);
   assert.equal(c.exactly_one_cash_row,p.rows);
   assert.equal(l.payment_linked_rows,p.rows);
   assert.equal(i.paid_mismatches,0);
   assert.equal(b.balance_mismatches,0);
   assert.equal(b.negative_amounts,0);
   assert.equal(i.invoice_rows,b.rows);
   assert.equal(cents(p.total_amount),cents(p.completed_amount));
   assert.equal(cents(p.total_amount),cents(i.linked_paid_total));
   assert.equal(cents(p.total_amount),cents(i.paid_total));
   assert.equal(cents(p.total_amount),cents(b.total_paid));
   assert.equal(cents(b.total_invoiced),cents(b.total_due)+cents(b.total_paid));
   cents(l.gross_amount);
   assert.ok(Array.isArray(v.coreFinanceHistory)&&Array.isArray(v.financeColumns));
   evidence[env]={payments:p.rows,invoices:b.rows,invoiceAmount:b.total_invoiced,
      completedCollections:p.completed_amount,outstanding:b.total_due,
      cashRows:l.rows,creditLedgerPresent:v.subscriberCreditLedgerPresent};
 }
 const s=snapshot.environments.staging,p=snapshot.environments.production;
 const columns=['invoice_applied_amount','payment_purpose','subscriber_credit_amount'];
 assert.deepEqual(s.financeColumns,columns);
 assert.deepEqual(p.financeColumns,[]);
 assert.equal(s.subscriberCreditLedgerPresent,true);
 assert.equal(p.subscriberCreditLedgerPresent,false);
 assert.deepEqual(s.coreFinanceHistory.map(m=>[m.version,m.name,m.sqlAvailable]),
   versions.map(([v,n])=>[v,n,true]));
 assert.deepEqual(p.coreFinanceHistory,[]);
 return {sourceHead:snapshot.sourceHead,evidence,coreFinanceOrder:versions.map(([version,name])=>({version,name})),
     sourceFinancialChecks:'PASS_ON_CAPTURED_AGGREGATES',
     shadowUpgrade:'NOT_TESTED',historicalExecution:'UNPROVEN',
     releaseDecision:'NO_GO'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const s=JSON.parse(readFileSync('docs/security/pr359-phase1-finance-live-cash-proof-20261117.json','utf8'));
 const report=validateFinancialLiveEvidence(s);
 const at=process.argv.indexOf('--out');
 if(at>=0){assert.ok(process.argv[at+1],'Missing output file');writeFileSync(process.argv[at+1],JSON.stringify(report,null,2)+'\\n');}
 console.log('PR359 live financial baseline PASS, Production Shadow NOT_TESTED, release NO_GO');
 if(process.argv.includes('--require-release'))throw Error('NO_GO: actual Production-derived Shadow replay, reconciliation and recovery not evidenced');
}
