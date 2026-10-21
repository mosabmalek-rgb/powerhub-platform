-- Cover supplier-return foreign keys and common branch/warehouse filters.
-- The partial/ledger indexes created by the base migration do not cover these leading keys.
create index if not exists supplier_purchase_return_lines_tenant_purchase_line_idx
  on public.supplier_purchase_return_lines(tenant_id,purchase_line_id);

create index if not exists supplier_purchase_returns_tenant_site_date_idx
  on public.supplier_purchase_returns(tenant_id,site_id,return_date desc,id desc);

create index if not exists supplier_purchase_returns_tenant_warehouse_date_idx
  on public.supplier_purchase_returns(tenant_id,warehouse_id,return_date desc,id desc);

create index if not exists supplier_purchase_returns_tenant_refund_account_idx
  on public.supplier_purchase_returns(tenant_id,refund_company_account_id);

create index if not exists supplier_purchase_returns_returned_by_user_idx
  on public.supplier_purchase_returns(returned_by_user_id);
