-- B5.18: PostgREST invokes STABLE RPCs in READ ONLY transactions even with POST.
-- The B1 site statement performs source-integrity verification. That verifier
-- reuses the source planner, whose SELECT ... FOR SHARE statements MUST retain
-- their existing locks for posting consistency. READ ONLY RPC would raise 25006.
--
-- Mark only the report entrypoint VOLATILE so PostgREST accepts the POST RPC
-- in a READ WRITE transaction. The implementation remains entirely read-only:
-- this is NOT a permission change, ledger mutation or accounting approval.
-- Keep source planner row locks intact. Never expose this RPC to anon/authenticated.
ALTER FUNCTION public.powerhub_financial_gl_site_statements(bigint,bigint,text) VOLATILE;
