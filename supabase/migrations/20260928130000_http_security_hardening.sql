-- HTTP rate limiting for server-only sensitive endpoints.
-- Counters live in the private schema and are callable only by service_role.

create table if not exists private.http_rate_limit_buckets (
  key_hash text not null,
  scope text not null,
  bucket_start timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  updated_at timestamptz not null default now(),
  primary key (key_hash, scope, bucket_start)
);

revoke all on table private.http_rate_limit_buckets from public, anon, authenticated;

create index if not exists http_rate_limit_buckets_updated_idx
  on private.http_rate_limit_buckets (updated_at desc);

create or replace function public.powerhub_http_rate_limit_consume(
  p_key_hash text,
  p_scope text,
  p_window_seconds integer default 60,
  p_max_attempts integer default 10
) returns boolean
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_window integer := greatest(1, least(coalesce(p_window_seconds, 60), 3600));
  v_max integer := greatest(1, least(coalesce(p_max_attempts, 10), 1000));
  v_bucket timestamptz;
  v_attempts integer;
begin
  if length(coalesce(p_key_hash, '')) <> 64 or nullif(btrim(p_scope), '') is null then
    return false;
  end if;
  v_bucket := to_timestamp(floor(extract(epoch from clock_timestamp()) / v_window) * v_window);
  perform pg_advisory_xact_lock(hashtextextended('http-rate:' || btrim(p_scope) || ':' || p_key_hash || ':' || v_bucket::text, 0));
  delete from private.http_rate_limit_buckets
   where updated_at < clock_timestamp() - interval '2 hours';
  select attempts into v_attempts
    from private.http_rate_limit_buckets
   where key_hash = p_key_hash and scope = btrim(p_scope) and bucket_start = v_bucket
   for update;
  if v_attempts is null then
    insert into private.http_rate_limit_buckets(key_hash, scope, bucket_start, attempts, updated_at)
    values(p_key_hash, btrim(p_scope), v_bucket, 1, clock_timestamp());
    return true;
  end if;
  if v_attempts >= v_max then return false; end if;
  update private.http_rate_limit_buckets
     set attempts = attempts + 1, updated_at = clock_timestamp()
   where key_hash = p_key_hash and scope = btrim(p_scope) and bucket_start = v_bucket;
  return true;
end;
$$;

revoke all on function public.powerhub_http_rate_limit_consume(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.powerhub_http_rate_limit_consume(text, text, integer, integer) to service_role;

create or replace function public.powerhub_mobile_rotate_refresh_session(
  p_old_refresh_token_hash text,
  p_new_refresh_token_hash text,
  p_now timestamptz default now()
) returns table(id bigint, user_id bigint, tenant_id bigint)
language sql
security definer
set search_path = ''
volatile
as $$
  update public.mobile_api_sessions
     set refresh_token_hash = p_new_refresh_token_hash,
         last_used_at = p_now
   where refresh_token_hash = p_old_refresh_token_hash
     and revoked_at is null
     and expires_at > p_now
   returning id, user_id, tenant_id;
$$;

revoke all on function public.powerhub_mobile_rotate_refresh_session(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_mobile_rotate_refresh_session(text, text, timestamptz) to service_role;