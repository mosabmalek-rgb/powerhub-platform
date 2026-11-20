import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync('scripts/pr359-shadow/history-attestation.sql','utf8');
const sh=readFileSync('scripts/pr359-shadow/run.sh','utf8');
test('legacy attestation uses exact historic rows but returns only SHA/count metadata',()=>{
 assert.match(sql,/jsonb_agg\(to_jsonb\(m\) ORDER BY m\.version,m\.name,m\.idempotency_key\)/);
 assert.match(sql,/extensions\.digest\(/);
 assert.match(sql,/sha256/);
 assert.doesNotMatch(sql,/\b(?:UPDATE|INSERT|DELETE|ALTER|DROP|TRUNCATE|CREATE)\s+(?:TABLE|SCHEMA|FROM|INTO)\b/i);
});
test('source read-only fingerprint is acquired while TLS guarded source is available',()=>{
 const readonly=sh.indexOf("export PGOPTIONS='-c default_transaction_read_only=on'");
 const stage=sh.indexOf('SHADOW_STAGE=source-historical-ledger-attestation');
 const exportRoles=sh.indexOf('dump roles.sql --role-only');
 const disableReadOnly=sh.indexOf('unset PGOPTIONS PGSSLMODE;');
 const unsetSource=sh.indexOf('unset PGOPTIONS PGSSLMODE SHADOW_SOURCE_DB_URL');
 assert.ok(readonly>0&&readonly<stage&&stage<disableReadOnly&&disableReadOnly<exportRoles&&exportRoles<unsetSource);
 const segment=sh.slice(stage,exportRoles);
 assert.match(segment,/psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "\$SHADOW_SOURCE_DB_URL"/);
 assert.match(segment,/--file scripts\/pr359-shadow\/history-attestation\.sql/);
 assert.match(segment,/2>\/dev\/null/);
});
test('history digest parity is checked after COPY and BEFORE any financial upgrades',()=>{
 const restore=sh.slice(sh.indexOf('\nrestore(){'),sh.indexOf('\napply(){'));
 const historyData=restore.indexOf('runfile postgres "$work/dump/history-data.sql"');
 const stage=restore.indexOf('SHADOW_STAGE=verify-restored-legacy-ledger-sha256');
 const countGuard=restore.indexOf('Source and restore row counts differ');
 assert.ok(historyData>=0&&stage>historyData&&countGuard>stage);
 const section=restore.slice(stage,countGuard);
 assert.match(section,/sql postgres < scripts\/pr359-shadow\/history-attestation\.sql/);
 assert.match(section,/cmp -s "\$work\/source-history-attestation\.json" "\$work\/target-history-attestation\.json"/);
 assert.match(section,/PR359_RESTORED_LEGACY_LEDGER_SHA256_MISMATCH/);
 assert.match(section,/exit 1/);
 assert.doesNotMatch(section,/ALLOW_DRIFT|SKIP_HISTORY|BYPASS/);
});
