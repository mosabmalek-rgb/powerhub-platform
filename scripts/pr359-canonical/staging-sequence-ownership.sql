-- CB-A: read-only pg_catalog sequence-to-IDENTITY provenance; no user rows or secrets.
WITH s AS (
 SELECT n.nspname AS sequence_schema,c.relname AS sequence_name,c.oid AS oid
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind='S' AND n.nspname IN ('public','private','powerhub_private')
), o AS (
 SELECT s.sequence_schema,s.sequence_name,d.deptype AS ownership_dependency_type,
  n.nspname AS owning_table_schema,t.relname AS owning_table_name,a.attname AS owning_column_name,
  a.attidentity AS owning_column_identity_kind,
  CASE WHEN t.oid IS NOT NULL THEN
    pg_get_serial_sequence(format('%I.%I',n.nspname,t.relname),a.attname)
  ELSE NULL END AS pg_get_serial_sequence_result
 FROM s
 LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.oid
  AND d.refclassid='pg_class'::regclass AND d.refobjsubid>0 AND d.deptype IN ('a','i')
 LEFT JOIN pg_class t ON t.oid=d.refobjid
 LEFT JOIN pg_namespace n ON n.oid=t.relnamespace
 LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
)
SELECT * FROM o ORDER BY sequence_schema,sequence_name;
