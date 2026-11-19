import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {checkManagedCatalog} from './check-managed-catalog.mjs';
import {compareManagedMigrations} from './check-managed-migrations.mjs';

export function compareLocalToR0Reference(reference, localCatalog, localMigrations) {
  assert.equal(reference?.format,'PR359 R0 managed service read-only source reference v1',
    'unrecognized immutable R0 source manifest');
  assert.equal(reference.source_project_ref,'vvcdiqcyhaloxesvpppc',
    'expected reviewed Production reference');
  const catalog=checkManagedCatalog(reference.catalog_columns,localCatalog);
  const migrations=compareManagedMigrations(reference.migration_records,localMigrations);
  return {catalog,migrations,compatible:catalog.compatible&&migrations.compatible};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length,5,
    'Usage: local-managed-reference-comparison.mjs source-ref.json local-columns.json local-migrations.json');
  const [referencePath,catalogPath,migrationsPath]=process.argv.slice(2);
  const reference=JSON.parse(readFileSync(referencePath,'utf8'));
  const catalog=JSON.parse(readFileSync(catalogPath,'utf8').trim());
  const migrations=JSON.parse(readFileSync(migrationsPath,'utf8').trim());
  const comparison=compareLocalToR0Reference(reference,catalog,migrations);
  const c=comparison.catalog,m=comparison.migrations;
  console.log('PR359_LOCAL_REFERENCE_CATALOG source='+c.sourceColumns+
    ' local='+c.dockerColumns+' missing='+c.missing.length+
    ' unexpected='+c.unexpected.length+' typeDrift='+c.typeMismatch.length);
  for(const table of c.unexpectedTables.slice(0,30))
    console.log('PR359_LOCAL_REFERENCE_UNEXPECTED_MANAGED_TABLE: '+table);
  for(const table of c.missingTables.slice(0,30))
    console.log('PR359_LOCAL_REFERENCE_MISSING_MANAGED_TABLE: '+table);
  for(const [service,counts] of Object.entries(m.totals))
    console.log('PR359_LOCAL_REFERENCE_SERVICE '+service+
      ' sourceMigrations='+counts.source+
      ' localMigrations='+counts.docker+
      ' missing='+counts.missing+' unexpected='+counts.unexpected+
      ' hashDrift='+counts.checksumDrift);
  for(const entry of m.missing.slice(0,16))
    console.log('PR359_LOCAL_REFERENCE_MISSING_MIGRATION: '+entry);
  for(const entry of m.unexpected.slice(0,16))
    console.log('PR359_LOCAL_REFERENCE_UNEXPECTED_MIGRATION: '+entry);
  // Exploratory metadata comparison only. A gap is an expected discovery, not
  // acceptance; the PROTECTED full-restore comparators still fail closed.
  console.log('PR359_LOCAL_REFERENCE_PARITY='+ (comparison.compatible?'MATCHED_METADATA_ONLY':'NOT_MATCHED'));
  console.log('PR359_SOURCE_FULL_RESTORE_ACCEPTANCE=NOT_GRANTED');
}
