-- Isolated characterization of captured Staging routine, and minimal candidate.
-- Never a migration. Authorization helpers are synthetic stubs: no full JWT/RLS proof.
-- Captured definition SHA256: 9adf594ab2a83590e08ecd3944091d694c79457f6bd86a6c5e22c1bf12d22d68
\set ON_ERROR_STOP on
DO $guard$ BEGIN IF current_database() <> 'pr359_chat_receipt_characterization' THEN RAISE EXCEPTION 'disposable fixture database required'; END IF; END $guard$;
BEGIN;
CREATE SCHEMA private;
CREATE TABLE public.chat_conversations(id bigint PRIMARY KEY, tenant_id bigint NOT NULL);
CREATE TABLE public.chat_messages(id bigint PRIMARY KEY, conversation_id bigint NOT NULL, tenant_id bigint NOT NULL, sender_user_id bigint, created_at timestamptz NOT NULL, visibility text NOT NULL);
CREATE TABLE public.chat_message_receipts(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id bigint NOT NULL, conversation_id bigint NOT NULL, message_id bigint NOT NULL, user_id bigint NOT NULL, delivered_at timestamptz, read_at timestamptz, updated_at timestamptz DEFAULT now(), UNIQUE(message_id,user_id));
CREATE TABLE public.chat_participants(conversation_id bigint, user_id bigint, left_at timestamptz, last_read_message_id bigint, last_read_at timestamptz, updated_at timestamptz);
CREATE FUNCTION private.chat_current_user_id() RETURNS bigint LANGUAGE sql AS $$ SELECT 10::bigint $$;
CREATE FUNCTION private.chat_can_access_conversation(bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT $1=1 $$;
CREATE FUNCTION private.powerhub_has_platform_capability(text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
INSERT INTO public.chat_conversations VALUES(1,1),(2,2);
INSERT INTO public.chat_messages VALUES
 (100,1,1,20,'2026-01-01T00:00:00Z','public'),
 (101,1,1,20,'2026-01-01T00:01:00Z','public'),
 (102,1,1,20,'2026-01-01T00:02:00Z','internal'),
 (200,2,2,30,'2026-01-01T00:00:00Z','public');
INSERT INTO public.chat_participants(conversation_id,user_id) VALUES(1,10);
INSERT INTO public.chat_message_receipts(tenant_id,conversation_id,message_id,user_id,delivered_at) VALUES(1,1,100,10,'2026-01-01T00:00:30Z');
CREATE OR REPLACE FUNCTION private.chat_mark_read_up_to(p_conversation_id bigint, p_message_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id bigint;
  v_tenant_id bigint;
  v_target_created_at timestamptz;
  v_target_visibility text;
  v_count bigint;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;

  select c.tenant_id, m.created_at, m.visibility
    into v_tenant_id, v_target_created_at, v_target_visibility
  from public.chat_conversations c
  join public.chat_messages m
    on m.id = p_message_id and m.conversation_id = c.id
  where c.id = p_conversation_id;

  if v_tenant_id is null then raise exception 'NOT_FOUND'; end if;

  if not private.chat_can_access_conversation(p_conversation_id)
     or (v_target_visibility='internal' and not private.powerhub_has_platform_capability('manageSupportChat')) then
    raise exception 'FORBIDDEN';
  end if;

  insert into public.chat_message_receipts (
    tenant_id, conversation_id, message_id, user_id, delivered_at, read_at
  )
  select
    m.tenant_id,
    m.conversation_id,
    m.id,
    v_user_id,
    coalesce(r.delivered_at, now()),
    coalesce(r.read_at, now())
  from public.chat_messages m
  left join public.chat_message_receipts r
    on r.message_id = m.id and r.user_id = v_user_id
  where m.conversation_id = p_conversation_id
    and m.created_at <= v_target_created_at
    and m.sender_user_id is distinct from v_user_id
    and (m.visibility='public' or private.powerhub_has_platform_capability('manageSupportChat'))
    and r.id is null
  on conflict (message_id, user_id) do update
    set delivered_at = coalesce(public.chat_message_receipts.delivered_at, excluded.delivered_at),
        read_at = coalesce(public.chat_message_receipts.read_at, excluded.read_at),
        updated_at = now();

  update public.chat_participants
  set last_read_message_id = p_message_id,
      last_read_at = now(),
      updated_at = now()
  where conversation_id = p_conversation_id
    and user_id = v_user_id
    and left_at is null;

  select count(*) into v_count
  from public.chat_message_receipts r
  where r.conversation_id = p_conversation_id
    and r.user_id = v_user_id
    and r.read_at is not null
    and r.updated_at >= now() - interval '1 second';

  return v_count;
end;
$function$

DO $characterize$ BEGIN
 PERFORM private.chat_mark_read_up_to(1,101);
 IF NOT EXISTS(SELECT 1 FROM public.chat_message_receipts WHERE message_id=100 AND user_id=10 AND read_at IS NULL) THEN RAISE EXCEPTION 'expected historical delivered-only gap was not reproduced'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.chat_message_receipts WHERE message_id=101 AND user_id=10 AND read_at IS NOT NULL) THEN RAISE EXCEPTION 'baseline new receipt missing'; END IF;
END $characterize$;
SELECT 'PR359_CHAT_DELIVERED_ONLY_GAP_CHARACTERIZED';
CREATE OR REPLACE FUNCTION private.chat_mark_read_up_to(p_conversation_id bigint, p_message_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id bigint;
  v_tenant_id bigint;
  v_target_created_at timestamptz;
  v_target_visibility text;
  v_count bigint;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;

  select c.tenant_id, m.created_at, m.visibility
    into v_tenant_id, v_target_created_at, v_target_visibility
  from public.chat_conversations c
  join public.chat_messages m
    on m.id = p_message_id and m.conversation_id = c.id
  where c.id = p_conversation_id;

  if v_tenant_id is null then raise exception 'NOT_FOUND'; end if;

  if not private.chat_can_access_conversation(p_conversation_id)
     or (v_target_visibility='internal' and not private.powerhub_has_platform_capability('manageSupportChat')) then
    raise exception 'FORBIDDEN';
  end if;

  insert into public.chat_message_receipts (
    tenant_id, conversation_id, message_id, user_id, delivered_at, read_at
  )
  select
    m.tenant_id,
    m.conversation_id,
    m.id,
    v_user_id,
    coalesce(r.delivered_at, now()),
    coalesce(r.read_at, now())
  from public.chat_messages m
  left join public.chat_message_receipts r
    on r.message_id = m.id and r.user_id = v_user_id
  where m.conversation_id = p_conversation_id
    and m.created_at <= v_target_created_at
    and m.sender_user_id is distinct from v_user_id
    and (m.visibility='public' or private.powerhub_has_platform_capability('manageSupportChat'))
    and (r.id is null or r.read_at is null)
  on conflict (message_id, user_id) do update
    set delivered_at = coalesce(public.chat_message_receipts.delivered_at, excluded.delivered_at),
        read_at = coalesce(public.chat_message_receipts.read_at, excluded.read_at),
        updated_at = now();

  update public.chat_participants
  set last_read_message_id = p_message_id,
      last_read_at = now(),
      updated_at = now()
  where conversation_id = p_conversation_id
    and user_id = v_user_id
    and left_at is null;

  select count(*) into v_count
  from public.chat_message_receipts r
  where r.conversation_id = p_conversation_id
    and r.user_id = v_user_id
    and r.read_at is not null
    and r.updated_at >= now() - interval '1 second';

  return v_count;
end;
$function$

DO $candidate$ DECLARE v_denied boolean:=false; v_read timestamptz; BEGIN
 PERFORM private.chat_mark_read_up_to(1,101);
 SELECT read_at INTO v_read FROM public.chat_message_receipts WHERE message_id=100 AND user_id=10 AND delivered_at='2026-01-01T00:00:30Z';
 IF v_read IS NULL THEN RAISE EXCEPTION 'candidate failed delivered-only transition'; END IF;
 PERFORM private.chat_mark_read_up_to(1,101);
 IF (SELECT read_at FROM public.chat_message_receipts WHERE message_id=100 AND user_id=10) IS DISTINCT FROM v_read THEN RAISE EXCEPTION 'candidate changed existing read timestamp'; END IF;
 BEGIN PERFORM private.chat_mark_read_up_to(2,200); EXCEPTION WHEN OTHERS THEN IF SQLERRM='FORBIDDEN' THEN v_denied:=true; ELSE RAISE; END IF; END;
 IF NOT v_denied THEN RAISE EXCEPTION 'candidate crossed conversation access'; END IF;
 IF EXISTS(SELECT 1 FROM public.chat_message_receipts WHERE message_id IN (102,200)) THEN RAISE EXCEPTION 'candidate created unrelated receipt'; END IF;
END $candidate$;
SELECT 'PR359_CHAT_DELIVERED_ONLY_CANDIDATE_PASS';
ROLLBACK;
