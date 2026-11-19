import test from 'node:test';
import assert from 'node:assert/strict';
import { checkManagedStackCompatibility } from './check-managed-stack-compatibility.mjs';

const migrations = [
  { service: 'auth', version: '1', checksum: 'a' },
  { service: 'storage', version: '1', checksum: 'b' },
  { service: 'realtime', version: '1', checksum: 'c' },
];
const sourceRelations = [
  { schema: 'auth', table: 'users', kind: 'r', owner: 'supabase_auth_admin', is_partition: false, parent: null },
  { schema: 'storage', table: 'objects', kind: 'r', owner: 'supabase_storage_admin', is_partition: false, parent: null },
  { schema: 'realtime', table: 'messages', kind: 'p', owner: 'supabase_realtime_admin', is_partition: false, parent: null },
];
const sourceCatalog = [
  { schema: 'auth', table: 'users', column: 'id', type: 'uuid' },
  { schema: 'storage', table: 'objects', column: 'id', type: 'uuid' },
  { schema: 'realtime', table: 'messages', column: 'id', type: 'bigint' },
];
const targetRelations = [
  ...sourceRelations,
  { schema: 'storage', table: 'iceberg_namespaces', kind: 'r', owner: 'supabase_storage_admin', is_partition: false, parent: null },
  { schema: 'storage', table: 'iceberg_tables', kind: 'r', owner: 'supabase_storage_admin', is_partition: false, parent: null },
  { schema: 'realtime', table: 'messages_2026_11_19', kind: 'r', owner: 'supabase_realtime_admin', is_partition: true, parent: 'realtime.messages', partition_bound: "FOR VALUES FROM ('2026-11-19 00:00:00') TO ('2026-11-20 00:00:00')" },
];
const targetCatalog = [
  ...sourceCatalog,
  { schema: 'storage', table: 'iceberg_namespaces', column: 'id', type: 'bigint' },
  { schema: 'storage', table: 'iceberg_tables', column: 'id', type: 'bigint' },
  { schema: 'realtime', table: 'messages_2026_11_19', column: 'id', type: 'bigint' },
];

test('accepts only the documented Iceberg and daily Realtime extras', () => {
  const result = checkManagedStackCompatibility(sourceCatalog, targetCatalog, migrations, migrations, sourceRelations, targetRelations);
  assert.equal(result.compatible, true);
  assert.equal(result.topology.dynamic.length, 1);
  assert.equal(result.topology.otherExtra.length, 2);
});

test('rejects an ordinary managed relation/column extra', () => {
  const relations = [...targetRelations, { schema: 'storage', table: 'unexpected', kind: 'r', owner: 'supabase_storage_admin', is_partition: false, parent: null }];
  const catalog = [...targetCatalog, { schema: 'storage', table: 'unexpected', column: 'id', type: 'uuid' }];
  const result = checkManagedStackCompatibility(sourceCatalog, catalog, migrations, migrations, sourceRelations, relations);
  assert.equal(result.compatible, false);
  assert.equal(result.exactIcebergExtras, false);
  assert.equal(result.allUnexpectedColumnsAllowed, false);
});

test('rejects missing columns and migration ledger drift', () => {
  const result = checkManagedStackCompatibility(sourceCatalog.slice(0, 2), targetCatalog, migrations, migrations, sourceRelations, targetRelations);
  assert.equal(result.compatible, false);
  assert.equal(result.allUnexpectedColumnsAllowed, false);
});
