-- Disposable PostgreSQL 17 only: A4 two-session GL approval racing.
\set ON_ERROR_STOP on
DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END;$roles$;
CREATE TABLE public.tenants(id bigint PRIMARY KEY);
CREATE TABLE public.sites(id bigint PRIMARY KEY,tenant_id bigint NOT NULL REFERENCES public.tenants(id),status text NOT NULL);
CREATE TABLE public.users(id bigint PRIMARY KEY);
INSERT INTO public.tenants VALUES(901),(902);
INSERT INTO public.sites VALUES(9101,901,'active'),(9201,902,'active');
INSERT INTO public.users VALUES(9901),(9902);
\ir ../migrations/20261109190000_powerhub_financial_accrual_adjustment_journal.sql
\ir ../migrations/20261110001000_powerhub_financial_accrual_journal_serialization.sql
CREATE TABLE public.financial_accrual_period_reviews(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id bigint NOT NULL,site_id bigint NOT NULL,period text NOT NULL,
 status text NOT NULL
);
\ir ../migrations/20261110005000_powerhub_financial_gl_foundation.sql
\ir ../migrations/20261110010000_powerhub_financial_gl_post_approved_accrual.sql
