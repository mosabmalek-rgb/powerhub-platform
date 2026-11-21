import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
const deps=[
 ['20261103131052','powerhub_subscriber_credit_ledger'],
 ['20261103131104','powerhub_subscriber_liability_and_cash_allocation'],
 ['20261103131125','powerhub_statement_operating_collection_summary'],
 ['20261103145232','powerhub_legacy_unlinked_payments_to_subscriber_credit']
];
const sha256=x=>createHash('sha256').update(x).digest('hex');

export function paymentSplitCheckFromSource(source){
 const marker='add constraint payments_invoice_credit_split_check';
 const at=source.toLowerCase().indexOf(marker);
 check(at>=0,'Actual payments split constraint is missing');
 const start=source.toLowerCase().indexOf('check (',at+marker.length);
 check(start>=0&&start-at<160,'Actual CHECK expression not found');
 const begin=start+'check ('.length;
 let depth=1,quoted=false,end=-1;
 for(let i=begin;i<source.length;i++){
  const c=source[i],next=source[i+1];
  if(c==="'"){if(quoted&&next==="'"){i++;continue;}quoted=!quoted;continue;}
  if(quoted)continue;
  if(c==='(')depth++;
  if(c===')'){depth--;if(depth===0){end=i;break;}}
 }
 check(end>begin && end-begin<10000,'CHECK expression is unbalanced');
 const expr=source.slice(begin,end);
 for(const key of ['invoice_collection_with_credit','subscriber_credit_amount','security_deposit_refund','invoice_applied_amount']){
  check(expr.includes(key),'Missing critical payment CHECK branch: '+key);
 }
 return expr;
}
export function renderShadowFixture({root=process.cwd()}={}){
 const src=readFileSync(path.join(root,'supabase/migrations/20261103131104_powerhub_subscriber_liability_and_cash_allocation.sql'),'utf8');
 const expr=paymentSplitCheckFromSource(src);
 return '-- Source-bound isolated financial fixture, NOT full migration/Production Shadow proof\n'
  +'CREATE TEMP TABLE pr359_payment_split_fixture (fixture_group text NOT NULL, payment_purpose text NOT NULL, '
  +'amount numeric(14,2) NOT NULL, invoice_applied_amount numeric(14,2) NOT NULL, '
  +'subscriber_credit_amount numeric(14,2) NOT NULL, CONSTRAINT payments_invoice_credit_split_check CHECK ('
  +expr+'));\n';
}
export function validateFinancialPreflight(snapshot,{root=process.cwd(),crosswalk}={}){
 check(snapshot?.schemaVersion===1&&/^[a-f0-9]{40}$/.test(snapshot.sourceHead||''),'Missing SHA baseline');
 check(snapshot.releaseDecision==='NO_GO'&&snapshot.shadowUpgrade==='NOT_TESTED','Audit may not grant release readiness');
 check(snapshot.orderedFinanceMigrations?.length===deps.length,'Financial dependency list missing');
 const env=snapshot.environments||{},st=env.staging,pr=env.production;
 check(st?.liabilityLedgerExists===true&&pr?.liabilityLedgerExists===false,'Baseline schema has changed');
 check(st.migrations.length===4&&pr.migrations.length===0,'Baseline migration history has changed');
 for(const e of [st,pr]){
  for(const key of ['nonpositive','orphanInvoices','crossScopeInvoices','excessDecimalPrecision','completedUnlinkedCount']){
   check(e.payments[key]===0,'Payment preflight failure: '+key);
  }
  check(e.payments.completed===e.payments.rows,'Pending payments require separate reconciliation');
  check(Number(e.payments.completedAmount)===Number(e.payments.totalAmount),'Payment totals unexpected');
 }
 check(pr.payments.rows===5&&Number(pr.payments.totalAmount)===1260,'Prelaunch Production fixture baseline drift');
 check(st.payments.rows===6&&Number(st.payments.totalAmount)===667,'Prelaunch Staging fixture baseline drift');
 for(const key of ['payment_purpose','invoice_applied_amount','subscriber_credit_amount']){
  check(st.columns.includes(key)&&!pr.columns.includes(key),'Column prerequisite drift: '+key);
 }
 for(const key of ['payments_payment_purpose_check','payments_invoice_credit_split_check']){
  check(st.constraints.includes(key)&&!pr.constraints.includes(key),'Constraint prerequisite drift: '+key);
 }
 const sourceProof=[];
 for(let i=0;i<deps.length;i++){
  const [version,name]=deps[i],m=snapshot.orderedFinanceMigrations[i];
  check(m.version===version&&m.name===name,'Migration dependency order drift: '+version);
  const file='supabase/migrations/'+version+'_'+name+'.sql';
  const digest=sha256(readFileSync(path.join(root,file)));
  check(st.migrations.some(x=>x.version===version&&x.name===name&&x.sqlAvailable),'Staging history source unavailable: '+file);
  if(crosswalk){
   const row=crosswalk.records.find(x=>x.sourcePath===file);
   check(row?.sourceSha256===digest,'Git source hash diverged from CI crosswalk: '+file);
   check(row.environments.staging.status==='EXACT_SQL_HISTORY_MATCH','Staging content mismatch: '+file);
   check(row.environments.production.status==='NO_DIRECT_LEDGER_MATCH','Production migration already recorded or diverged: '+file);
  }
  sourceProof.push({version,name,path:file,sourceSha256:digest});
 }
 renderShadowFixture({root});
 const legacy=readFileSync(path.join(root,'supabase/migrations/20261103145232_powerhub_legacy_unlinked_payments_to_subscriber_credit.sql'),'utf8');
 for(const key of ['where p.invoice_id is null',"p.status = 'completed'","payment_purpose = 'subscriber_credit'","on conflict (idempotency_key) do nothing"]){
  check(legacy.toLowerCase().includes(key.toLowerCase()),'Legacy reclassification contract changed: '+key);
 }
 return {sourceHead:snapshot.sourceHead,sourceProof,paymentBaselines:{staging:st.payments,production:pr.payments},
  shadowTested:false,releaseDecision:'NO_GO'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2),f=args.indexOf('--fixture'),o=args.indexOf('--out');
 if(f>=0){check(!!args[f+1],'Missing fixture path');writeFileSync(args[f+1],renderShadowFixture());}
 else{
  const b=JSON.parse(readFileSync('docs/security/pr359-phase1-financial-prelaunch-baseline-20261117.json','utf8'));
  const cw=JSON.parse(readFileSync('pr359-full-ledger-crosswalk.json','utf8'));
  const report=validateFinancialPreflight(b,{crosswalk:cw});
  console.log('PR359 finance prerequisites verified; Shadow remains NOT_TESTED:',report.sourceProof.length,'source migrations');
  if(o>=0){check(!!args[o+1],'Missing output path');writeFileSync(args[o+1],JSON.stringify(report,null,2)+'\n');}
  if(args.includes('--require-ready'))throw Error('NO_GO: Production Shadow upgrade, repeat and recovery are not proven');
 }
}
