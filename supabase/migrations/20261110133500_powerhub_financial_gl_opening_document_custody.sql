-- A28: independently reviewable custody of opening source-file bytes.
-- A SHA typed by a user is NOT proof that a file exists. The server hashes
-- downloaded bytes before reviewing the evidence. No automatic certification,
-- no existing opening/GL/evidence modification or retroactive attestation.
-- Access to all rows is service-role only, and reviewers remain site-scoped.
CREATE TABLE public.financial_gl_opening_document_custody (
 evidence_id bigint PRIMARY KEY
   REFERENCES public.financial_gl_opening_evidence(id) ON DELETE RESTRICT,
 tenant_id bigint NOT NULL REFERENCES public.tenants(id),
 site_id bigint NOT NULL REFERENCES public.sites(id),
 opening_id bigint NOT NULL,
 opening_line_id bigint NOT NULL
   REFERENCES public.financial_gl_opening_lines(id),
 storage_key text NOT NULL UNIQUE
   CHECK(length(storage_key) BETWEEN 40 AND 400),
 document_sha256 text NOT NULL
   CHECK(document_sha256 ~ '^[0-9a-f]{64}$'),
 mime_type text NOT NULL CHECK(mime_type IN (
   'application/pdf','image/jpeg','image/png','image/webp')),
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 5242880),
 recorded_by_user_id bigint NOT NULL REFERENCES public.users(id),
 recorded_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX financial_gl_opening_document_custody_scope_idx
 ON public.financial_gl_opening_document_custody(tenant_id,site_id,opening_id);
ALTER TABLE public.financial_gl_opening_document_custody ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_gl_opening_document_custody
 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.financial_gl_opening_document_custody
 TO service_role;
CREATE POLICY financial_gl_opening_document_custody_service
 ON public.financial_gl_opening_document_custody TO service_role
 USING(true) WITH CHECK(true);

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_document_custody_guard()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog,public,pg_temp AS $guard$
DECLARE e public.financial_gl_opening_evidence%ROWTYPE;
BEGIN
 IF TG_OP IN('UPDATE','DELETE') THEN
   RAISE EXCEPTION 'GL_OPENING_DOCUMENT_CUSTODY_IMMUTABLE'
     USING ERRCODE='22023';
 END IF;
 SELECT * INTO e FROM public.financial_gl_opening_evidence
 WHERE id=NEW.evidence_id FOR SHARE;
 IF NOT FOUND OR e.review_status<>'pending'
  OR e.tenant_id<>NEW.tenant_id OR e.site_id<>NEW.site_id
  OR e.opening_id<>NEW.opening_id
  OR e.opening_line_id<>NEW.opening_line_id
  OR e.prepared_by_user_id<>NEW.recorded_by_user_id
 THEN RAISE EXCEPTION 'GL_OPENING_DOCUMENT_CUSTODY_SCOPE_MISMATCH'
   USING ERRCODE='22023';END IF;
 IF e.source_document_sha256<>NEW.document_sha256 THEN
   RAISE EXCEPTION 'GL_OPENING_DOCUMENT_CUSTODY_HASH_MISMATCH'
     USING ERRCODE='23514';END IF;
 IF NEW.storage_key NOT LIKE
  ('financial-opening-evidence/'||NEW.tenant_id||'/'||
   NEW.site_id||'/'||NEW.opening_id||'/'||NEW.opening_line_id||'/%')
  OR NEW.storage_key !~ '^[a-zA-Z0-9/_-]+[.](pdf|jpg|jpeg|png|webp)$'
 THEN RAISE EXCEPTION 'GL_OPENING_DOCUMENT_CUSTODY_STORAGE_SCOPE_INVALID'
   USING ERRCODE='22023';END IF;
 RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_document_custody_guard()
 FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zz_gl_opening_document_custody_guard
 BEFORE INSERT OR UPDATE OR DELETE
 ON public.financial_gl_opening_document_custody
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_opening_document_custody_guard();
CREATE TRIGGER zz_gl_opening_document_custody_truncate_guard
 BEFORE TRUNCATE ON public.financial_gl_opening_document_custody
 FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_gl_immutable_guard();
-- Approval cannot be obtained by typing a plausible SHA-256 while omitting
-- source-file custody. Database checks presence/scope; the privileged server
-- MUST independently re-download and re-hash the bytes before calling review.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_custody_review_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $gate$
BEGIN
 IF NEW.review_status='verified' AND OLD.review_status='pending'
 AND NOT EXISTS(
   SELECT 1 FROM public.financial_gl_opening_document_custody c
   WHERE c.evidence_id=NEW.id AND c.tenant_id=NEW.tenant_id
     AND c.site_id=NEW.site_id AND c.opening_id=NEW.opening_id
     AND c.opening_line_id=NEW.opening_line_id
     AND c.document_sha256=NEW.source_document_sha256
 ) THEN
   RAISE EXCEPTION 'GL_OPENING_DOCUMENT_CUSTODY_REQUIRED'
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$gate$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_custody_review_gate()
 FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zzz_gl_opening_document_custody_review_gate
 BEFORE UPDATE ON public.financial_gl_opening_evidence
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_opening_custody_review_gate();
COMMENT ON TABLE public.financial_gl_opening_document_custody IS
 'Immutable server-hashed private document custody. Independent external origin and source-subledger reconciliation are separate gates; never certifies accounting.';
NOTIFY pgrst,'reload schema';

 THEN RAISE EXCEPTION 'GL_OPENING_DOCUMENT_CUSTODY_STORAGE_SCOPE_INVALID'
   USING ERRCODE='22023';END IF;
 RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_document_custody_guard()
 FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zz_gl_opening_document_custody_guard
 BEFORE INSERT OR UPDATE OR DELETE
 ON public.financial_gl_opening_document_custody
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_opening_document_custody_guard();
CREATE TRIGGER zz_gl_opening_document_custody_truncate_guard
 BEFORE TRUNCATE ON public.financial_gl_opening_document_custody
 FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_gl_immutable_guard();
COMMENT ON TABLE public.financial_gl_opening_document_custody IS
 'Immutable server-hashed private document custody. Independent external origin and source-subledger reconciliation are separate gates; never certifies accounting.';
NOTIFY pgrst,'reload schema';
