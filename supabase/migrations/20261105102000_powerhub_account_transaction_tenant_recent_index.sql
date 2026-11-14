-- The company-account Delta trigger builds a tenant-wide recent-history
-- snapshot ordered by occurred_at/id. Existing account/site indexes are scoped
-- to one account/site first and cannot satisfy this access path.
create index if not exists account_transactions_tenant_recent_idx
  on public.account_transactions (tenant_id, occurred_at desc, id desc);

create or replace function public.powerhub_capture_company_account_delta_sync_change()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_tenant_id bigint;
  v_old_id bigint;
  v_old_account_id bigint;
  v_old_occurred_at timestamptz;
  v_new_id bigint;
  v_new_account_id bigint;
  v_account_id bigint;
  v_extra_sites bigint[];
begin
  if TG_TABLE_NAME='company_accounts' then
    if TG_OP='DELETE' then
      select coalesce(array_agg(link.site_id order by link.site_id),array[]::bigint[])
        into v_extra_sites
      from public.company_account_sites link
      where link.tenant_id=OLD.tenant_id and link.account_id=OLD.id;
      perform public.powerhub_publish_company_account_delta(OLD.tenant_id,OLD.id,v_extra_sites,true);
      return OLD;
    end if;
    if TG_OP='UPDATE' and (OLD.tenant_id is distinct from NEW.tenant_id or OLD.id is distinct from NEW.id) then
      select coalesce(array_agg(link.site_id order by link.site_id),array[]::bigint[])
        into v_extra_sites from public.company_account_sites link
      where link.tenant_id=OLD.tenant_id and link.account_id=OLD.id;
      perform public.powerhub_publish_company_account_delta(OLD.tenant_id,OLD.id,v_extra_sites,true);
    end if;
    perform public.powerhub_publish_company_account_delta(NEW.tenant_id,NEW.id,array[]::bigint[],not coalesce(NEW.is_active,false));
    return NEW;
  elsif TG_TABLE_NAME='company_account_sites' then
    if TG_OP='DELETE' then
      if not exists(select 1 from public.company_accounts ca where ca.tenant_id=OLD.tenant_id and ca.id=OLD.account_id) then
        return OLD; -- Parent-account deletion already emitted its tombstones.
      end if;
      perform public.powerhub_publish_company_account_delta(OLD.tenant_id,OLD.account_id,array[OLD.site_id]::bigint[],false);
      return OLD;
    elsif TG_OP='INSERT' then
      perform public.powerhub_publish_company_account_delta(NEW.tenant_id,NEW.account_id,array[NEW.site_id]::bigint[],false);
      return NEW;
    end if;
    if OLD.tenant_id is not distinct from NEW.tenant_id and OLD.account_id is not distinct from NEW.account_id then
      perform public.powerhub_publish_company_account_delta(NEW.tenant_id,NEW.account_id,array[OLD.site_id,NEW.site_id]::bigint[],false);
    else
      perform public.powerhub_publish_company_account_delta(OLD.tenant_id,OLD.account_id,array[OLD.site_id]::bigint[],false);
      perform public.powerhub_publish_company_account_delta(NEW.tenant_id,NEW.account_id,array[NEW.site_id]::bigint[],false);
    end if;
    return NEW;
  elsif TG_TABLE_NAME='account_transactions' then
    if TG_OP<>'INSERT' then
      v_old_id := OLD.id;
      v_old_account_id := OLD.account_id;
      v_old_occurred_at := OLD.occurred_at;
    end if;
    if TG_OP<>'DELETE' then
      v_new_id := NEW.id;
      v_new_account_id := NEW.account_id;
    end if;
    v_tenant_id := case when TG_OP='DELETE' then OLD.tenant_id else NEW.tenant_id end;

    -- The visible account query carries the newest 1,000 tenant-wide transactions.
    -- Compare old/new membership at that boundary so evicted/previously-hidden rows
    -- cause their affected account projection to be republished too.
    for v_account_id in
      with old_candidates as (
        -- The previous state is the current tenant window without the NEW row,
        -- plus the single OLD row (when updating/deleting). No row outside the
        -- current top 1,000 can enter the previous top 1,000 after one row is added.
        (
          select tx.id,tx.account_id,tx.occurred_at
          from public.account_transactions tx
          where tx.tenant_id=v_tenant_id and tx.id is distinct from v_new_id
          order by tx.occurred_at desc,tx.id desc
          limit 1000
        )
        union all
        select v_old_id,v_old_account_id,v_old_occurred_at where v_old_id is not null
      ),
      old_window as (
        select candidate.id,candidate.account_id
        from old_candidates candidate
        order by candidate.occurred_at desc,candidate.id desc
        limit 1000
      ),
      new_window as (
        select tx.id,tx.account_id
        from public.account_transactions tx
        where tx.tenant_id=v_tenant_id
        order by tx.occurred_at desc,tx.id desc
        limit 1000
      ),
      changed_window as (
        select o.account_id from old_window o
        where not exists(select 1 from new_window n where n.id=o.id)
        union
        select n.account_id from new_window n
        where not exists(select 1 from old_window o where o.id=n.id)
      ),
      affected as (
        select v_old_account_id as account_id where v_old_account_id is not null
        union select v_new_account_id where v_new_account_id is not null
        union select account_id from changed_window
      )
      select distinct account_id from affected where account_id is not null
    loop
      perform public.powerhub_publish_company_account_delta(v_tenant_id,v_account_id,array[]::bigint[],false);
    end loop;
    if TG_OP='DELETE' then return OLD; else return NEW; end if;
  end if;
  raise exception 'POWERHUB_SYNC_TABLE_UNSUPPORTED' using errcode='P0001';
end;
$$;
alter function public.powerhub_capture_company_account_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_company_account_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_company_account_delta_sync_change() to service_role;
