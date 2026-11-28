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
$function$;

DO $characterize$ BEGIN
 PERFORM private.chat_mark_read_up_to(1,101);
 IF NOT EXISTS(SELECT 1 FROM public.chat_message_receipts WHERE message_id=100 AND user_id=10 AND read_at IS NULL) THEN RAISE EXCEPTION 'expected historical delivered-only gap was not reproduced'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.chat_message_receipts WHERE message_id=101 AND user_id=10 AND read_at IS NOT NULL) THEN RAISE EXCEPTION 'baseline new receipt missing'; END IF;
END $characterize$;
DO $characterize_pointer_count$
DECLARE v_repeat bigint;
BEGIN
 v_repeat:=private.chat_mark_read_up_to(1,101);
 IF v_repeat<1 THEN RAISE EXCEPTION 'expected historical replay count defect was not reproduced'; END IF;
 PERFORM private.chat_mark_read_up_to(1,100);
 IF (SELECT last_read_message_id FROM public.chat_participants WHERE conversation_id=1 AND user_id=10) IS DISTINCT FROM 100::bigint THEN
   RAISE EXCEPTION 'expected historical pointer regression was not reproduced';
 END IF;
 PERFORM private.chat_mark_read_up_to(1,101);
END $characterize_pointer_count$;
SELECT 'PR359_CHAT_POINTER_AND_COUNT_GAPS_CHARACTERIZED';
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
    and (m.created_at, m.id) <= (v_target_created_at, p_message_id)
    and m.sender_user_id is distinct from v_user_id
    and (m.visibility='public' or private.powerhub_has_platform_capability('manageSupportChat'))
    and (r.id is null or r.read_at is null)
  on conflict (message_id, user_id) do update
    set delivered_at = coalesce(public.chat_message_receipts.delivered_at, excluded.delivered_at),
        read_at = coalesce(public.chat_message_receipts.read_at, excluded.read_at),
        updated_at = now()
    where public.chat_message_receipts.read_at is null;
  get diagnostics v_count = row_count;

  update public.chat_participants cp
  set last_read_message_id = p_message_id,
      last_read_at = now(),
      updated_at = now()
  where cp.conversation_id = p_conversation_id
    and cp.user_id = v_user_id
    and cp.left_at is null
    and (
      cp.last_read_message_id is null or exists (
        select 1 from public.chat_messages prev
        where prev.id = cp.last_read_message_id
          and prev.conversation_id = p_conversation_id
          and (prev.created_at, prev.id) < (v_target_created_at, p_message_id)
      )
    );

  return v_count;
end;
$function$;

-- Add a later ID with the same timestamp as the target after the baseline runs.
INSERT INTO public.chat_messages VALUES(103,1,1,20,'2026-01-01T00:01:00Z','public');
DO $candidate$ DECLARE v_denied boolean:=false; v_read timestamptz; v_count bigint; BEGIN
 v_count:=private.chat_mark_read_up_to(1,101);
 IF v_count IS DISTINCT FROM 1::bigint THEN RAISE EXCEPTION 'candidate must count one newly read receipt: %',v_count; END IF;
 SELECT read_at INTO v_read FROM public.chat_message_receipts WHERE message_id=100 AND user_id=10 AND delivered_at='2026-01-01T00:00:30Z';
 IF v_read IS NULL THEN RAISE EXCEPTION 'candidate failed delivered-only transition'; END IF;
 v_count:=private.chat_mark_read_up_to(1,101);
 IF v_count IS DISTINCT FROM 0::bigint THEN RAISE EXCEPTION 'candidate replay must count zero new reads: %',v_count; END IF;
 PERFORM private.chat_mark_read_up_to(1,100);
 IF (SELECT last_read_message_id FROM public.chat_participants WHERE conversation_id=1 AND user_id=10) IS DISTINCT FROM 101::bigint THEN
   RAISE EXCEPTION 'candidate regressed read pointer';
 END IF;
 IF (SELECT read_at FROM public.chat_message_receipts WHERE message_id=100 AND user_id=10) IS DISTINCT FROM v_read THEN RAISE EXCEPTION 'candidate changed existing read timestamp'; END IF;
 BEGIN PERFORM private.chat_mark_read_up_to(2,200); EXCEPTION WHEN OTHERS THEN IF SQLERRM='FORBIDDEN' THEN v_denied:=true; ELSE RAISE; END IF; END;
 IF NOT v_denied THEN RAISE EXCEPTION 'candidate crossed conversation access'; END IF;
 IF EXISTS(SELECT 1 FROM public.chat_message_receipts WHERE message_id IN (102,103,200)) THEN RAISE EXCEPTION 'candidate created unrelated or beyond-target receipt'; END IF;
 v_count:=private.chat_mark_read_up_to(1,103);
 IF v_count IS DISTINCT FROM 1::bigint OR (SELECT last_read_message_id FROM public.chat_participants WHERE conversation_id=1 AND user_id=10) IS DISTINCT FROM 103::bigint THEN
   RAISE EXCEPTION 'candidate failed deterministic same-timestamp forward read';
 END IF;
END $candidate$;
SELECT 'PR359_CHAT_POINTER_COUNT_TIE_CANDIDATE_PASS';
SELECT 'PR359_CHAT_DELIVERED_ONLY_CANDIDATE_PASS';

-- Live private single-read definition, SHA256 907b0646ca7a7d8d6e638fc7e55eeb32b8ff73c932bd875c2323209005a38bde
CREATE OR REPLACE FUNCTION private.chat_mark_read(p_message_id bigint)
 RETURNS chat_message_receipts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_user_id bigint; v_receipt public.chat_message_receipts; v_msg public.chat_messages;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;
  select * into v_msg from public.chat_messages where id=p_message_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not private.chat_can_access_conversation(v_msg.conversation_id)
     or (v_msg.visibility='internal' and not private.powerhub_has_platform_capability('manageSupportChat')) then
    raise exception 'FORBIDDEN';
  end if;
  if v_msg.sender_user_id = v_user_id then raise exception 'INVALID_RECIPIENT'; end if;
  insert into public.chat_message_receipts(tenant_id,conversation_id,message_id,user_id,delivered_at,read_at)
  values(v_msg.tenant_id,v_msg.conversation_id,v_msg.id,v_user_id,now(),now())
  on conflict (message_id,user_id) do update set delivered_at=coalesce(public.chat_message_receipts.delivered_at,now()), read_at=coalesce(public.chat_message_receipts.read_at,now()), updated_at=now()
  returning * into v_receipt;
  update public.chat_participants set last_read_message_id=v_msg.id,last_read_at=now(),updated_at=now() where conversation_id=v_msg.conversation_id and user_id=v_user_id and left_at is null;
  return v_receipt;
end;
$function$;
DO $single_baseline$ BEGIN
 PERFORM private.chat_mark_read(100);
 IF (SELECT last_read_message_id FROM public.chat_participants WHERE conversation_id=1 AND user_id=10) IS DISTINCT FROM 100::bigint THEN
   RAISE EXCEPTION 'expected single-read pointer regression was not reproduced';
 END IF;
 PERFORM private.chat_mark_read_up_to(1,103);
END $single_baseline$;
SELECT 'PR359_CHAT_SINGLE_POINTER_GAP_CHARACTERIZED';

-- Isolated candidate, with the same return contract and access checks.
CREATE OR REPLACE FUNCTION private.chat_mark_read(p_message_id bigint)
 RETURNS chat_message_receipts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_user_id bigint; v_receipt public.chat_message_receipts; v_msg public.chat_messages;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;
  select * into v_msg from public.chat_messages where id=p_message_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not private.chat_can_access_conversation(v_msg.conversation_id)
     or (v_msg.visibility='internal' and not private.powerhub_has_platform_capability('manageSupportChat')) then
    raise exception 'FORBIDDEN';
  end if;
  if v_msg.sender_user_id = v_user_id then raise exception 'INVALID_RECIPIENT'; end if;
  insert into public.chat_message_receipts(tenant_id,conversation_id,message_id,user_id,delivered_at,read_at)
  values(v_msg.tenant_id,v_msg.conversation_id,v_msg.id,v_user_id,now(),now())
  on conflict (message_id,user_id) do update set delivered_at=coalesce(public.chat_message_receipts.delivered_at,now()), read_at=coalesce(public.chat_message_receipts.read_at,now()), updated_at=now()
  returning * into v_receipt;
  update public.chat_participants cp
  set last_read_message_id=v_msg.id,last_read_at=now(),updated_at=now()
  where cp.conversation_id=v_msg.conversation_id and cp.user_id=v_user_id and cp.left_at is null
    and (cp.last_read_message_id is null or exists (
      select 1 from public.chat_messages prev
      where prev.id=cp.last_read_message_id and prev.conversation_id=v_msg.conversation_id
        and (prev.created_at,prev.id)<(v_msg.created_at,v_msg.id)
    ));
  return v_receipt;
end;
$function$;
DO $single_candidate$
DECLARE v_before timestamptz; v_denied boolean:=false; v_receipt public.chat_message_receipts;
BEGIN
 SELECT read_at INTO v_before FROM public.chat_message_receipts WHERE message_id=100 AND user_id=10;
 v_receipt:=private.chat_mark_read(100);
 IF v_receipt.read_at IS DISTINCT FROM v_before OR v_receipt.delivered_at IS DISTINCT FROM '2026-01-01T00:00:30Z'::timestamptz THEN
   RAISE EXCEPTION 'single-read replay changed receipt timestamps';
 END IF;
 IF (SELECT last_read_message_id FROM public.chat_participants WHERE conversation_id=1 AND user_id=10) IS DISTINCT FROM 103::bigint THEN
   RAISE EXCEPTION 'single-read replay regressed pointer';
 END IF;
 INSERT INTO public.chat_messages VALUES(104,1,1,20,'2026-01-01T00:01:00Z','public'),(105,1,1,10,'2026-01-01T00:03:00Z','public');
 v_receipt:=private.chat_mark_read(104);
 IF v_receipt.read_at IS NULL OR (SELECT last_read_message_id FROM public.chat_participants WHERE conversation_id=1 AND user_id=10) IS DISTINCT FROM 104::bigint THEN
   RAISE EXCEPTION 'single-read failed deterministic forward advance';
 END IF;
 PERFORM private.chat_mark_read_up_to(1,103);
 IF (SELECT last_read_message_id FROM public.chat_participants WHERE conversation_id=1 AND user_id=10) IS DISTINCT FROM 104::bigint THEN
   RAISE EXCEPTION 'older bulk request regressed single-read pointer';
 END IF;
 BEGIN PERFORM private.chat_mark_read(200); EXCEPTION WHEN OTHERS THEN IF SQLERRM='FORBIDDEN' THEN v_denied:=true; ELSE RAISE; END IF; END;
 IF NOT v_denied THEN RAISE EXCEPTION 'single read allowed unrelated conversation'; END IF;
 v_denied:=false;
 BEGIN PERFORM private.chat_mark_read(102); EXCEPTION WHEN OTHERS THEN IF SQLERRM='FORBIDDEN' THEN v_denied:=true; ELSE RAISE; END IF; END;
 IF NOT v_denied THEN RAISE EXCEPTION 'single read allowed internal message'; END IF;
 v_denied:=false;
 BEGIN PERFORM private.chat_mark_read(105); EXCEPTION WHEN OTHERS THEN IF SQLERRM='INVALID_RECIPIENT' THEN v_denied:=true; ELSE RAISE; END IF; END;
 IF NOT v_denied THEN RAISE EXCEPTION 'single read allowed own message'; END IF;
 IF EXISTS(SELECT 1 FROM public.chat_message_receipts WHERE message_id IN (102,105,200)) THEN RAISE EXCEPTION 'denied single read created receipt'; END IF;
END $single_candidate$;
SELECT 'PR359_CHAT_SINGLE_BULK_MONOTONIC_CANDIDATE_PASS';

-- Notification scope parity. The access helper is synthetic, not real JWT/RLS.
CREATE TABLE public.chat_inbox_notifications(id bigint PRIMARY KEY,user_id bigint NOT NULL,tenant_id bigint NOT NULL,conversation_id bigint,read_at timestamptz);
CREATE FUNCTION private.chat_rls_can_select_conversation(bigint,bigint) RETURNS boolean LANGUAGE sql AS $ SELECT $1=1 AND $2=1 $;
INSERT INTO public.chat_inbox_notifications VALUES
 (1,10,1,1,NULL),(2,10,2,2,NULL),(3,10,2,1,NULL),
 (4,20,1,1,NULL),(5,10,1,NULL,NULL),(6,10,1,1,'2026-01-01T00:00:00Z');
-- Captured Staging definitions, SHA256:
-- mark all a994cc011e603b055de471a88135d1773a050c7f5cc437c49edcb149a25b7a3d
-- mark one f0a7c8f7eb3d89d7d1fb0728d9883e225d771b4d88e6b5e4741d2ba9d4729e9b
-- unread count 2bd8bf30f73245256422bb3f87a33b920baa0177291124c12de04eac88883839
CREATE OR REPLACE FUNCTION private.chat_mark_all_notifications_read()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id bigint;
  v_count integer;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  update public.chat_inbox_notifications
     set read_at = coalesce(read_at, now())
   where user_id = v_user_id
     and read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
CREATE OR REPLACE FUNCTION private.chat_mark_notification_read(p_notification_id bigint)
 RETURNS chat_inbox_notifications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id bigint; v_row public.chat_inbox_notifications;
BEGIN
  v_user_id:=private.chat_current_user_id();
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  UPDATE public.chat_inbox_notifications n SET read_at=coalesce(n.read_at,now())
  WHERE n.id=p_notification_id AND n.user_id=v_user_id
    AND (n.conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id=n.conversation_id AND c.tenant_id=n.tenant_id
        AND private.chat_rls_can_select_conversation(c.id,c.tenant_id)
    ))
  RETURNING n.* INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  RETURN v_row;
END;
$function$;
CREATE OR REPLACE FUNCTION private.chat_unread_notification_count()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT count(*)::integer FROM public.chat_inbox_notifications n
  WHERE n.user_id=private.chat_current_user_id() AND n.read_at IS NULL
    AND (n.conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id=n.conversation_id AND c.tenant_id=n.tenant_id
        AND private.chat_rls_can_select_conversation(c.id,c.tenant_id)
    ));
$function$;
DO $notification_baseline$ BEGIN
 IF private.chat_unread_notification_count()<>2 OR private.chat_mark_all_notifications_read()<>4 THEN
   RAISE EXCEPTION 'expected notification visibility discrepancy was not reproduced';
 END IF;
 IF EXISTS(SELECT 1 FROM public.chat_inbox_notifications WHERE id IN (2,3) AND read_at IS NULL) THEN
   RAISE EXCEPTION 'baseline did not touch inaccessible notifications';
 END IF;
END $notification_baseline$;
SELECT 'PR359_CHAT_MARK_ALL_VISIBILITY_GAP_CHARACTERIZED';
UPDATE public.chat_inbox_notifications SET read_at=NULL WHERE id IN (1,2,3,4,5);
CREATE OR REPLACE FUNCTION private.chat_mark_all_notifications_read()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id bigint;
  v_count integer;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  update public.chat_inbox_notifications n
     set read_at = coalesce(n.read_at, now())
   where n.user_id = v_user_id
     and n.read_at is null
     and (n.conversation_id is null or exists (
       select 1 from public.chat_conversations c
       where c.id=n.conversation_id and c.tenant_id=n.tenant_id
         and private.chat_rls_can_select_conversation(c.id,c.tenant_id)
     ));
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
DO $notification_candidate$
DECLARE v_denied boolean:=false;
BEGIN
 IF private.chat_unread_notification_count()<>2 THEN RAISE EXCEPTION 'invalid starting unread count'; END IF;
 BEGIN PERFORM private.chat_mark_notification_read(2); EXCEPTION WHEN OTHERS THEN IF SQLERRM='NOT_FOUND' THEN v_denied:=true; ELSE RAISE; END IF; END;
 IF NOT v_denied THEN RAISE EXCEPTION 'mark one allowed inaccessible notification'; END IF;
 IF private.chat_mark_all_notifications_read()<>2 THEN RAISE EXCEPTION 'mark all did not match unread visibility'; END IF;
 IF private.chat_unread_notification_count()<>0 OR private.chat_mark_all_notifications_read()<>0 THEN RAISE EXCEPTION 'mark all replay/count mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM public.chat_inbox_notifications WHERE id IN (2,3,4) AND read_at IS NOT NULL) THEN RAISE EXCEPTION 'mark all modified unauthorized notification'; END IF;
 IF EXISTS(SELECT 1 FROM public.chat_inbox_notifications WHERE id IN (1,5) AND read_at IS NULL) THEN RAISE EXCEPTION 'mark all skipped visible notification'; END IF;
 IF (SELECT read_at FROM public.chat_inbox_notifications WHERE id=6) IS DISTINCT FROM '2026-01-01T00:00:00Z'::timestamptz THEN RAISE EXCEPTION 'mark all modified existing read timestamp'; END IF;
END $notification_candidate$;
SELECT 'PR359_CHAT_MARK_ALL_VISIBILITY_CANDIDATE_PASS';
ROLLBACK;
