create or replace function public.powerhub_get_shared_invoice_by_token_hash(p_token_hash text)
returns jsonb
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_link public.invoice_share_links%rowtype; v_invoice public.invoices%rowtype; v_subscriber record; v_lines jsonb;
begin
  if length(p_token_hash)<32 then raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(hashtext(p_token_hash));
  select * into v_link from public.invoice_share_links where token_hash=p_token_hash for update;
  if not found or v_link.revoked_at is not null or (v_link.expires_at is not null and v_link.expires_at<=now()) then raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001'; end if;
  select * into v_invoice from public.invoices where id=v_link.invoice_id;
  if not found then raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001'; end if;
  select full_name,subscriber_no into v_subscriber from public.subscribers where id=v_invoice.subscriber_id and tenant_id=v_link.tenant_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',line.id,'description',line.description,'amount',line.amount,'quantity',line.quantity,'unitPrice',line.unit_price,'displayOrder',line.display_order) order by line.display_order),'[]'::jsonb) into v_lines from public.invoice_lines line where line.invoice_id=v_invoice.id and line.tenant_id=v_link.tenant_id;
  update public.invoice_share_links set view_count=view_count+1,last_viewed_at=now() where id=v_link.id;
  return jsonb_build_object(
    'invoice',jsonb_build_object('id',v_invoice.id,'invoiceNo',v_invoice.invoice_no,'billingPeriod',v_invoice.billing_period,'issueDate',v_invoice.issue_date,'dueDate',v_invoice.due_date,'previousReading',v_invoice.previous_reading,'currentReading',v_invoice.current_reading,'consumptionKwh',v_invoice.consumption_kwh,'pricePerKwh',v_invoice.price_per_kwh,'fixedFee',v_invoice.fixed_fee,'taxAmount',v_invoice.tax_amount,'discountAmount',v_invoice.discount_amount,'totalAmount',v_invoice.total_amount,'paidAmount',v_invoice.paid_amount,'balanceDue',v_invoice.balance_due,'status',v_invoice.status),
    'subscriber',case when v_subscriber is null then null else jsonb_build_object('fullName',v_subscriber.full_name,'subscriberNo',v_subscriber.subscriber_no) end,
    'lines',v_lines
  );
end;
$$;
