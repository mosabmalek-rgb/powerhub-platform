-- Add covering indexes for inventory/supplier foreign keys used by joins and safe deletes.
-- These are additive and do not alter financial or stock data.

create index if not exists inventory_items_created_by_user_idx
  on public.inventory_items (created_by_user_id);

create index if not exists inventory_stock_movements_created_by_user_idx
  on public.inventory_stock_movements (created_by_user_id);
create index if not exists inventory_stock_movements_generator_idx
  on public.inventory_stock_movements (generator_id);
create index if not exists inventory_stock_movements_tenant_item_idx
  on public.inventory_stock_movements (tenant_id, item_id);
create index if not exists inventory_stock_movements_tenant_purchase_line_idx
  on public.inventory_stock_movements (tenant_id, purchase_line_id);

create index if not exists inventory_warehouses_created_by_user_idx
  on public.inventory_warehouses (created_by_user_id);

create index if not exists supplier_ledger_entries_created_by_user_idx
  on public.supplier_ledger_entries (created_by_user_id);
create index if not exists supplier_ledger_entries_tenant_site_idx
  on public.supplier_ledger_entries (tenant_id, site_id);

create index if not exists supplier_payments_tenant_account_idx
  on public.supplier_payments (tenant_id, company_account_id);
create index if not exists supplier_payments_posted_by_user_idx
  on public.supplier_payments (posted_by_user_id);
create index if not exists supplier_payments_reversed_by_user_idx
  on public.supplier_payments (reversed_by_user_id);
create index if not exists supplier_payments_tenant_site_idx
  on public.supplier_payments (tenant_id, site_id);

create index if not exists supplier_purchase_receipts_received_by_user_idx
  on public.supplier_purchase_receipts (received_by_user_id);
create index if not exists supplier_purchase_receipts_tenant_site_idx
  on public.supplier_purchase_receipts (tenant_id, site_id);

create index if not exists supplier_purchase_receipt_lines_tenant_purchase_line_idx
  on public.supplier_purchase_receipt_lines (tenant_id, purchase_line_id);

create index if not exists supplier_purchases_cancelled_by_user_idx
  on public.supplier_purchases (cancelled_by_user_id);
create index if not exists supplier_purchases_confirmed_by_user_idx
  on public.supplier_purchases (confirmed_by_user_id);
create index if not exists supplier_purchases_created_by_user_idx
  on public.supplier_purchases (created_by_user_id);
create index if not exists supplier_purchases_received_by_user_idx
  on public.supplier_purchases (received_by_user_id);
create index if not exists supplier_purchases_tenant_warehouse_idx
  on public.supplier_purchases (tenant_id, warehouse_id);
