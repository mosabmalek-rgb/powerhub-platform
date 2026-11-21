import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const services = ['auth', 'storage', 'realtime'];
const known = new Set(services);

function parseLedger(rows, origin) {
  assert.ok(Array.isArray(rows) && rows.length > 0,
    origin + ': service migration ledger is missing or empty');
  const map = new Map();
  const perService = Object.fromEntries(services.map(s => [s, 0]));
  for (const row of rows) {
    assert.ok(row && typeof row === 'object' && known.has(row.service),
      origin + ': invalid managed service');
    assert.ok(typeof row.version === 'string'
      && row.version.length > 0 && row.version.length <= 255
      && !/[\x00-\x1f\x7f]/.test(row.version),
      origin + ': invalid version identifier');
    assert.ok(row.checksum === null
      || (typeof row.checksum === 'string' && row.checksum.length <= 255
        && !/[\x00-\x1f\x7f]/.test(row.checksum)),
      origin + ': invalid checksum');
    const key = row.service + ':' + row.version;
    assert.ok(!map.has(key), origin + ': duplicated service migration identifier');
    map.set(key, row.checksum);
    perService[row.service] += 1;
  }
  for (const s of services)
    assert.ok(perService[s] > 0, origin + ': missing migration ledger for ' + s);
  return {map, perService};
}

export function compareManagedMigrations(source, shadow) {
  const a = parseLedger(source, 'source');
  const b = parseLedger(shadow, 'Docker');
  const missing = [], unexpected = [], checksumDrift = [];
  for (const [key, checksum] of a.map) {
    if (!b.map.has(key)) missing.push(key);
    else if (b.map.get(key) !== checksum) checksumDrift.push(key);
  }
  for (const key of b.map.keys())
    if (!a.map.has(key)) unexpected.push(key);
  missing.sort(); unexpected.sort(); checksumDrift.sort();
  const totals = Object.fromEntries(services.map(service => [service, {
    source: a.perService[service],
    docker: b.perService[service],
    missing: missing.filter(key => key.startsWith(service + ':')).length,
    unexpected: unexpected.filter(key => key.startsWith(service + ':')).length,
    checksumDrift: checksumDrift.filter(key => key.startsWith(service + ':')).length
  }]));
  return {sourceCount: a.map.size, dockerCount: b.map.size,
    missing, unexpected, checksumDrift, totals,
    compatible: missing.length === 0 && unexpected.length === 0 && checksumDrift.length === 0};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 4,
    'Usage: check-managed-migrations.mjs source.json shadow.json');
  const result = compareManagedMigrations(
    JSON.parse(readFileSync(process.argv[2], 'utf8').trim()),
    JSON.parse(readFileSync(process.argv[3], 'utf8').trim()));
  if (!result.compatible) {
    console.error('PR359_MANAGED_MIGRATION_PARITY_FAIL source=' + result.sourceCount
      + ' docker=' + result.dockerCount
      + ' missing=' + result.missing.length
      + ' unexpected=' + result.unexpected.length
      + ' checksumDrift=' + result.checksumDrift.length);
    for (const [service, totals] of Object.entries(result.totals))
      console.error('PR359_MANAGED_MIGRATION_SERVICE: ' + service + ' '
        + Object.entries(totals).map(([key, val]) => key + '=' + val).join(' '));
    process.exitCode = 2;
  } else {
    console.log('PR359_MANAGED_MIGRATION_PARITY_PASS: exact service version and checksum records');
  }
}
