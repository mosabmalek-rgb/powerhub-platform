import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { checkManagedCatalog } from './check-managed-catalog.mjs';
import { compareManagedMigrations } from './check-managed-migrations.mjs';
import { compareProviderTopology, isManagedDailyRealtimePartition } from './compare-managed-topology.mjs';

const allowedIceberg = new Set(['storage.iceberg_namespaces', 'storage.iceberg_tables']);

export function checkManagedStackCompatibility(sourceCatalog, targetCatalog, sourceMigrations, targetMigrations, sourceTopology, targetTopology, options={}) {
  const catalog = checkManagedCatalog(sourceCatalog, targetCatalog);
  const migrations = compareManagedMigrations(sourceMigrations, targetMigrations);
  const topology = compareProviderTopology(
    Array.isArray(sourceTopology) ? sourceTopology : sourceTopology.relations,
    Array.isArray(targetTopology) ? targetTopology : targetTopology.relations,
  );

  // Source and target Realtime daily partitions follow distinct clock-based
  // retention schedules. Only Staging, after proving the parent empty via
  // a read-only source query, may tolerate absent historical daily partitions.
  // Every column of each daily child must match its managed parent exactly.
  const sourceRows = Array.isArray(sourceTopology) ? sourceTopology : sourceTopology.relations;
  const targetRows = Array.isArray(targetTopology) ? targetTopology : targetTopology.relations;
  const sourceMap = new Map(sourceRows.map(r=>[r.schema+'.'+r.table,r]));
  const targetMap = new Map(targetRows.map(r=>[r.schema+'.'+r.table,r]));
  const strictDaily = r => {
    if(!r||!isManagedDailyRealtimePartition(r)||!/^messages_\\d{4}_\\d{2}_\\d{2}$/.test(r.table))return false;
    const match=/^FOR VALUES FROM \\('(\\d{4}-\\d{2}-\\d{2}) 00:00:00'\\) TO/.exec(r.partition_bound);
    return !!match && r.table==='messages_'+match[1].replaceAll('-','_');
  };
  const srcColumns=new Map(sourceCatalog.map(r=>[r.schema+'.'+r.table+'.'+r.column,r.type]));
  const dstColumns=new Map(targetCatalog.map(r=>[r.schema+'.'+r.table+'.'+r.column,r.type]));
  const partitionColumnsMatch=(schema,table,rows)=>{
    const child=rows.filter(r=>r.schema===schema && r.table===table);
    const parent=rows.filter(r=>r.schema===schema && r.table==='messages');
    return child.length===parent.length && child.length>0 && child.every(r=>
      parent.some(p=>p.column===r.column&&p.type===r.type));
  };
  const safeSourcePart=key=>{
    const [schema,table]=key.split('.');
    return options.allowEmptyStagingRealtime===true &&
       schema==='realtime' && strictDaily(sourceMap.get(key)) &&
       partitionColumnsMatch(schema,table,sourceCatalog);
  };
  const reviewedAbsent=topology.absent.filter(key=>safeSourcePart(key));
  const blockedAbsent=topology.absent.filter(key=>!safeSourcePart(key));
  const allowedMissingColumns=catalog.missing.filter(key=>{
    const [schema,table,column]=key.split('.');
    return safeSourcePart(schema+'.'+table) && srcColumns.get(key)===srcColumns.get('realtime.messages.'+column);
  });
  const blockedMissingColumns=catalog.missing.filter(key=>!allowedMissingColumns.includes(key));
  const targetDailyColumnsValid=topology.dynamic.every(r=>
    strictDaily(r) && partitionColumnsMatch('realtime',r.table,targetCatalog));
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
  const compatible = blockedMissingColumns.length===0 && catalog.typeMismatch.length===0 &&
    allUnexpectedColumnsAllowed && migrations.compatible && blockedAbsent.length===0 &&
    targetDailyColumnsValid && topology.sharedDrift.length===0 &&
    exactIcebergExtras && topology.otherExtra.length===allowedIceberg.size;
  return {catalog,migrations,topology,unexpectedColumns,allUnexpectedColumnsAllowed,
    exactIcebergExtras,reviewedAbsent,blockedAbsent,allowedMissingColumns,
    blockedMissingColumns,targetDailyColumnsValid,compatible};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 8,
    'Usage: check-managed-stack-compatibility.mjs source-catalog target-catalog source-migrations target-migrations source-topology target-topology');
  const read = file => JSON.parse(readFileSync(file, 'utf8').trim());
  const mayReviewEmptySource = process.env.SHADOW_SOURCE_KIND==='staging' &&
    process.env.PR359_CONFIRMED_EMPTY_STAGING_REALTIME==='true';
  const result = checkManagedStackCompatibility(read(process.argv[2]), read(process.argv[3]),
    read(process.argv[4]), read(process.argv[5]), read(process.argv[6]), read(process.argv[7]),
    {allowEmptyStagingRealtime:mayReviewEmptySource});
  if (!result.compatible) {
    console.error(`PR359_LOCAL_STACK_MANAGED_COMPATIBILITY_FAIL missingColumns=${result.catalog.missing.length} blockedMissing=${result.blockedMissingColumns.length} reviewedDaily=${result.reviewedAbsent.length} typeDrift=${result.catalog.typeMismatch.length} unexpectedColumns=${result.catalog.unexpected.length} unexpectedAllowed=${result.unexpectedColumns.length} missingRelations=${result.topology.absent.length} sharedDrift=${result.topology.sharedDrift.length} extraRelations=${result.topology.otherExtra.length}`);
    for (const key of result.catalog.unexpected.slice(0, 25)) console.error('PR359_UNEXPECTED_MANAGED_COLUMN: ' + key);
    for (const key of result.catalog.missing.slice(0, 25)) console.error('PR359_MISSING_MANAGED_COLUMN: ' + key);
    for (const key of result.migrations.missing.slice(0, 25)) console.error('PR359_MISSING_MANAGED_MIGRATION: ' + key);
    for (const key of result.migrations.unexpected.slice(0, 25)) console.error('PR359_UNEXPECTED_MANAGED_MIGRATION: ' + key);
    process.exitCode = 2;
  } else {
    console.log('PR359_LOCAL_STACK_MANAGED_COMPATIBILITY_PASS: core managed source columns/types and service ledgers match; empty Staging rolling Realtime lifecycle exceptions explicitly reviewed');
  }
}
