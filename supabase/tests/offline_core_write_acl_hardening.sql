\set ON_ERROR_STOP on

do $roles$
begin create role anon nologin; exception when duplicate_object then null; end
$roles$;
do $roles$
begin create role authenticated nologin; exception when duplicate_object then null; end
$roles$;
do $roles$
begin create role service_role nologin bypassrls; exception when duplicate_object then null; end
$roles$;

create table public.invoices (id bigint primary key);
create table public.offline_sync_operations (id bigint primary key);
create table public.payments (id bigint primary key);
create table public.subscribers (id bigint primary key);

create function public.powerhub_update_subscriber(
  bigint, bigint, bigint, bigint, text, text, text, text, text, timestamptz, uuid
) returns void language plpgsql as $function$ begin null; end $function$;

create function public.powerhub_approve_payment_documentation(
  bigint, bigint, bigint, bigint
) returns void language plpgsql as $function$ begin null; end $function$;

-- Recreate the observed overbroad staging grants, including grants inherited from PUBLIC.
grant all privileges on table
  public.invoices, public.offline_sync_operations, public.payments, public.subscribers
  to public, anon, authenticated, service_role;
grant execute on function public.powerhub_update_subscriber(
  bigint, bigint, bigint, bigint, text, text, text, text, text, timestamptz, uuid
) to public, anon, authenticated, service_role;
grant execute on function public.powerhub_approve_payment_documentation(
  bigint, bigint, bigint, bigint
) to public, anon, authenticated, service_role;

\ir ../migrations/20261024210000_powerhub_offline_write_acl_hardening.sql

do $assert_acl$
declare
  v_table text;
  v_role text;
  v_privilege text;
begin
  foreach v_table in array array['invoices','offline_sync_operations','payments','subscribers'] loop
    if not has_table_privilege('anon', format('public.%I',v_table), 'SELECT') then
      raise exception 'ANON_READ_REMOVED_ON_%',v_table;
    end if;
    if not has_table_privilege('authenticated', format('public.%I',v_table), 'SELECT') then
      raise exception 'AUTHENTICATED_READ_REMOVED_ON_%',v_table;
    end if;

    foreach v_role in array array['anon','authenticated'] loop
      foreach v_privilege in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
        if has_table_privilege(v_role, format('public.%I',v_table), v_privilege) then
          raise exception 'DIRECT_%_STILL_GRANTED_TO_%_ON_%',v_privilege,v_role,v_table;
        end if;
      end loop;
    end loop;

    foreach v_privilege in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      if not has_table_privilege('service_role', format('public.%I',v_table), v_privilege) then
        raise exception 'SERVICE_ROLE_%_REMOVED_ON_%',v_privilege,v_table;
      end if;
    end loop;
  end loop;

  if has_function_privilege('anon',
    'public.powerhub_update_subscriber(bigint,bigint,bigint,bigint,text,text,text,text,text,timestamptz,uuid)'::regprocedure,
    'EXECUTE')
    or has_function_privilege('authenticated',
    'public.powerhub_update_subscriber(bigint,bigint,bigint,bigint,text,text,text,text,text,timestamptz,uuid)'::regprocedure,
    'EXECUTE') then
    raise exception 'BROWSER_ROLE_SUBSCRIBER_UPDATE_RPC_EXECUTE_REMAINS';
  end if;
  if not has_function_privilege('service_role',
    'public.powerhub_update_subscriber(bigint,bigint,bigint,bigint,text,text,text,text,text,timestamptz,uuid)'::regprocedure,
    'EXECUTE') then
    raise exception 'SERVICE_ROLE_SUBSCRIBER_UPDATE_RPC_EXECUTE_REMOVED';
  end if;

  if has_function_privilege('anon',
    'public.powerhub_approve_payment_documentation(bigint,bigint,bigint,bigint)'::regprocedure,
    'EXECUTE')
    or has_function_privilege('authenticated',
    'public.powerhub_approve_payment_documentation(bigint,bigint,bigint,bigint)'::regprocedure,
    'EXECUTE') then
    raise exception 'BROWSER_ROLE_PAYMENT_APPROVAL_RPC_EXECUTE_REMAINS';
  end if;
  if not has_function_privilege('service_role',
    'public.powerhub_approve_payment_documentation(bigint,bigint,bigint,bigint)'::regprocedure,
    'EXECUTE') then
    raise exception 'SERVICE_ROLE_PAYMENT_APPROVAL_RPC_EXECUTE_REMOVED';
  end if;
end
$assert_acl$;

select 'offline sync core write ACL migration passed' as result;
