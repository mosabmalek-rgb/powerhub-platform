-- Phase A2: additive general-ledger foundation.
-- IMPORTANT: no source postings or opening balances are imported by this migration.
-- No final P&L/balance sheet may consume these empty tables as complete.
-- Activation of financial posting requires a later audited, atomic source-to-ledger RPC.
CREATE TABLE IF NOT EXISTS public.financial_gl_accounts (
  tenant_id bigint NOT NULL REFERENCES public.tenants(id),
  code text NOT NULL CHECK (code ~ '^[0-9]{3,8}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 160),
  account_class text NOT NULL CHECK (account_class IN
    ('asset','liability','equity','revenue','expense')),
  normal_side text NOT NULL CHECK (normal_side IN ('debit','credit')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,code),
  CONSTRAINT financial_gl_accounts_natural_side CHECK (
    (account_class IN ('asset','expense') AND normal_side='debit') OR
    (account_class IN ('liability','equity','revenue') AND normal_side='credit'))
);
CREATE TABLE IF NOT EXISTS public.financial_gl_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES public.tenants(id),
  site_id bigint NOT NULL REFERENCES public.sites(id),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  source_type text NOT NULL CHECK (source_type IN
   ('opening_balance','accrual_adjustment','invoice','payment','expense','payroll',
    'stock_movement','supplier_ledger','account_movement','asset_depreciation',
    'provision','tax','correction')),
  source_id text NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 180),
  source_revision integer NOT NULL DEFAULT 1 CHECK (source_revision>0),
  operation_key text NOT NULL CHECK (length(btrim(operation_key)) BETWEEN 8 AND 180),
  source_fingerprint text NOT NULL CHECK
    (source_fingerprint ~ '^[0-9a-f]{64}$'),
  accounting_policy_version text NOT NULL CHECK
    (length(btrim(accounting_policy_version)) BETWEEN 3 AND 100),
  posted_by_user_id bigint NOT NULL REFERENCES public.users(id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  reverses_entry_id bigint,
  CONSTRAINT financial_gl_reversal_same_scope FOREIGN KEY
    (reverses_entry_id,tenant_id,site_id)
    REFERENCES public.financial_gl_entries(id,tenant_id,site_id),
  CONSTRAINT financial_gl_entries_scope UNIQUE (id,tenant_id,site_id),
  CONSTRAINT financial_gl_entry_source_unique UNIQUE
    (tenant_id,site_id,source_type,source_id,source_revision),
  CONSTRAINT financial_gl_entry_operation_unique UNIQUE
    (tenant_id,site_id,operation_key),
  CONSTRAINT financial_gl_no_self_reversal CHECK
    (reverses_entry_id IS NULL OR reverses_entry_id<>id)
);
CREATE INDEX IF NOT EXISTS financial_gl_period_idx
 ON public.financial_gl_entries(tenant_id,site_id,period,id);
CREATE UNIQUE INDEX IF NOT EXISTS financial_gl_active_reversal_unique
 ON public.financial_gl_entries(reverses_entry_id)
 WHERE reverses_entry_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.financial_gl_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id bigint NOT NULL,
  tenant_id bigint NOT NULL,
  site_id bigint NOT NULL,
  account_code text NOT NULL,
  side text NOT NULL CHECK (side IN ('debit','credit')),
  amount numeric(18,2) NOT NULL CHECK (amount>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_gl_line_entry_scope FOREIGN KEY (entry_id,tenant_id,site_id)
    REFERENCES public.financial_gl_entries(id,tenant_id,site_id),
  CONSTRAINT financial_gl_line_account_scope FOREIGN KEY (tenant_id,account_code)
    REFERENCES public.financial_gl_accounts(tenant_id,code)
);
CREATE INDEX IF NOT EXISTS financial_gl_line_entry_idx
 ON public.financial_gl_lines(tenant_id,site_id,entry_id);
CREATE INDEX IF NOT EXISTS financial_gl_line_account_idx
 ON public.financial_gl_lines(tenant_id,account_code,entry_id);

-- Site/tenant association is independently checked on the header. A single-column
-- FK to sites(id) alone is not sufficient for tenant isolation.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_scope_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM public.sites s
   WHERE s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id
     AND s.status<>'archived'
 ) THEN
   RAISE EXCEPTION 'FINANCIAL_GL_SITE_OUT_OF_SCOPE' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END;
$fn$;
CREATE TRIGGER financial_gl_entry_scope_guard
 BEFORE INSERT ON public.financial_gl_entries
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_scope_guard();

-- Every ledger header MUST have at least two lines and balanced sides before commit,
-- including when an administrative transaction tries inserting records directly.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_balance_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE v_id bigint; v_total numeric; v_count bigint;
BEGIN
  IF TG_TABLE_NAME='financial_gl_entries' THEN
    v_id:=NEW.id;
  ELSIF TG_TABLE_NAME='financial_gl_lines' THEN
    v_id:=NEW.entry_id;
  ELSE
    RAISE EXCEPTION 'FINANCIAL_GL_UNKNOWN_TRIGGER_SOURCE' USING ERRCODE='22023';
  END IF;
  SELECT count(*),
    coalesce(sum(CASE WHEN side='debit' THEN amount ELSE -amount END),0)
    INTO v_count,v_total FROM public.financial_gl_lines WHERE entry_id=v_id;
  IF v_count<2 OR v_total<>0 THEN
    RAISE EXCEPTION 'FINANCIAL_GL_ENTRY_NOT_BALANCED' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$fn$;
CREATE CONSTRAINT TRIGGER financial_gl_entry_balanced
 AFTER INSERT ON public.financial_gl_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.powerhub_financial_gl_balance_guard();
CREATE CONSTRAINT TRIGGER financial_gl_line_balanced
 AFTER INSERT ON public.financial_gl_lines
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.powerhub_financial_gl_balance_guard();

-- A posted GL record is immutable. Correct it only through a separately approved
-- reversing entry in a later controlled source-to-GL posting phase.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_immutable_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'FINANCIAL_GL_IMMUTABLE' USING ERRCODE='22023';
END;
$fn$;
CREATE TRIGGER financial_gl_accounts_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON public.financial_gl_accounts
 FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_gl_immutable_guard();
CREATE TRIGGER financial_gl_entries_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON public.financial_gl_entries
 FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_gl_immutable_guard();
CREATE TRIGGER financial_gl_lines_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON public.financial_gl_lines
 FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_gl_immutable_guard();

ALTER TABLE public.financial_gl_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_gl_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_gl_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_gl_accounts FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.financial_gl_entries FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.financial_gl_lines FROM PUBLIC,anon,authenticated;
-- No client role may write. Server-side posting will be introduced only
-- with atomic source reconciliation and explicit tenant/site authorization.
GRANT SELECT ON public.financial_gl_accounts TO service_role;
GRANT SELECT ON public.financial_gl_entries TO service_role;
GRANT SELECT ON public.financial_gl_lines TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_scope_guard()
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_balance_guard()
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_immutable_guard()
 FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE public.financial_gl_entries IS
 'A2 schema foundation only. No legacy source backfill or GL posting enabled. Do not certify statements.';
NOTIFY pgrst,'reload schema';
