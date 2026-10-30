\set ON_ERROR_STOP on

CREATE TABLE public.access_invitations (
  id bigint PRIMARY KEY, tenant_id bigint NOT NULL, email text NOT NULL,
  status text NOT NULL, token_hash text NOT NULL UNIQUE
);
CREATE TABLE public.custom_permission_roles (
  id bigint PRIMARY KEY, tenant_id bigint NOT NULL, created_by_user_id bigint NOT NULL,
  name text NOT NULL, UNIQUE (tenant_id,name)
);
CREATE TABLE public.platform_access_invitations (
  id bigint PRIMARY KEY, email text NOT NULL, status text NOT NULL, token_hash text NOT NULL UNIQUE
);

INSERT INTO public.access_invitations VALUES (1,10,'tenant@example.test','invited','tenant-token');
INSERT INTO public.custom_permission_roles VALUES (1,10,100,'المحاسب');
INSERT INTO public.platform_access_invitations VALUES (1,'admin@example.test','invited','platform-token');

\ir ../migrations/20261030220000_powerhub_missing_idempotency_schema_reconcile.sql
\ir ../migrations/20261030220000_powerhub_missing_idempotency_schema_reconcile.sql

DO $assert_schema$
DECLARE
  v_table text;
  v_column text;
  v_index text;
  v_expected constant text[][] := ARRAY[
    ['access_invitations','client_operation_id','access_invitations_client_operation_id_uidx'],
    ['access_invitations','request_fingerprint','access_invitations_tenant_email_status_idx'],
    ['custom_permission_roles','client_operation_id','custom_permission_roles_operation_uidx'],
    ['custom_permission_roles','request_fingerprint','custom_permission_roles_operation_uidx'],
    ['platform_access_invitations','client_operation_id','platform_access_invitations_client_operation_id_uidx'],
    ['platform_access_invitations','request_fingerprint','platform_access_invitations_client_operation_id_uidx']
  ];
  i integer;
BEGIN
  FOR i IN 1..array_length(v_expected,1) LOOP
    v_table := v_expected[i][1];
    v_column := v_expected[i][2];
    v_index := v_expected[i][3];
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=v_table AND column_name=v_column AND data_type='text'
    ) THEN RAISE EXCEPTION 'IDEMPOTENCY_COLUMN_MISSING: %.%',v_table,v_column; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=v_index
    ) THEN RAISE EXCEPTION 'IDEMPOTENCY_INDEX_MISSING: %',v_index; END IF;
  END LOOP;

  IF (SELECT count(*) FROM public.access_invitations) <> 1
     OR (SELECT count(*) FROM public.custom_permission_roles) <> 1
     OR (SELECT count(*) FROM public.platform_access_invitations) <> 1 THEN
    RAISE EXCEPTION 'EXISTING_ROWS_CHANGED_DURING_IDEMPOTENCY_RECONCILE';
  END IF;
END
$assert_schema$;

INSERT INTO public.access_invitations(id,tenant_id,email,status,token_hash,client_operation_id,request_fingerprint)
VALUES (2,10,'second@example.test','invited','tenant-token-2','op-1','fp-1');
DO $assert_unique$
BEGIN
  BEGIN
    INSERT INTO public.access_invitations(id,tenant_id,email,status,token_hash,client_operation_id,request_fingerprint)
    VALUES (3,10,'third@example.test','invited','tenant-token-3','op-1','fp-2');
    RAISE EXCEPTION 'ACCESS_INVITATION_OPERATION_DUPLICATE_ALLOWED';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$assert_unique$;

INSERT INTO public.custom_permission_roles(id,tenant_id,created_by_user_id,name,client_operation_id,request_fingerprint)
VALUES (2,10,100,'الدعم','role-op-1','role-fp-1');
DO $assert_custom_unique$
BEGIN
  BEGIN
    INSERT INTO public.custom_permission_roles(id,tenant_id,created_by_user_id,name,client_operation_id,request_fingerprint)
    VALUES (3,10,100,'العمليات','role-op-1','role-fp-2');
    RAISE EXCEPTION 'CUSTOM_ROLE_OPERATION_DUPLICATE_ALLOWED';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$assert_custom_unique$;

INSERT INTO public.platform_access_invitations(id,email,status,token_hash,client_operation_id,request_fingerprint)
VALUES (2,'second-admin@example.test','invited','platform-token-2','platform-op-1','platform-fp-1');
DO $assert_platform_unique$
BEGIN
  BEGIN
    INSERT INTO public.platform_access_invitations(id,email,status,token_hash,client_operation_id,request_fingerprint)
    VALUES (3,'third-admin@example.test','invited','platform-token-3','platform-op-1','platform-fp-2');
    RAISE EXCEPTION 'PLATFORM_INVITATION_OPERATION_DUPLICATE_ALLOWED';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$assert_platform_unique$;

SELECT 'missing idempotency schema reconciliation passed: 6 columns, 4 indexes, preserved rows, duplicate replay guards' AS result;
