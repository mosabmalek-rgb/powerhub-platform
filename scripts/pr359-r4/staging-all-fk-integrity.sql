-- R4: independently verify every application-owned FK after COPY under
-- session_replication_role=replica. Uses actual PostgreSQL FK catalog only.
-- psql -X -qAt with \gexec runs generated read-only SELECT statements.
-- MATCH SIMPLE: an FK row is checked only when ALL key columns are non-null.
-- Only aggregated violation counts and constraint metadata are returned.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH fks AS (
 SELECT sn.nspname AS src_schema, src.relname AS src_table,co.conname AS name,
        dn.nspname AS dst_schema,dst.relname AS dst_table,
        co.convalidated AS validated,co.confmatchtype AS match_type,
        bool_and(op.oprname='=' AND onsp.nspname='pg_catalog') AS operator_ok,
        string_agg(format('s.%I IS NOT NULL',sa.attname),' AND ' ORDER BY key.ord) AS present,
        string_agg(format('t.%I = s.%I',da.attname,sa.attname),' AND ' ORDER BY key.ord) AS equality
 FROM pg_constraint co
 JOIN pg_class src ON src.oid=co.conrelid
 JOIN pg_namespace sn ON sn.oid=src.relnamespace
 JOIN pg_class dst ON dst.oid=co.confrelid
 JOIN pg_namespace dn ON dn.oid=dst.relnamespace
 CROSS JOIN LATERAL unnest(co.conkey,co.confkey,co.conpfeqop)
   WITH ORDINALITY AS key(src_attnum,dst_attnum,operator_oid,ord)
 JOIN pg_attribute sa ON sa.attrelid=src.oid AND sa.attnum=key.src_attnum
 JOIN pg_attribute da ON da.attrelid=dst.oid AND da.attnum=key.dst_attnum
 JOIN pg_operator op ON op.oid=key.operator_oid
 JOIN pg_namespace onsp ON onsp.oid=op.oprnamespace
 WHERE co.contype='f' AND sn.nspname IN ('public','private','powerhub_private')
 GROUP BY sn.nspname,src.relname,co.conname,dn.nspname,dst.relname,
          co.convalidated,co.confmatchtype
)
SELECT format(
 'SELECT jsonb_build_object(''schema'',%L,''table'',%L,''name'',%L,''validated'',%L::boolean,''match'',%L,''operator_ok'',%L::boolean,''violations'',count(*)::bigint)::text FROM %I.%I AS s WHERE %s AND NOT EXISTS (SELECT 1 FROM %I.%I AS t WHERE %s);',
 src_schema,src_table,name,validated,match_type,operator_ok,
 src_schema,src_table,present,dst_schema,dst_table,equality)
FROM fks ORDER BY src_schema,src_table,name
\gexec
COMMIT;
