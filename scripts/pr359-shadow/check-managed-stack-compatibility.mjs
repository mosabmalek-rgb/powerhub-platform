import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { checkManagedCatalog } from './check-managed-catalog.mjs';
import { compareManagedMigrations } from './check-managed-migrations.mjs';
import { compareProviderTopology, isManagedDailyRealtimePartition } from './compare-managed-topology.mjs';

const allowedIceberg = new Set(['storage.iceberg_namespaces', 'storage.iceberg_tables']);

export function checkManagedStackCompatibility(sourceCatalog, targetCatalog, sourceMigrations, targetMigrations, sourceTopology, targetTopology) {
  const catalog = checkManagedCatalog(sourceCatalog, targetCatalog);
  const migrations = compareManagedMigrations(sourceMigrations, targetMigrations);
  const topology = compareProviderTopology(
    Array.isArray(sourceTopology) ? sourceTopology : sourceTopology.relations,
    Array.isArray(targetTopology) ? targetTopology : targetTopology.relations,
  );
  const targetExtraTables = new Set(topology.otherExtra.map(r => `${r.schema}.${r.table}`));
  const unexpectedColumns = catalog.unexpected.filter(key => {
    const parts = key.split('.');
    return allowedIceberg.has(`${parts[0]}.${parts[1]}`) ||
      (parts[0] === 'realtime' && isManagedDailyRealtimePartition(
        (Array.isArray(targetTopology) ? targetTopology : targetTopology.relations)
          .find(r => r.schema === parts[0] && r.table === parts[1])
      ));
  });
  const allUnexpectedColumnsAllowed = unexpectedColumns.length === catalog.unexpected.length;
  const exactIcebergExtras = targetExtraTables.size === allowedIceberg.size &&
    [...allowedIceberg].every(name => targetExtraTables.has(name));
  const compatible = catalog.missing.length === 0 && catalog.typeMismatch.length === 0 &&
    allUnexpectedColumnsAllowed && migrations.compatible && topology.absent.length === 0 &&
    topology.sharedDrift.length === 0 && exactIcebergExtras && topology.otherExtra.length === allowedIceberg.size;
  return { catalog, migrations, topology, unexpectedColumns, allUnexpectedColumnsAllowed, exactIcebergExtras, compatible };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 8,
    'Usage: check-managed-stack-compatibility.mjs source-catalog target-catalog source-migrations target-migrations source-topology target-topology');
  const read = file => JSON.parse(readFileSync(file, 'utf8').trim());
  const result = checkManagedStackCompatibility(read(process.argv[2]), read(process.argv[3]), read(process.argv[4]), read(process.argv[5]), read(process.argv[6]), read(process.argv[7]));
  if (!result.compatible) {
    console.error(`PR359_LOCAL_STACK_MANAGED_COMPATIBILITY_FAIL missingColumns=${result.catalog.missing.length} typeDrift=${result.catalog.typeMismatch.length} unexpectedColumns=${result.catalog.unexpected.length} unexpectedAllowed=${result.unexpectedColumns.length} missingRelations=${result.topology.absent.length} sharedDrift=${result.topology.sharedDrift.length} extraRelations=${result.topology.otherExtra.length}`);
    for (const key of result.catalog.unexpected.slice(0, 25)) console.error('PR359_UNEXPECTED_MANAGED_COLUMN: ' + key);
    for (const key of result.catalog.missing.slice(0, 25)) console.error('PR359_MISSING_MANAGED_COLUMN: ' + key);
    for (const key of result.migrations.missing.slice(0, 25)) console.error('PR359_MISSING_MANAGED_MIGRATION: ' + key);
    for (const key of result.migrations.unexpected.slice(0, 25)) console.error('PR359_UNEXPECTED_MANAGED_MIGRATION: ' + key);
    process.exitCode = 2;
  } else {
    console.log('PR359_LOCAL_STACK_MANAGED_COMPATIBILITY_PASS: source columns/types and service ledgers match; only documented Iceberg/Realtime lifecycle extras retained');
  }
}
