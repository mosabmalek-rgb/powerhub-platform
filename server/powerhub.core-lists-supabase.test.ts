import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const inserts: Array<{ table: string; values: unknown }> = [];
  const updates: Array<{ table: string; values: unknown }> = [];
  const orderCalls: Array<{ table: string; column: string; options: unknown }> = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const site = { id: 10, tenant_id: 20, name: "الفرع الرئيسي", code: "MAIN", city: "غزة", address: null, status: "active", anomaly_alert_percent: 50, invoice_due_days: 14, invoice_due_hours: 336, created_at: "2026-08-01T00:00:00.000Z" };
  const subscriber = { id: 30, tenant_id: 20, site_id: 10, subscriber_no: "MAIN-001", client_operation_id: null, full_name: "مشترك الاختبار", phone: "+970595000000", whatsapp_number: null, address: null, subscription_type: "residential", service_status: "active", archived_at: null, purge_after_at: null, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" };
  const tables: Record<string, unknown[]> = {
    sites: [site], subscribers: [subscriber],
    tariffs: [{ id: 40, tenant_id: 20, site_id: 10, name: "التعرفة الأساسية", code: "BASE", price_per_kwh: 1.25, fixed_fee: 0, tax_rate: 0, is_active: true, effective_from: "2026-08-01T00:00:00.000Z", created_at: "2026-08-01T00:00:00.000Z" }],
    generators: [{ id: 50, tenant_id: 20, site_id: 10, code: "GEN-1", name: "مولد الاختبار", serial_number: null, rated_capacity_kw: 150, fuel_type: "diesel", fuel_level_liters: 0, operating_hours: 0, status: "active", last_maintenance_at: null, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }],
    meter_readings: [{ id: 60, tenant_id: 20, subscriber_id: 30, client_operation_id: null, reading_at: "2026-08-02T00:00:00.000Z", reading_value: 100, previous_reading_value: 90, consumption_kwh: 10, capture_method: "manual", image_key: null, image_hash: null, status: "pending_review", entered_by_user_id: 1, reviewed_by_user_id: null, reviewed_at: null, notes: null, version_no: 1, created_at: "2026-08-02T00:00:00.000Z", updated_at: "2026-08-02T00:00:00.000Z" }],
    invoices: [{ id: 70, tenant_id: 20, site_id: 10, subscriber_id: 30, reading_id: 60, tariff_id: 40, invoice_no: "MAIN-202608-0001", client_operation_id: null, billing_period: "2026-08", issue_date: "2026-08-02T00:00:00.000Z", due_date: "2026-08-16T00:00:00.000Z", previous_reading: 90, current_reading: 100, status: "issued", total_amount: 100, paid_amount: 25, balance_due: 75, consumption_kwh: 10, price_per_kwh: 10, fixed_fee: 0, tax_amount: 0, discount_amount: 0, created_by_user_id: 1, created_at: "2026-08-02T00:00:00.000Z", updated_at: "2026-08-02T00:00:00.000Z" }],
    expenses: [{ id: 80, tenant_id: 20, site_id: 10, generator_id: null, category: "fuel", description: "وقود", amount: 15, occurred_at: "2026-08-03T00:00:00.000Z", reference_no: null, created_by_user_id: 1, created_at: "2026-08-03T00:00:00.000Z" }],
    notification_messages: [{ id: 90, subscriber_id: 30, status: "failed" }],
    user_quick_action_preferences: [{ user_id: 1, site_id: 10, action_ids: ["record_reading"], updated_at: "2026-08-01T00:00:00.000Z" }],
    tenant_tweetsms_accounts: [{ tenant_id: 20, sender_name: "PowerHub", monthly_limit: 1000, is_active: true, credential_ciphertext: "configured", last_error: null }],
    sms_package_requests: [],
    payments: [{ id: 81, tenant_id: 20, site_id: 10, subscriber_id: 30, invoice_id: 70, payment_no: "PAY-202608-0001", client_operation_id: null, amount: 25, payment_method: "cash", transfer_from_account: null, transfer_from_type: null, transfer_to_account: null, transfer_to_type: null, reference_no: "REF-1", receipt_image_key: null, receipt_image_hash: null, status: "completed", collected_by_user_id: 1, collector_session_id: null, paid_at: "2026-08-03T00:00:00.000Z", created_at: "2026-08-03T00:00:00.000Z" }],
    company_accounts: [{ id: 90, tenant_id: 20, name: "كاش", account_type: "cash", phone_number: null, color: "#64748b", opening_balance: 100, is_active: true, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }],
    company_account_sites: [{ tenant_id: 20, account_id: 90, site_id: 10 }],
    account_transactions: [{ id: 91, tenant_id: 20, account_id: 90, transaction_type: "collection", amount: 25, description: "تحصيل الفاتورة PAY-202608-0001", reference_no: "REF-1", related_payment_id: 81, related_account_id: null, created_by_user_id: 1, occurred_at: "2026-08-03T00:00:00.000Z", created_at: "2026-08-03T00:00:00.000Z" }],
    collector_sessions: [{ id: 96, tenant_id: 20, site_id: 10, collector_user_id: 1, status: "open", opening_cash: 5, expected_cash: 5, declared_cash: null, variance_amount: null, opened_at: "2026-08-03T00:00:00.000Z", closed_at: null, notes: null, closed_by_user_id: null, created_at: "2026-08-03T00:00:00.000Z", updated_at: "2026-08-03T00:00:00.000Z" }],
    financial_settlements: [{ id: 97, tenant_id: 20, site_id: 10, period_start: "2026-08-01T00:00:00.000Z", period_end: "2026-08-31T23:59:59.999Z", total_collected: 100, total_expenses: 20, book_profit: 80, actual_cash: 75, difference: -5, notes: "تسوية دورية", status: "draft", created_by_user_id: 1, approved_by_user_id: null, locked_at: null, created_at: "2026-08-31T23:59:59.999Z", updated_at: "2026-08-31T23:59:59.999Z" }],
    audit_logs: [
      { id: 108, tenant_id: 20, site_id: 10, user_id: 1, actor_platform_role: "platform_admin", actor_tenant_role: "owner", entity_type: "subscriber", entity_id: "30", action: "create", before_data: null, after_data: { subscriberNo: "MAIN-001" }, metadata: null, created_at: "2026-08-03T00:00:00.000Z" },
      { id: 109, tenant_id: 20, site_id: 10, user_id: 1, actor_platform_role: "platform_admin", actor_tenant_role: "owner", entity_type: "meter_reading", entity_id: "60", action: "mobile_create", before_data: null, after_data: null, metadata: null, created_at: "2026-08-03T00:00:00.000Z" },
    ],
    users: [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active", name: "مدير المنصة", email: "admin@example.test" }], tenant_members: [{ tenant_id: 20, user_id: 1, role: "owner", is_active: true, membership_status: "active" }], tenant_subscriptions: [{ tenant_id: 20, package_code: "professional", status: "active", ends_at: "2026-12-31T23:59:59.999Z" }], platform_settings: [{ setting_key: "branch_feature", is_enabled: true, value: { defaultLimit: { basic: 1, advanced: 2, professional: 3, business: 5, vip: 10 } } }], tenant_branch_settings: [],
    tenant_owner_profiles: [{ tenant_id: 20, company_name: "شركة المولد", report_logo_key: null }],
    staff_profiles: [{ tenant_id: 20, site_id: 10, user_id: 1, is_active: true }],
    mobile_sync_events: [{ id: 110, tenant_id: 20, site_id: 10, user_id: 1, event_type: "sync_cycle", status: "success", synced_count: 2, retryable_count: 0, needs_review_count: 0, error_code: null, error_message: null, app_version: "1.0.0", device_label: "هاتف فني", occurred_at: "2026-08-03T00:00:00.000Z" }],
    employees: [{ id: 120, tenant_id: 20, site_id: 10, linked_user_id: null, full_name: "محاسب الاختبار", identity_no: null, phone: "0595000000", job_title: "accountant", employment_status: "active", contract_type: "monthly", base_wage: 1000, hire_date: "2026-08-01T00:00:00.000Z", notes: null, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }],
    employee_adjustments: [{ id: 121, tenant_id: 20, employee_id: 120, site_id: 10, adjustment_type: "advance", amount: 100, remaining_amount: 100, reason: "سلفة اختبار", status: "open", created_by_user_id: 1, created_at: "2026-08-02T00:00:00.000Z", updated_at: "2026-08-02T00:00:00.000Z" }],
    payroll_runs: [{ id: 122, tenant_id: 20, site_id: 10, period: "2026-08", status: "draft", total_gross: 1000, total_deductions: 100, total_net: 900, paid_from_account_id: null, approved_by_user_id: null, paid_at: null, created_by_user_id: 1, created_at: "2026-08-31T00:00:00.000Z", updated_at: "2026-08-31T00:00:00.000Z" }],
    payroll_items: [{ id: 123, payroll_run_id: 122, employee_id: 120, base_amount: 1000, extra_amount: 0, advance_deduction: 100, other_deduction: 0, net_amount: 900, notes: null }],
    employee_attendance: [{ id: 124, tenant_id: 20, employee_id: 120, site_id: 10, work_date: "2026-08-03", regular_hours: 8, overtime_hours: 1, absent_days: 0, notes: null, created_by_user_id: 1, created_at: "2026-08-03T00:00:00.000Z", updated_at: "2026-08-03T00:00:00.000Z" }],
    tenants: [{ id: 20, plan: "professional", package_code: "professional" }],
    subscription_upgrade_requests: [{ id: 109, tenant_id: 20, current_package_code: "basic", requested_package_code: "professional", status: "pending", note: "مراجعة الباقة", created_at: "2026-08-20T00:00:00.000Z", reviewed_at: null }],
  };
  const resolved = (data: unknown) => Promise.resolve({ data, error: null });
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      let filteredRows = rows;
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filteredRows = filteredRows.filter((row) => !(column in (row as Record<string, unknown>)) || (row as Record<string, unknown>)[column] === value); return query; },
        in: (column: string, values: unknown[]) => { filteredRows = filteredRows.filter((row) => !(column in (row as Record<string, unknown>)) || values.includes((row as Record<string, unknown>)[column])); return query; },
        gt: (column: string, value: unknown) => { filteredRows = filteredRows.filter((row) => { const record = row as Record<string, unknown>; return !(column in record) || (record[column] != null && Number(record[column]) > Number(value)); }); return query; },
        or: (expression: string) => { const match = expression.match(/^site_id\.eq\.(\d+),site_id\.is\.null$/); if (match) { const siteId = Number(match[1]); filteredRows = filteredRows.filter((row) => { const siteValue = (row as Record<string, unknown>).site_id; return siteValue === siteId || siteValue === null; }); } return query; },
        is: (column: string, value: unknown) => { filteredRows = filteredRows.filter((row) => (row as Record<string, unknown>)[column] === value); return query; },
        neq: (column: string, value: unknown) => { filteredRows = filteredRows.filter((row) => !(column in (row as Record<string, unknown>)) || (row as Record<string, unknown>)[column] !== value); return query; },
        order: (column: string, options?: unknown) => { orderCalls.push({ table, column, options }); return query; },
        gte: (column: string, value: unknown) => {
          if (table !== "expenses") return query;
          const comparable = (item: unknown) => typeof item === "number" ? item : typeof item === "string" && /^\d{4}-\d{2}-\d{2}T/.test(item) ? Date.parse(item) : item;
          const expected = comparable(value);
          filteredRows = filteredRows.filter((row) => {
            const record = row as Record<string, unknown>;
            if (!(column in record)) return true;
            const actual = comparable(record[column]);
            if (actual == null) return false;
            return typeof actual === "number" && typeof expected === "number" ? actual >= expected : String(actual) >= String(expected);
          });
          return query;
        },
        lte: (column: string, value: unknown) => {
          if (table !== "expenses") return query;
          const comparable = (item: unknown) => typeof item === "number" ? item : typeof item === "string" && /^\d{4}-\d{2}-\d{2}T/.test(item) ? Date.parse(item) : item;
          const expected = comparable(value);
          filteredRows = filteredRows.filter((row) => {
            const record = row as Record<string, unknown>;
            if (!(column in record)) return true;
            const actual = comparable(record[column]);
            if (actual == null) return false;
            return typeof actual === "number" && typeof expected === "number" ? actual <= expected : String(actual) <= String(expected);
          });
          return query;
        },
        lt: (column: string, value: unknown) => {
          if (table !== "expenses") return query;
          const comparable = (item: unknown) => typeof item === "number" ? item : typeof item === "string" && /^\d{4}-\d{2}-\d{2}T/.test(item) ? Date.parse(item) : item;
          const expected = comparable(value);
          filteredRows = filteredRows.filter((row) => {
            const record = row as Record<string, unknown>;
            if (!(column in record)) return true;
            const actual = comparable(record[column]);
            if (actual == null) return false;
            return typeof actual === "number" && typeof expected === "number" ? actual < expected : String(actual) < String(expected);
          });
          return query;
        },
        not: () => query,
        range: (from: number, to: number) => { filteredRows = filteredRows.slice(from, to + 1); return query; },
        limit: (count: number) => { filteredRows = filteredRows.slice(0, count); return query; },
        maybeSingle: () => resolved(filteredRows[0] ?? null),
        then: <TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
          onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => resolved(filteredRows).then(onfulfilled, onrejected),
      };
      const updateQuery = {
        eq: () => updateQuery,
        select: () => ({ maybeSingle: () => resolved(null), single: () => resolved({ ...(filteredRows[0] ?? {}), ...(updateQuery.__values as Record<string, unknown>) }) }),
        __values: {} as Record<string, unknown>,
        then: <TResult1 = { data: null; error: null }, TResult2 = never>(
          onfulfilled?: ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => resolved(null).then(onfulfilled, onrejected),
      };
      return {
        ...query,
        insert(values: unknown) {
          inserts.push({ table, values });
          const id = table === "tariffs" ? 41 : table === "generators" ? 51 : 91;
          return {
            select: () => ({ single: () => resolved({ id }) }),
            then: <TResult1 = { data: null; error: null }, TResult2 = never>(
              onfulfilled?: ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) => resolved(null).then(onfulfilled, onrejected),
          };
        },
        update(values: unknown) { updates.push({ table, values }); updateQuery.__values = (values && typeof values === "object" ? values : {}) as Record<string, unknown>; return updateQuery; },
        upsert(values: unknown) {
          inserts.push({ table, values });
          return {
            select: () => ({ maybeSingle: () => resolved(values), single: () => resolved(values) }),
            then: <TResult1 = { data: unknown; error: null }, TResult2 = never>(
              onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) => resolved({ data: values, error: null }).then(onfulfilled, onrejected),
          };
        },
      };
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      if (name === "powerhub_subscriber_statement_summary") return resolved([{
        invoice_count: 1, payment_count: 1, reading_count: 1,
        total_invoiced: 100, total_collected: 25, total_outstanding: 75,
        total_consumption_kwh: 10, last_payment_at: "2026-08-03T00:00:00.000Z",
      }]);
      if (name === "powerhub_company_account_balance_rollup") {
        const input = args as { p_tenant_id: number; p_account_ids: number[] };
        const accounts = (tables.company_accounts ?? []) as Array<Record<string, unknown>>;
        const movements = (tables.account_transactions ?? []) as Array<Record<string, unknown>>;
        return resolved(accounts
          .filter((account) => Number(account.tenant_id) === Number(input.p_tenant_id) && account.is_active === true && input.p_account_ids.map(Number).includes(Number(account.id)))
          .map((account) => ({
            account_id: Number(account.id),
            balance: Number(account.opening_balance ?? 0) + movements
              .filter((movement) => Number(movement.tenant_id) === Number(input.p_tenant_id) && Number(movement.account_id) === Number(account.id))
              .reduce((total, movement) => total + (["deposit", "transfer_in", "collection"].includes(String(movement.transaction_type)) ? 1 : -1) * Number(movement.amount ?? 0), 0),
          })));
      }
      if (name === "powerhub_create_tariff_idempotent") return resolved([{ tariff_id: 41, replayed: false }]);
      if (name === "powerhub_subscriber_portal_list") return resolved([{ portal_code: "main", display_name: "بوابة الفرع الرئيسي", primary_color: "#0D1117", accent_color: "#F5B800", site_name: "الفرع الرئيسي", city: "غزة", logo_key: null }]);
      if (name === "powerhub_subscriber_portal_theme") return resolved([{ portal_code: "main", display_name: "بوابة الفرع الرئيسي", primary_color: "#0D1117", accent_color: "#F5B800", site_name: "الفرع الرئيسي", city: "غزة", logo_key: null }]);
      if (name === "powerhub_subscriber_portal_lookup") return resolved({
        portal: { portalCode: "main", displayName: "بوابة الفرع الرئيسي", primaryColor: "#0D1117", accentColor: "#F5B800", city: "غزة", logoKey: null },
        subscriber: { subscriberNo: "MAIN-001", fullName: "مشترك الاختبار", phone: "+970595000000", address: null, subscriptionType: "residential", serviceStatus: "active", joinedAt: "2026-08-01T00:00:00.000Z" },
        invoices: [{ invoiceNo: "MAIN-202608-0001", billingPeriod: "2026-08", issueDate: "2026-08-02T00:00:00.000Z", dueDate: "2026-08-16T00:00:00.000Z", consumptionKwh: 10, totalAmount: 100, paidAmount: 25, balanceDue: 75, status: "issued" }],
        payments: [{ id: 81, paymentNo: "PAY-202608-0001", amount: 25, paymentMethod: "cash", status: "completed", paidAt: "2026-08-03T00:00:00.000Z", invoiceNo: "MAIN-202608-0001" }],
      });
      if (name === "powerhub_subscriber_portal_invoice") return resolved({
        portal: { displayName: "بوابة الفرع الرئيسي", primaryColor: "#0D1117", accentColor: "#F5B800", logoKey: null },
        subscriber: { fullName: "مشترك الاختبار", subscriberNo: "MAIN-001", phone: "+970595000000", address: null },
        invoice: { invoiceNo: "MAIN-202608-0001", billingPeriod: "2026-08", issueDate: "2026-08-02T00:00:00.000Z", dueDate: "2026-08-16T00:00:00.000Z", previousReading: 90, currentReading: 100, consumptionKwh: 10, pricePerKwh: 10, fixedFee: 0, taxAmount: 0, discountAmount: 0, totalAmount: 100, paidAmount: 25, balanceDue: 75, status: "issued" },
        lines: [{ description: "استهلاك كهرباء", quantity: 10, unitPrice: 10, amount: 100 }],
      });
      if (name === "powerhub_save_site_portal_settings") return resolved([{ portal_code: "main" }]);
      if (name === "powerhub_upsert_employee_attendance") return resolved([{ attendance_id: 124, mutation: "update" }]);
      if (name === "powerhub_create_employee") return resolved([{ employee_id: 125 }]);
      if (name === "powerhub_update_employee") return resolved([{ employee_id: 120 }]);
      if (name === "powerhub_create_employee_adjustment") return resolved([{ adjustment_id: 125 }]);
      if (name === "powerhub_issue_employee_advance") return resolved([{ adjustment_id: 130, account_transaction_id: 131, remaining_amount: 250, replayed: false }]);
      if (name === "powerhub_repay_employee_advance") return resolved([{ repayment_id: 132, adjustment_id: 121, remaining_amount: 75, account_transaction_id: 133, replayed: false }]);
      if (name === "powerhub_create_payroll_draft") return resolved([{ payroll_run_id: 126, total_net: 1100 }]);
      if (name === "powerhub_approve_payroll") return resolved([{ payroll_run_id: 122 }]);
      if (name === "powerhub_pay_payroll") return resolved([{ payroll_run_id: 122, expense_id: 125, transaction_id: 126 }]);
      if (name === "powerhub_request_subscription_upgrade") return resolved([{ request_id: 127, requested_package_code: "professional", already_requested: false }]);
      if (name === "powerhub_normalize_subscriber_phones") return resolved([{ updated_count: 1, skipped_count: 0 }]);
      if (name === "powerhub_sync_invoice_sms_template") return resolved([{ template_id: 129 }]);
      if (name === "powerhub_create_invoice_share_link") return resolved([{ share_link_id: 128 }]);
      if (name === "powerhub_create_portal_invoice_share_link") return resolved([{ share_link_id: 132, site_id: 10, tenant_id: 20 }]);
      if (name === "powerhub_get_shared_invoice_by_token_hash") return resolved({
        siteId: 10, tenantId: 20,
        invoice: {
          id: 70, subscriberId: 30, invoiceNo: "MAIN-202608-0001", billingPeriod: "2026-08",
          issueDate: "2026-08-02T00:00:00.000Z", dueDate: "2026-08-16T00:00:00.000Z",
          previousReading: 90, currentReading: 100, consumptionKwh: 10, pricePerKwh: 10,
          fixedFee: 0, taxAmount: 0, discountAmount: 0, totalAmount: 100, paidAmount: 25, balanceDue: 75, status: "issued",
        },
        subscriber: { fullName: "مشترك الاختبار", subscriberNo: "MAIN-001" },
        lines: [{ id: 129, invoice_id: 70, description: "استهلاك كهرباء" }],
      });
      if (name === "powerhub_update_report_branding") return resolved([{ company_name: "شركة الاختبار", report_logo_key: null }]);
      if (name === "powerhub_update_subscriber") return resolved([{ updated_at: "2026-08-03T00:00:00.000Z", replayed: false }]);
      if (name === "powerhub_bulk_upsert_subscribers") return resolved([{ created: [{ id: 31, sourceRow: 2, fullName: "مشترك اختبار", subscriberNo: "MAIN-NEW" }], updated: [], failed: [] }]);
      if (name === "powerhub_create_reading") return resolved([{ reading_id: 61, consumption_kwh: 15, status: "pending_review", replayed: false }]);
      if (name === "powerhub_create_reading_and_issue_invoice") return resolved([{
        reading_id: 61, consumption_kwh: 15, reading_status: "approved", replayed: false,
        invoice_id: 71, invoice_no: "PH-MAIN-202608-00002", total_amount: 150,
        notification_ids: [], already_processed: false,
      }]);
      if (name === "powerhub_update_pending_reading") return resolved([{ consumption_kwh: 20, updated_at: "2026-08-04T00:00:00.000Z" }]);
      if (name === "powerhub_delete_pending_reading") return resolved(null);
      if (name === "powerhub_approve_reading") return resolved([{ reading_id: 60, version_no: 2 }]);
      if (name === "powerhub_issue_invoice_from_reading") return resolved([{ invoice_id: 71, invoice_no: "PH-MAIN-202608-00002", total_amount: 150, replayed: false }]);
      if (name === "powerhub_approve_and_issue_mobile_reading") return resolved([{ invoice_id: 71, invoice_no: "PH-MAIN-202608-00002", total_amount: 150, notification_ids: [], already_processed: false }]);
      if (name === "powerhub_create_payment") return resolved([{ payment_id: 81, replayed: false }]);
      if (name === "powerhub_payment_documentation_access") return resolved([{ allowed: true, policy: "enabled", package_code: "basic", entitlement_enabled: true }]);
      if (name === "powerhub_subscriber_quota_summary") return resolved([{
        package_code: "professional", current_count: 0, quota_limit: 500,
      }]);
      if (name === "powerhub_effective_tenant_quota") {
        const resource = String((args as Record<string, unknown>)?.p_resource ?? "");
        const hasOwnerLimitOverride = Array.isArray(tables.platform_settings) && tables.platform_settings.some((row) => {
          const record = row as Record<string, unknown>;
          return record.setting_key === "owner_limit_overrides";
        });
        if (hasOwnerLimitOverride && resource === "platformUser") return resolved([3]);
        if (hasOwnerLimitOverride && resource === "fieldUser") return resolved([0]);
        return resolved([1000]);
      }
      if (name === "powerhub_create_expense_with_account") return resolved([{ expense_id: 82, transaction_id: 118 }]);
      if (name === "powerhub_create_financial_settlement") return resolved([{ settlement_id: 97 }]);
      if (name === "powerhub_set_financial_settlement_status") return resolved([{ settlement_id: 97 }]);
      if (name === "powerhub_exceptional_locked_edit") return resolved([{ before_data: { id: 82, description: "وصف سابق" }, after_data: { id: 82, description: "وصف مصحح" } }]);
      if (name === "powerhub_save_site_invoice_due_hours") return resolved([{ invoice_due_hours: Number((args as Record<string, unknown>).p_invoice_due_hours) }]);
      if (["powerhub_update_site_anomaly", "powerhub_update_site"].includes(name)) return resolved([{ site_id: 10 }]);
      if (name === "powerhub_create_site") return resolved([{ site_id: 11 }]);
      if (["powerhub_update_company_account_phone", "powerhub_update_company_account_opening_balance", "powerhub_update_company_account_sites"].includes(name)) return resolved([{ account_id: 92 }]);
      if (name === "powerhub_create_company_account") return resolved([{ account_id: 92 }]);
      if (name === "powerhub_add_account_movement") return resolved([{ transaction_id: 93 }]);
      if (name === "powerhub_transfer_company_accounts") return resolved([{ from_transaction_id: 94, to_transaction_id: 95 }]);
      if (name === "powerhub_queue_payment_sms") return resolved([{ notification_id: 90, queued: true }]);
      if (name === "powerhub_close_collector_session") return resolved([{ expected_cash: 10, variance_amount: 0 }]);
      if (name === "powerhub_get_sms_quota") return resolved([{ total_messages: 1000, used_segments: 2, remaining_messages: 998, subscription_id: 108, sms_plan_id: null, plan_code: "basic", plan_name: "الناشئة", base_messages: 0, additional_messages: 1000 }]);
      if (name === "powerhub_request_sms_package_plan") return resolved([{ request_id: 98, request_status: "pending", already_requested: false }]);
      if (name === "powerhub_save_custom_permission_role") return resolved([{ role_id: 122, mutation: "create" }]);
      if (name === "powerhub_delete_custom_permission_role") return resolved([{ role_id: 122 }]);
      if (name === "powerhub_update_staff_profile_permissions") return resolved([{ profile_id: 120, target_user_id: 2 }]);
      if (name === "powerhub_update_staff_profile_status") return resolved([{ profile_id: 120, is_active: true, suspension_ends_at: "2026-08-10T12:00:00.000Z" }]);
      if (name === "powerhub_assign_existing_staff") return resolved([{ profile_id: 121, target_user_id: 2 }]);
      return resolved([{ subscriber_id: 31, subscriber_no: "MAIN-NEW", replayed: false }]);
    },
  };
  const defaultRpc = client.rpc;
  return { client, tables, inserts, updates, orderCalls, rpcCalls, defaultRpc };
});

const notificationWorker = vi.hoisted(() => ({ processQueue: vi.fn(), processById: vi.fn() }));

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }), syncSupabaseUser: vi.fn() }));
vi.mock("./notification-worker", () => ({ processNotificationById: notificationWorker.processById, processNotificationQueueForTenant: notificationWorker.processQueue }));

import { powerhubRouter } from "./powerhub";

describe("قوائم التشغيل الأساسية عبر Supabase", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret-for-powerhub";
    state.client.rpc = state.defaultRpc;
    state.client.auth = {
      admin: {
        createUser: vi.fn(async () => ({ data: { user: { id: "auth-default" } }, error: null })),
        updateUserById: vi.fn(async () => ({ data: { user: { id: "auth-default" } }, error: null })),
        deleteUser: vi.fn(async () => ({ error: null })),
      },
    };
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active" }];
    state.tables.notification_messages = [{ id: 90, subscriber_id: 30, status: "failed" }];
    state.tables.audit_logs = [
      { id: 108, tenant_id: 20, site_id: 10, user_id: 1, actor_platform_role: "platform_admin", actor_tenant_role: "owner", entity_type: "subscriber", entity_id: "30", action: "create", before_data: null, after_data: { subscriberNo: "MAIN-001" }, metadata: null, created_at: "2026-08-03T00:00:00.000Z" },
      { id: 109, tenant_id: 20, site_id: 10, user_id: 1, actor_platform_role: "platform_admin", actor_tenant_role: "owner", entity_type: "meter_reading", entity_id: "60", action: "mobile_create", before_data: null, after_data: null, metadata: null, created_at: "2026-08-03T00:00:00.000Z" },
    ];
    state.tables.tenant_subscriptions = [{ tenant_id: 20, package_code: "professional", status: "active", ends_at: "2026-12-31T23:59:59.999Z" }];
    state.tables.staff_profiles = [{ tenant_id: 20, site_id: 10, user_id: 1, is_active: true }];
    state.tables.tenants = [{ id: 20, plan: "professional", package_code: "professional" }];
    state.tables.platform_settings = [{ setting_key: "branch_feature", is_enabled: true, value: { defaultLimit: { basic: 1, advanced: 2, professional: 3, business: 5, vip: 10 } } }];
    state.inserts.splice(0);
    state.updates.splice(0);
    state.orderCalls.splice(0);
    state.rpcCalls.splice(0);
    notificationWorker.processQueue.mockReset();
    notificationWorker.processById.mockReset();
  });

  it("يعرض الفروع والمشتركين والتعرفة والمولدات والقراءات دون استدعاء MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.sites.list()).resolves.toMatchObject([{ id: 10, tenantId: 20, createdAt: expect.any(Date) }]);
    await expect(caller.subscribers.list({ siteId: 10 })).resolves.toMatchObject([{ id: 30, subscriberNo: "MAIN-001", fullName: "مشترك الاختبار", createdAt: expect.any(Date) }]);
    await expect(caller.subscribers.accountStatement({ siteId: 10, subscriberId: 30 })).resolves.toMatchObject({
      subscriber: { id: 30, subscriberNo: "MAIN-001", fullName: "مشترك الاختبار" },
      summary: { invoiceCount: 1, paymentCount: 1, readingCount: 1, totalInvoiced: 100, totalCollected: 25, totalOutstanding: 75, totalConsumptionKwh: 10 },
      limits: { visiblePerSection: 20, invoiceHasMore: false, paymentHasMore: false, readingHasMore: false },
      invoices: [{ invoiceNo: "MAIN-202608-0001", balanceDue: "75" }],
      payments: [{ paymentNo: "PAY-202608-0001", invoiceNo: "MAIN-202608-0001", amount: "25" }],
      readings: [{ id: 60, readingValue: "100", consumptionKwh: "10" }],
    });
    await expect(caller.tariffs.list({ siteId: 10 })).resolves.toMatchObject([{ id: 40, pricePerKwh: "1.25", effectiveFrom: expect.any(Date) }]);
    await expect(caller.generators.list({ siteId: 10 })).resolves.toMatchObject([{ id: 50, ratedCapacityKw: "150", createdAt: expect.any(Date) }]);
    await expect(caller.readings.list({ siteId: 10 })).resolves.toMatchObject([{ reading: { id: 60, consumptionKwh: "10", readingAt: expect.any(Date) }, subscriber: { id: 30, fullName: "مشترك الاختبار" } }]);
    await expect(caller.invoices.list({ siteId: 10 })).resolves.toMatchObject([{ id: 70, invoiceNo: "MAIN-202608-0001", totalAmount: "100", issueDate: expect.any(Date) }]);
    await expect(caller.payments.list({ siteId: 10 })).resolves.toMatchObject([{ payment: { id: 81, amount: "25", paidAt: expect.any(Date), receiptImageUrl: null }, subscriber: { id: 30 }, invoiceNo: "MAIN-202608-0001" }]);
    await expect(caller.companyAccounts.list({ siteId: 10 })).resolves.toMatchObject([{ id: 90, balance: 125, linkedSites: [{ siteId: 10, siteName: "الفرع الرئيسي" }], transactions: [{ id: 91, occurredAt: expect.any(Date) }] }]);
    expect(state.orderCalls.filter((call) => call.table === "account_transactions").slice(-2)).toEqual([
      { table: "account_transactions", column: "occurred_at", options: { ascending: false } },
      { table: "account_transactions", column: "id", options: { ascending: false } },
    ]);
    await expect(caller.expenses.list({ siteId: 10 })).resolves.toMatchObject([{ id: 80, category: "fuel", amount: "15", occurredAt: expect.any(Date) }]);
    await expect(caller.dashboard.summary({ siteId: 10 })).resolves.toEqual({ subscribers: 1, generators: { active: 1, maintenance: 0 }, financial: { invoiced: 100, collected: 25, outstanding: 75, expenses: 15, operatingProfit: 10 }, energyKwh: 10, failedNotifications: 1 });
  });

  it("يعالج رسائل SMS المؤجلة ضمن الفرع عبر حجز Supabase دون الوصول إلى MySQL", async () => {
    state.tables.notification_messages = [{ id: 90, tenant_id: 20, invoice_id: 70, subscriber_id: 30, channel: "sms", status: "pending" }];
    notificationWorker.processQueue.mockResolvedValueOnce({ requested: 1, submitted: 1, failed: 0, skipped: 0, results: [{ notificationId: 90, status: "submitted" }] });
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.notifications.sendPendingSms({ siteId: 10, invoiceIds: [70] })).resolves.toMatchObject({ requested: 1, submitted: 1, failed: 0 });
    expect(state.rpcCalls).toContainEqual({ name: "powerhub_queue_selected_invoice_sms", args: { p_user_id: 1, p_tenant_id: 20, p_site_id: 10, p_invoice_ids: [70] } });
    expect(notificationWorker.processQueue).toHaveBeenCalledWith(20, 1, [90]);
    expect(state.inserts).toContainEqual(expect.objectContaining({ table: "audit_logs" }));
  });

  it("يجهز تذكير السداد وإيصال التحصيل عبر طابور SMS الذري دون مزود حي", async () => {
    state.tables.powerhub_message_templates = [{ id: 200, tenant_id: 20, channel: "sms", event_type: "invoice_overdue", is_active: true, body: "تذكير {{balance_due}} · الرصيد الإجمالي {{total_balance}}" }];
    state.tables.site_billing_policies = [{ tenant_id: 20, site_id: 10, automatic_fraction_discount_enabled: true, fraction_carry_enabled: false }];
    notificationWorker.processById.mockResolvedValue({ status: "submitted" });
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.notifications.sendPaymentReminderSms({ siteId: 10, invoiceId: 70 })).resolves.toMatchObject({ notificationIds: [90], status: "submitted", channels: ["sms"] });
    await expect(caller.notifications.sendPaymentReceiptSms({ siteId: 10, paymentId: 81, channel: "sms" })).resolves.toMatchObject({ notificationId: 90, status: "submitted", channel: "sms" });
    const paymentSmsCalls = state.rpcCalls.filter((call) => call.name === "powerhub_queue_payment_sms");
    expect(paymentSmsCalls).toHaveLength(2);
    expect(paymentSmsCalls[0].args).toMatchObject({ p_rendered_text: "تذكير 75 · الرصيد الإجمالي 75" });
    expect(notificationWorker.processById).toHaveBeenCalledWith(90, 1);
  });

  it("يرفض تذكير السداد عند غياب قالب نشط بدلاً من إرسال قالب افتراضي", async () => {
    state.tables.powerhub_message_templates = [];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.notifications.sendPaymentReminderSms({ siteId: 10, invoiceId: 70 }))
      .rejects.toMatchObject({ message: "لا يتوفر قالب للتذكير بالسداد أعده في مركز الرسائل." });
    expect(state.rpcCalls.filter((call) => call.name === "powerhub_queue_payment_sms")).toHaveLength(0);
    expect(notificationWorker.processById).not.toHaveBeenCalled();
  });

  it("يعيد شعار بوابة الاستعلامات في theme وlookup عند وجود logo_key", async () => {
    const originalRpc = state.client.rpc;
    state.client.rpc = (name: string, args: unknown) => {
      state.rpcCalls.push({ name, args });
      if (name === "powerhub_subscriber_portal_theme") return Promise.resolve({
        data: [{ portal_code: "main", display_name: "بوابة الفرع الرئيسي", primary_color: "#0D1117", accent_color: "#F5B800", site_name: "الفرع الرئيسي", city: "غزة", logo_key: "tenant-portal-branding/20/logo-test.png" }],
        error: null,
      });
      if (name === "powerhub_subscriber_portal_lookup") return Promise.resolve({
        data: {
          portal: { portalCode: "main", displayName: "بوابة الفرع الرئيسي", primaryColor: "#0D1117", accentColor: "#F5B800", city: "غزة", logoKey: "tenant-portal-branding/20/logo-test.png" },
          subscriber: { subscriberNo: "MAIN-001", fullName: "مشترك الاختبار", phone: "+970595000000", address: null, subscriptionType: "residential", serviceStatus: "active", joinedAt: "2026-08-01T00:00:00.000Z" },
          invoices: [], payments: [],
        },
        error: null,
      });
      return originalRpc(name,args);
    };
    const originalStorage = await import("./storage");
    const signed = vi.spyOn(originalStorage, "storageGetSignedUrl").mockResolvedValue("https://signed.example/logo.png");
    const caller = powerhubRouter.createCaller({ user: null as never, req: {} as never, res: {} as never });
    await expect(caller.subscriberPortal.theme({ portalCode: "main" })).resolves.toMatchObject({ logoUrl: "https://signed.example/logo.png" });
    await expect(caller.subscriberPortal.lookup({ portalCode: "main", subscriberNo: "MAIN-001", phone: "+970595000000" })).resolves.toMatchObject({ portal: { logoUrl: "https://signed.example/logo.png" } });
    signed.mockRestore();
  });

  it("creates a payment-documentation link only through the server-validated portal RPC", async () => {
    const caller = powerhubRouter.createCaller({ user: null as never, req: {} as never, res: {} as never });
    const result = await caller.subscriberPortal.shareInvoice({
      portalCode: "main",
      subscriberNo: "MAIN-001",
      phone: "+970595000000",
      invoiceNo: "MAIN-202608-0001",
    });
    expect(result.path.startsWith("/invoice/")).toBe(true);

    const call = state.rpcCalls.find((entry) => entry.name === "powerhub_create_portal_invoice_share_link");
    expect(call).toBeDefined();
    expect(call?.args).toMatchObject({
      p_portal_code: "main",
      p_subscriber_no: "MAIN-001",
      p_phone: "+970595000000",
      p_invoice_no: "MAIN-202608-0001",
      p_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_token_preview: expect.any(String),
    });
    expect(state.rpcCalls.some((entry) => entry.name === "powerhub_subscriber_portal_invoice")).toBe(false);
  });

  it("rejects payment-link creation when the database entitlement check denies the feature", async () => {
    const originalRpc = state.client.rpc;
    state.client.rpc = (name: string, args: unknown) => {
      state.rpcCalls.push({ name, args });
      if (name === "powerhub_create_portal_invoice_share_link") {
        return Promise.resolve({ data: null, error: { code: "P0001", message: "PAYMENT_DOCUMENTATION_NOT_AVAILABLE" } }) as never;
      }
      return originalRpc(name, args);
    };
    const caller = powerhubRouter.createCaller({ user: null as never, req: {} as never, res: {} as never });
    await expect(caller.subscriberPortal.shareInvoice({
      portalCode: "main",
      subscriberNo: "MAIN-001",
      phone: "+970595000000",
      invoiceNo: "MAIN-202608-0001",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects payment-link creation for a paid invoice returned by the database", async () => {
    const originalRpc = state.client.rpc;
    state.client.rpc = (name: string, args: unknown) => {
      state.rpcCalls.push({ name, args });
      if (name === "powerhub_create_portal_invoice_share_link") {
        return Promise.resolve({ data: null, error: { code: "P0001", message: "INVOICE_ALREADY_PAID" } }) as never;
      }
      return originalRpc(name, args);
    };
    const caller = powerhubRouter.createCaller({ user: null as never, req: {} as never, res: {} as never });
    await expect(caller.subscriberPortal.shareInvoice({
      portalCode: "main",
      subscriberNo: "MAIN-001",
      phone: "+970595000000",
      invoiceNo: "MAIN-202608-0001",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يعرض بوابة المشترك العامة وفاتورتها عبر دوال Supabase بعد التحقق الثنائي دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: null as never, req: {} as never, res: {} as never });
    await expect(caller.subscriberPortal.list()).resolves.toEqual([{
      portalCode: "main", displayName: "بوابة الفرع الرئيسي", primaryColor: "#0D1117", accentColor: "#F5B800", siteName: "الفرع الرئيسي", city: "غزة", logoUrl: null,
    }]);
    await expect(caller.subscriberPortal.theme({ portalCode: "main" })).resolves.toMatchObject({ portalCode: "main", displayName: "بوابة الفرع الرئيسي" });
    await expect(caller.subscriberPortal.lookup({ portalCode: "main", subscriberNo: "MAIN-001", phone: "+970595000000" })).resolves.toMatchObject({
      subscriber: { fullName: "مشترك الاختبار", subscriberNo: "MAIN-001" }, summary: { outstandingBalance: 75 }, invoices: [{ invoiceNo: "MAIN-202608-0001" }],
    });
    await expect(caller.subscriberPortal.invoice({ portalCode: "main", subscriberNo: "MAIN-001", phone: "+970595000000", invoiceNo: "MAIN-202608-0001" })).resolves.toMatchObject({
      invoice: { invoiceNo: "MAIN-202608-0001", balanceDue: 75 }, lines: [{ description: "استهلاك كهرباء" }],
    });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "powerhub_subscriber_portal_list" }),
      expect.objectContaining({ name: "powerhub_subscriber_portal_theme", args: { p_portal_code: "main" } }),
      expect.objectContaining({ name: "powerhub_subscriber_portal_lookup", args: { p_portal_code: "main", p_subscriber_no: "MAIN-001", p_phone: "+970595000000" } }),
      expect.objectContaining({ name: "powerhub_subscriber_portal_invoice", args: { p_portal_code: "main", p_subscriber_no: "MAIN-001", p_phone: "+970595000000", p_invoice_no: "MAIN-202608-0001" } }),
    ]));
  });

  it("يعرض تقرير النطاق الزمني للفرع من Supabase دون استدعاء MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.reports.range({ siteId: 10, startDate: "2026-08-01", endDate: "2026-08-31" })).resolves.toMatchObject({
      range: { startDate: "2026-08-01", endDate: "2026-08-31" },
      summary: { invoiced: 100, collected: 25, outstanding: 75, energyKwh: 10, expenseTotal: 15, operatingProfit: 10 },
      collectors: [{ name: "محصل غير محدد", count: 1, amount: 25 }],
      topDebtors: [{ subscriber: "مشترك الاختبار", subscriberNo: "MAIN-001", invoiceNo: "MAIN-202608-0001", balanceDue: 75 }],
      paymentDetails: [{ paymentNo: "PAY-202608-0001", amount: 25 }],
    });
  });

  it("يعرض طلب ترقية الباقة الحالي من Supabase ضمن نطاق الفرع دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscription.currentUpgradeRequest({ siteId: 10 })).resolves.toMatchObject({
      id: 109,
      currentPackageCode: "basic",
      requestedPackageCode: "professional",
      status: "pending",
      note: "مراجعة الباقة",
      createdAt: expect.any(Date),
      reviewedAt: null,
    });
  });

  it("يعرض التقرير الشهري للفرع من Supabase دون استدعاء MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.reports.monthly({ siteId: 10, billingPeriod: "2026-08" })).resolves.toMatchObject({
      summary: { invoiced: 100, collected: 25, outstanding: 75, energyKwh: 10, expenseTotal: 15, operatingProfit: 10 },
      collectors: [{ name: "محصل غير محدد", count: 1, amount: 25 }],
      topDebtors: [{ subscriber: "مشترك الاختبار", subscriberNo: "MAIN-001", invoiceNo: "MAIN-202608-0001", balanceDue: 75 }],
    });
  });

  it("يعرض تقرير جميع الأفرع من Supabase ضمن نطاق المستأجر", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.reports.allBranchesRange({ siteId: 10, startDate: "2026-08-01", endDate: "2026-08-31" })).resolves.toMatchObject({
      scope: { branchCount: 1 },
      summary: { invoiced: 100, collected: 25, outstanding: 75, energyKwh: 10, expenseTotal: 15, operatingProfit: 10 },
      branchSummaries: [{ siteId: 10, branchName: "الفرع الرئيسي", invoiced: 100, collected: 25 }],
    });
  });

  it("يعرض ملخص لوحة التشغيل والنظرة المالية لجميع الأفرع من Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.dashboard.allBranchesSummary({ siteId: 10 })).resolves.toEqual({
      branchCount: 1,
      subscribers: 1,
      generators: { active: 1, maintenance: 0 },
      financial: { invoiced: 100, collected: 25, outstanding: 75, expenses: 15, operatingProfit: 10 },
      energyKwh: 10,
      failedNotifications: 1,
    });
    await expect(caller.dashboard.financialOverview({ siteId: 10, scope: "all" })).resolves.toMatchObject({
      branchSummaries: [{ id: 10, name: "الفرع الرئيسي", activeSubscribers: 1 }],
      outstanding: { total: 75, accountCount: 1 },
      topDebtors: [{ subscriberNo: "MAIN-001", invoiceNo: "MAIN-202608-0001" }],
    });
  });

  it("يرحّل كل صفحات بيانات النظرة المالية لجميع الأفرع عند تجاوز 1000 سجل", async () => {
    const originalTables = {
      invoices: state.tables.invoices,
      payments: state.tables.payments,
      expenses: state.tables.expenses,
      subscribers: state.tables.subscribers,
      notification_messages: state.tables.notification_messages,
    };
    const stamp = new Date().toISOString();
    const subscriberRows = Array.from({ length: 1001 }, (_, index) => ({
      id: 10000 + index,
      tenant_id: 20,
      site_id: 10,
      full_name: "مشترك اختبار " + String(index + 1).padStart(4, "0"),
      subscriber_no: "S-" + String(index + 1).padStart(4, "0"),
      service_status: "active",
      archived_at: null,
    }));
    state.tables.subscribers = subscriberRows;
    state.tables.invoices = subscriberRows.map((subscriber, index) => ({
      id: 20000 + index,
      tenant_id: 20,
      site_id: 10,
      subscriber_id: subscriber.id,
      invoice_no: "INV-" + String(index + 1).padStart(4, "0"),
      issue_date: stamp,
      due_date: stamp,
      total_amount: 10,
      paid_amount: 0,
      balance_due: 10,
      status: "issued",
    }));
    state.tables.payments = subscriberRows.map((subscriber, index) => ({
      id: 30000 + index,
      tenant_id: 20,
      site_id: 10,
      subscriber_id: subscriber.id,
      amount: 2,
      status: "completed",
      paid_at: stamp,
    }));
    state.tables.expenses = subscriberRows.map((_, index) => ({
      id: 40000 + index,
      tenant_id: 20,
      site_id: 10,
      amount: 1,
      occurred_at: stamp,
    }));
    state.tables.notification_messages = [
      { id: 50000, tenant_id: 999, subscriber_id: 10000, status: "failed" },
      { id: 50001, tenant_id: 20, subscriber_id: 10000, status: "completed" },
    ];

    try {
      const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
      const operationalSummary = await caller.dashboard.allBranchesSummary({ siteId: 10 });
      expect(operationalSummary).toMatchObject({
        branchCount: 1,
        subscribers: 1001,
        financial: { invoiced: 10010, collected: 0, outstanding: 10010, expenses: 1001, operatingProfit: -1001 },
        failedNotifications: 0,
      });
      const result = await caller.dashboard.financialOverview({ siteId: 10, scope: "all" });
      expect(result.branchSummaries).toEqual([
        expect.objectContaining({ id: 10, activeSubscribers: 1001, invoiced: 10010, collected: 2002, outstanding: 10010 }),
      ]);
      expect(result.outstanding).toMatchObject({ total: 10010, accountCount: 1001 });
      expect(result.month).toMatchObject({ invoiced: 10010, collected: 2002, expenses: 1001, netCash: 1001 });
    } finally {
      state.tables.invoices = originalTables.invoices;
      state.tables.payments = originalTables.payments;
      state.tables.expenses = originalTables.expenses;
      state.tables.subscribers = originalTables.subscribers;
      state.tables.notification_messages = originalTables.notification_messages;
    }
  });

  it("يرفض عرض بيانات الفرع لمستخدم لا يملك عضوية Supabase فعالة", async () => {
    state.tables.users = [{ id: 2, role: "user" }];
    state.tables.tenant_members = [];
    const caller = powerhubRouter.createCaller({ user: { id: 2, role: "user" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.list({ siteId: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ينشئ تعرفة ومولداً ويحدّث المولد عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.tariffs.create({ siteId: 10, pricePerKwh: 1.5, fixedFee: 0, taxRate: 0, clientOperationId: "00000000-0000-4000-8000-000000000041" })).resolves.toEqual({ id: 41, replayed: false });
    await expect(caller.generators.create({ siteId: 10, code: "GEN-2", name: "مولد جديد", ratedCapacityKw: "200", fuelType: "diesel" })).resolves.toEqual({ id: 51 });
    await expect(caller.generators.update({ siteId: 10, id: 50, name: "مولد محدث", ratedCapacityKw: "160", fuelLevelLiters: "20", operatingHours: "10", status: "maintenance" })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toContainEqual(expect.objectContaining({ name: "powerhub_create_tariff_idempotent", args: expect.objectContaining({ p_site_id: 10, p_price_per_kwh: 1.5, p_client_operation_id: "00000000-0000-4000-8000-000000000041" }) }));
    expect(state.inserts).toEqual(expect.arrayContaining([expect.objectContaining({ table: "generators" }), expect.objectContaining({ table: "audit_logs" })]));
    expect(state.updates).toEqual(expect.arrayContaining([expect.objectContaining({ table: "generators", values: expect.objectContaining({ status: "maintenance" }) })]));
  });

  it("يحدّث إعدادات الفرع عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.sites.updateAnomalyAlert({ siteId: 10, anomalyAlertPercent: 70 })).resolves.toEqual({ success: true, anomalyAlertPercent: 70 });
    await expect(caller.sites.updateBranch({ siteId: 10, name: "الفرع المحدث", code: "MAIN", city: "غزة", address: "العنوان", status: "active", invoiceDueDays: 21 })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "powerhub_update_site_anomaly", args: expect.objectContaining({ p_tenant_id: 20, p_anomaly_alert_percent: 70 }) }),
      expect.objectContaining({ name: "powerhub_update_site", args: expect.objectContaining({ p_invoice_due_days: 21, p_status: "active" }) }),
    ]));
  });

  it("ينشئ فرعاً عبر Supabase دون MySQL مع عضوية مالك صالحة", async () => {
    state.tables.tenant_members = [{ tenant_id: 20, user_id: 1, role: "owner", is_active: true, membership_status: "active" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.sites.create({ name: "الفرع الثاني", code: "BR2", city: "غزة", address: "العنوان" })).resolves.toEqual({ id: 11 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_create_site", args: expect.objectContaining({ p_tenant_id: 20, p_name: "الفرع الثاني", p_code: "BR2" }) })]);
  });

  it("يقرأ سياسة تعدد الأفرع من Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.sites.branchPolicy({ siteId: 10 })).resolves.toMatchObject({ isEnabled: true, planLimit: 3, maxBranches: 3, currentCount: 1, remaining: 2 });
  });

  it("يعرض إعدادات البوابة ونسبة التنبيه الشاذ من Supabase ضمن الفرع دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscriberPortal.settings({ siteId: 10 })).resolves.toMatchObject({
      siteId: 10, tenantId: 20, portalCode: "main", displayName: "الفرع الرئيسي", isEnabled: true,
    });
    await expect(caller.sites.anomalyAlert({ siteId: 10 })).resolves.toEqual({ anomalyAlertPercent: 50 });
  });

  it("يحفظ إعدادات بوابة المشترك عبر RPC Supabase ذرية دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscriberPortal.saveSettings({
      siteId: 10, portalCode: "main", displayName: "بوابة الفرع الرئيسي", primaryColor: "#0D1117", accentColor: "#F5B800", isEnabled: true,
    })).resolves.toEqual({ success: true, portalCode: "main" });
    expect(state.rpcCalls).toContainEqual(expect.objectContaining({
      name: "powerhub_save_site_portal_settings",
      args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_portal_code: "main" }),
    }));
  });

  it("يعرض هوية التقارير من Supabase ضمن نطاق المستأجر دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.reportBranding.get({ siteId: 10 })).resolves.toEqual({ companyName: "شركة المولد", reportLogoKey: null, logoUrl: null });
  });

  it("يعرض سجل التدقيق من Supabase ضمن المستأجر والفرع دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    const logs = await caller.audit.list({ siteId: 10 });
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 108, tenantId: 20, siteId: 10, userId: 1, entityType: "subscriber", entityId: "30", action: "create",
    })]));
  });

  it("يعرض ملخص وقائمة المزامنة الميدانية والفنيين من Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", name: "مدير المنصة", email: "admin@example.test" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.mobileSync.summary({ siteId: 10, from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" })).resolves.toMatchObject({
      cycles: 1, syncedReadings: 2, retryableReadings: 0, needsReviewReadings: 0, failedEvents: 0, activeTechnicians: 1,
    });
    await expect(caller.mobileSync.list({ siteId: 10, page: 1, pageSize: 25 })).resolves.toMatchObject([{
      id: 110, userId: 1, userName: "مدير المنصة", eventType: "sync_cycle", status: "success", syncedCount: 2,
    }]);
    await expect(caller.mobileSync.technicians({ siteId: 10 })).resolves.toEqual([{ id: 1, name: "مدير المنصة", email: "admin@example.test" }]);
  });

  it("يعرض قائمة القراءات الميدانية المتزامنة وتفاصيلها من Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", name: "مدير المنصة", email: "admin@example.test" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.mobileSync.readings({ siteId: 10, page: 1, pageSize: 25 })).resolves.toMatchObject([{
      id: 60, versionNo: 1, subscriberName: "مشترك الاختبار", subscriberNo: "MAIN-001", previousReading: 90, currentReading: 100, userId: 1,
    }]);
    await expect(caller.mobileSync.readingDetail({ siteId: 10, readingId: 60 })).resolves.toMatchObject({
      id: 60, versionNo: 1, subscriberId: 30, subscriberName: "مشترك الاختبار", currentReading: 100, consumptionKwh: 10,
      technicianName: "مدير المنصة", technicianEmail: "admin@example.test",
    });
  });

  it("يعرض القراءات الميدانية القديمة المسجلة باسم subscriber_reading", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", name: "مدير المنصة", email: "admin@example.test" }];
    state.tables.audit_logs = [{
      id: 109, tenant_id: 20, site_id: 10, user_id: 1, actor_platform_role: "platform_admin",
      actor_tenant_role: "owner", entity_type: "subscriber_reading", entity_id: "60",
      action: "mobile_create", before_data: null, after_data: { readingValue: "100" },
      metadata: null, created_at: "2026-08-03T00:00:00.000Z",
    }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.mobileSync.readings({ siteId: 10, page: 1, pageSize: 25 })).resolves.toEqual([expect.objectContaining({
      id: 60, subscriberName: "مشترك الاختبار", subscriberNo: "MAIN-001", previousReading: 90, currentReading: 100, userId: 1,
    })]);
    await expect(caller.mobileSync.readingDetail({ siteId: 10, readingId: 60 })).resolves.toMatchObject({
      id: 60, subscriberId: 30, subscriberName: "مشترك الاختبار", currentReading: 100,
      technicianName: "مدير المنصة", technicianEmail: "admin@example.test",
    });
  });

  it("يعرض الموظفين والسلف وكشوف الرواتب من Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.hr.listEmployees({ siteId: 10, employmentStatus: "active" })).resolves.toMatchObject([{ id: 120, fullName: "محاسب الاختبار", baseWage: "1000" }]);
    await expect(caller.hr.listAdjustments({ siteId: 10, status: "open" })).resolves.toMatchObject([{
      adjustment: { id: 121, employeeId: 120, amount: "100", remainingAmount: "100" }, employee: { id: 120, fullName: "محاسب الاختبار" },
    }]);
    await expect(caller.hr.listPayrollRuns({ siteId: 10, period: "2026-08" })).resolves.toMatchObject([{ id: 122, totalNet: "900", status: "draft" }]);
    await expect(caller.hr.getPayrollDetails({ siteId: 10, payrollRunId: 122 })).resolves.toMatchObject([{
      item: { id: 123, payrollRunId: 122, netAmount: "900" }, employee: { id: 120, fullName: "محاسب الاختبار", jobTitle: "accountant" },
    }]);
  });

  it("يعرض سجل الحضور وملخص الموارد البشرية من Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.hr.listAttendance({ siteId: 10, fromDate: "2026-08-01", toDate: "2026-08-31" })).resolves.toMatchObject([{
      attendance: { id: 124, employeeId: 120, regularHours: "8", overtimeHours: "1" }, employee: { id: 120, fullName: "محاسب الاختبار" },
    }]);
    await expect(caller.hr.overview({ siteId: 10, period: "2026-08" })).resolves.toMatchObject({
      employees: [{ status: "active", count: 1, wages: 1000 }], payroll: { count: 1, totalGross: 1000, totalDeductions: 100, totalNet: 900 },
    });
    await expect(caller.hr.upsertAttendance({ siteId: 10, employeeId: 120, workDate: "2026-08-03", regularHours: 8, overtimeHours: 1, absentDays: 0 })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toContainEqual(expect.objectContaining({
      name: "powerhub_upsert_employee_attendance",
      args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_employee_id: 120, p_work_date: "2026-08-03" }),
    }));
  });

  it("يفعّل جدولة الإرسال التلقائي للفواتير عبر Supabase ويحدّث إعداد القناة", async () => {
    state.tables.tenant_messaging_configurations = [{
      id: 95, tenant_id: 20, channel: "sms", provider: "tweetsms", sender_id: "PowerHub", phone_number_id: null,
      template_name: "invoice", receipt_template_name: "receipt", subscriber_reference_template_name: null,
      is_active: true, auto_send_after_approval: false, auto_send_cron: null, schedule_cron_task_uid: null,
      updated_at: "2026-08-25T00:00:00.000Z",
    }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.messaging.configureInvoiceAutoSend({ siteId: 10, enabled: true, scheduleMode: "every_15_days", scheduleAnchorAt: "2026-08-25T20:00:00.000Z" })).resolves.toMatchObject({ enabled: true, scheduleMode: "every_15_days", scheduleAnchorAt: expect.any(String), cron: null });
    expect(state.updates).toContainEqual(expect.objectContaining({
      table: "tenant_messaging_configurations",
      values: expect.objectContaining({ auto_send_after_approval: true, auto_send_cron: null, invoice_sms_schedule_mode: "every_15_days", invoice_sms_schedule_anchor_at: "2026-08-25T20:00:00.000Z" }),
    }));
  });

  it("يعرض حصة SMS واستهلاكها وطلب الحزمة من Supabase فقط", async () => {
    state.tables.notification_messages = [
      { id: 90, tenant_id: 20, channel: "sms", status: "submitted", created_at: "2026-08-25T08:00:00.000Z" },
      { id: 92, tenant_id: 20, channel: "sms", status: "needs_review", created_at: "2026-08-25T09:00:00.000Z" },
      { id: 91, tenant_id: 20, channel: "sms", status: "failed", created_at: "2026-08-25T09:00:00.000Z" },
    ];
    state.tables.sms_package_requests = [{ id: 97, tenant_id: 20, status: "approved", requested_messages: 500, approved_messages: 500, note: "مراجعة", created_at: "2026-08-20T00:00:00.000Z", reviewed_at: "2026-08-21T00:00:00.000Z" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.messaging.smsQuota({ siteId: 10 })).resolves.toMatchObject({ senderName: "PowerHub", total: 1000, used: 2, remaining: 998, configured: true });
    await expect(caller.messaging.smsDailyUsage({ siteId: 10 })).resolves.toMatchObject({ total: 1000, used: 2, remaining: 998, points: expect.any(Array) });
    await expect(caller.messaging.currentSmsPackageRequest({ siteId: 10 })).resolves.toMatchObject({ id: 97, status: "approved", requestedMessages: 500, approvedMessages: 500, createdAt: expect.any(Date) });
  });

  it("ينشئ طلب حزمة SMS عبر دالة Supabase الذرية دون MySQL أو مزود خارجي", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.messaging.requestSmsPackage({ siteId: 10, packageId: 501, note: "طلب اختبار" })).resolves.toEqual({ id: 98, status: "pending" });
    expect(state.rpcCalls).toContainEqual({ name: "powerhub_request_sms_package_plan", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_sms_plan_id: 501, p_note: "طلب اختبار" }) });
  });

  it("يعرض إعدادات الرسائل والقوالب وسجل الجدولة من Supabase دون Heartbeat أو MySQL", async () => {
    state.tables.tenant_messaging_configurations = [{ id: 95, tenant_id: 20, channel: "sms", provider: "tweetsms", sender_id: "PowerHub", phone_number_id: null, template_name: "invoice", receipt_template_name: "receipt", subscriber_reference_template_name: null, is_active: false, auto_send_after_approval: false, auto_send_cron: null, schedule_cron_task_uid: null, updated_at: "2026-08-25T00:00:00.000Z" }];
    state.tables.messaging_schedule_runs = [{ id: 96, tenant_id: 20, configuration_id: 95, status: "success", scanned: 2, submitted: 0, failed: 0, skipped: 2, error: null, task_uid: null, started_at: "2026-08-25T00:00:00.000Z", finished_at: "2026-08-25T00:01:00.000Z" }];
    state.tables.platform_settings = [{ setting_key: "invoice_delivery_channels", is_enabled: false, value: { sms: false, whatsapp: false }, message: "الإرسال الخارجي معطل" }];
    state.tables.tenant_invoice_message_templates = [{ id: 97, tenant_id: 20, channel: "sms", event_type: "invoice_issued", body: "فاتورتك جاهزة", is_active: true, created_at: "2026-08-20T00:00:00.000Z", updated_at: "2026-08-20T00:00:00.000Z" }];
    state.tables.tenant_payment_receipt_message_templates = [{ id: 98, tenant_id: 20, channel: "sms", body: "تم استلام الدفعة", is_active: true, created_at: "2026-08-20T00:00:00.000Z", updated_at: "2026-08-20T00:00:00.000Z" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.messaging.listConfigurations({ siteId: 10 })).resolves.toMatchObject([{ id: 95, channel: "sms", isActive: false, updatedAt: expect.any(Date) }]);
    await expect(caller.messaging.listScheduleRuns({ siteId: 10, limit: 20 })).resolves.toMatchObject([{ id: 96, submitted: 0, startedAt: expect.any(Date), finishedAt: expect.any(Date) }]);
    await expect(caller.messaging.deliveryPolicy({ siteId: 10 })).resolves.toMatchObject({ configured: true, message: "الإرسال الخارجي معطل" });
    await expect(caller.messaging.listInvoiceTemplates({ siteId: 10 })).resolves.toMatchObject([{ id: 97, body: "فاتورتك جاهزة", isActive: true, createdAt: expect.any(Date) }]);
    await expect(caller.messaging.listPaymentReceiptTemplates({ siteId: 10 })).resolves.toMatchObject([{ id: 98, body: "تم استلام الدفعة", isActive: true, createdAt: expect.any(Date) }]);
  });

  it("يحفظ قوالب الرسائل في Supabase ويعطّل حفظ الاعتمادات الموروث", async () => {
    state.tables.platform_settings = [{ setting_key: "invoice_delivery_channels", is_enabled: true, value: { smsEnabled: true, whatsappEnabled: true }, message: null }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.messaging.saveInvoiceTemplate({ siteId: 10, channel: "sms", body: "مرحباً {{subscriber_name}}، فاتورتك {{invoice_no}} جاهزة.", isActive: true })).resolves.toEqual({ success: true });
    await expect(caller.messaging.savePaymentReceiptTemplate({ siteId: 10, body: "مرحباً {{subscriber_name}}، تم استلام دفعتك بنجاح.", isActive: true })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toContainEqual({
      name: "powerhub_sync_invoice_sms_template",
      args: expect.objectContaining({
        p_tenant_id: 20,
        p_body: "مرحباً {{subscriber_name}}، فاتورتك {{invoice_no}} جاهزة.",
        p_is_active: true,
        p_actor_user_id: 1,
      }),
    });
    expect(state.inserts).not.toContainEqual({ table: "tenant_invoice_message_templates", values: expect.anything() });
    expect(state.inserts).toContainEqual({ table: "tenant_payment_receipt_message_templates", values: expect.objectContaining({ tenant_id: 20, channel: "sms", is_active: true }) });
    await expect(caller.messaging.saveConfiguration({ siteId: 10, channel: "sms", provider: "tweetsms", credential: "credential-long-enough", isActive: true })).resolves.toMatchObject({ success: true, channel: "sms", provider: "tweetsms", isActive: true });
  });

  it("يعرض سجل الإشعارات ويشغّل الإرسال وإعادة المحاولة عبر مسارات Supabase", async () => {
    state.tables.notification_messages = [{ id: 99, tenant_id: 20, invoice_id: 70, subscriber_id: 30, channel: "sms", event_type: "invoice_issued", recipient: "+970595000000", status: "failed", provider_message_id: null, payload: { invoiceNo: "MAIN-202608-0001" }, attempts: 1, last_error: "غير مهيأ", created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z" }];
    notificationWorker.processById.mockResolvedValue({ status: "submitted", providerMessageId: "provider-1" });
    notificationWorker.processQueue.mockResolvedValue({ requested: 1, submitted: 1, failed: 0, skipped: 0, results: [{ notificationId: 99, status: "submitted" }] });
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.notifications.list({ siteId: 10, eventType: "invoice_issued" })).resolves.toMatchObject([{ notification: { id: 99, status: "failed", createdAt: expect.any(Date) }, subscriber: { id: 30, fullName: "مشترك الاختبار" }, invoiceNo: "MAIN-202608-0001" }]);
    await expect(caller.notifications.retry({ siteId: 10, notificationId: 99 })).resolves.toMatchObject({ status: "submitted" });
    await expect(caller.notifications.retryFailedInvoiceNotification({ siteId: 10, notificationId: 99 })).resolves.toMatchObject({ status: "submitted" });
    await expect(caller.notifications.retryFailedInvoiceNotifications({ siteId: 10, notificationIds: [99] })).resolves.toMatchObject({ requested: 1, eligible: 1, submitted: 1, failed: 0 });
    state.tables.notification_messages[0].status = "pending";
    await expect(caller.notifications.sendDeferredInvoices({ siteId: 10, limit: 1 })).resolves.toMatchObject({ requested: 1, submitted: 1, failed: 0 });
  });

  it("يعرض سجل عمليات الإرسال الجماعي وتفاصيله من Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", name: "مالك الاختبار", email: "owner@example.com" }];
    state.tables.audit_logs = [{ id: 109, tenant_id: 20, site_id: 10, user_id: 1, entity_type: "notification_batch", entity_id: "99", action: "send_deferred_invoice_notifications", metadata: { notificationIds: [99], requested: 1, submitted: 0, failed: 1 }, created_at: "2026-08-25T00:00:00.000Z" }];
    state.tables.notification_messages = [{ id: 99, tenant_id: 20, invoice_id: 70, subscriber_id: 30, channel: "sms", event_type: "invoice_issued", recipient: "+970595000000", status: "failed", provider_message_id: null, payload: {}, attempts: 1, last_error: "غير مهيأ", created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.notifications.listBulkInvoiceSends({ siteId: 10 })).resolves.toMatchObject([{ id: 109, action: "send_deferred_invoice_notifications", executorId: 1, executorName: "مالك الاختبار", createdAt: expect.any(Date) }]);
    await expect(caller.notifications.bulkInvoiceSendDetails({ siteId: 10, auditLogId: 109 })).resolves.toMatchObject({ operation: { id: 109, createdAt: expect.any(Date) }, items: [{ notificationId: 99, invoiceId: 70, invoiceNo: "MAIN-202608-0001", subscriberName: "مشترك الاختبار", status: "failed" }] });
  });

  it("يقرأ ويحفظ تفضيلات الإجراءات السريعة عبر Supabase دون MySQL", async () => {
    state.tables.user_quick_action_preferences = [{ user_id: 1, site_id: 10, action_ids: ["record_reading"], updated_at: "2026-08-01T00:00:00.000Z" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.quickActions.preferences({ siteId: 10 })).resolves.toEqual({ actionIds: ["record_reading"], updatedAt: expect.any(Date) });
    await expect(caller.quickActions.savePreferences({ siteId: 10, actionIds: ["record_reading", "collect_payment"] })).resolves.toEqual({ success: true, actionIds: ["record_reading", "collect_payment"] });
    expect(state.inserts).toContainEqual({ table: "user_quick_action_preferences", values: { user_id: 1, site_id: 10, action_ids: ["record_reading", "collect_payment"] } });
    expect(state.inserts).toContainEqual(expect.objectContaining({ table: "audit_logs" }));
  });

  it("يقرأ وصول الموظف وامتداد الفروع وسجل تغييرات الصلاحيات من Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 2, role: "user" }];
    state.tables.tenant_members = [{ tenant_id: 20, user_id: 2, role: "member", is_active: true, membership_status: "active" }];
    state.tables.staff_profiles = [{ id: 120, tenant_id: 20, user_id: 2, site_id: null, role: "manager", permissions: ["manageSubscribers"], custom_role_id: null, suspension_started_at: null, suspension_ends_at: null, is_active: true }];
    const staffCaller = powerhubRouter.createCaller({ user: { id: 2, role: "user" } as never, req: {} as never, res: {} as never });
    await expect(staffCaller.staff.myAccess({ siteId: 10 })).resolves.toEqual({ role: "manager", permissions: ["manageSubscribers"], tenantId: 20, usesPermissionOverride: true });
    await expect(staffCaller.staff.allBranchAccess({ siteId: 10 })).resolves.toEqual({ isGlobal: true });
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active" }];
    state.tables.audit_logs = [{ id: 121, tenant_id: 20, site_id: 10, user_id: 2, entity_type: "staff_profile", entity_id: "120", action: "update_permissions", after_data: { permissions: ["manageSubscribers"] }, metadata: { targetUserId: 2 }, created_at: "2026-08-26T00:00:00.000Z" }];
    const ownerCaller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(ownerCaller.staff.permissionChanges({ siteId: 10, userId: 2 })).resolves.toMatchObject([{ id: 121, userId: 2, action: "update_permissions", createdAt: expect.any(Date), afterData: { permissions: ["manageSubscribers"] } }]);
  });

  it("يعرض كتالوج الصلاحيات والأدوار المخصصة النشطة من Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active" }];
    state.tables.custom_permission_roles = [{ id: 122, tenant_id: 20, name: "دور التحصيل", description: "صلاحيات تحصيل", permissions: ["collectPayments"], is_active: true }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.permissionCatalog({ siteId: 10 })).resolves.toContain("manageTeam");
    await expect(caller.staff.customRoles({ siteId: 10 })).resolves.toEqual([{ id: 122, name: "دور التحصيل", description: "صلاحيات تحصيل", permissions: ["collectPayments"], isActive: true }]);
  });

  it("يحفظ ويحذف الدور المخصص بمعاملات Supabase الذرية دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.saveCustomRole({ siteId: 10, name: "دور التحصيل", description: "صلاحيات تحصيل", permissions: ["collectPayments"] })).resolves.toEqual({ success: true, id: 122 });
    await expect(caller.staff.deleteCustomRole({ siteId: 10, roleId: 122 })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      { name: "powerhub_save_custom_permission_role", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_role_id: null, p_permissions: ["collectPayments"] }) },
      { name: "powerhub_delete_custom_permission_role", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_role_id: 122 }) },
    ]));
  });

  it("يعدّل صلاحيات الحساب الفرعي عبر معاملة Supabase الذرية دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.updatePermissions({ siteId: 10, profileId: 120, customRoleId: 122, permissions: ["collectPayments"] })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toContainEqual({ name: "powerhub_update_staff_profile_permissions", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_actor_user_id: 1, p_profile_id: 120, p_custom_role_id: 122, p_permissions: ["collectPayments"] }) });
  });

  it("يوقف الحساب الفرعي ويرفع التوقيف ويحدث حالته عبر Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.suspend({ siteId: 10, profileId: 120, startsAt: "2026-08-10T10:00:00.000Z", endsAt: "2026-08-10T12:00:00.000Z" })).resolves.toMatchObject({ success: true, suspensionEndsAt: expect.any(Date) });
    await expect(caller.staff.clearSuspension({ siteId: 10, profileId: 120 })).resolves.toEqual({ success: true });
    await expect(caller.staff.setActive({ siteId: 10, profileId: 120, isActive: false })).resolves.toEqual({ success: true, isActive: false });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      { name: "powerhub_update_staff_profile_status", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_actor_user_id: 1, p_profile_id: 120, p_operation: "suspend" }) },
      { name: "powerhub_update_staff_profile_status", args: expect.objectContaining({ p_profile_id: 120, p_operation: "clear_suspension" }) },
      { name: "powerhub_update_staff_profile_status", args: expect.objectContaining({ p_profile_id: 120, p_operation: "set_active", p_is_active: false }) },
    ]));
  });

  it("يعرض سجل نشاط الحساب الفرعي من Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active" }];
    state.tables.audit_logs = [{ id: 125, tenant_id: 20, site_id: 10, user_id: 2, entity_type: "staff_profile", action: "update_permissions", metadata: { source: "team" }, after_data: { permissions: ["collectPayments"] }, created_at: "2026-08-10T12:00:00.000Z" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.activity({ siteId: 10, userId: 2 })).resolves.toMatchObject([{ id: 125, action: "update_permissions", entityType: "staff_profile", createdAt: expect.any(Date), metadata: { source: "team" } }]);
  });

  it("يعرض قائمة الحسابات ودليل التعيين من Supabase ضمن المستأجر والفرع فقط دون MySQL", async () => {
    state.tables.users = [
      { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", name: "مدير المنصة", email: "admin@example.com", auth_user_id: "00000000-0000-4000-8000-000000000001", login_method: "supabase", must_change_password: false, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z", last_signed_in: "2026-08-05T00:00:00.000Z" },
      { id: 2, role: "user", name: "محاسب الفرع", email: "accountant@example.com", auth_user_id: "00000000-0000-4000-8000-000000000002", login_method: "supabase", account_status: "active", must_change_password: false, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z", last_signed_in: "2026-08-04T00:00:00.000Z" },
      { id: 3, role: "user", name: "موظف مستأجر آخر", email: "outside@example.com", auth_user_id: "00000000-0000-4000-8000-000000000003", login_method: "supabase", account_status: "active", must_change_password: false, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z", last_signed_in: "2026-08-06T00:00:00.000Z" },
    ];
    state.tables.tenant_members = [
      { tenant_id: 20, user_id: 2, role: "member", is_active: true, membership_status: "active" },
      { tenant_id: 99, user_id: 3, role: "member", is_active: true, membership_status: "active" },
    ];
    state.tables.staff_profiles = [
      { id: 126, tenant_id: 20, user_id: 2, site_id: 10, role: "accountant", custom_role_id: null, permissions: ["collectPayments"], suspension_started_at: null, suspension_ends_at: null, is_active: true, archived_at: null, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" },
      { id: 127, tenant_id: 20, user_id: 3, site_id: 11, role: "collector", custom_role_id: null, permissions: [], suspension_started_at: null, suspension_ends_at: null, is_active: true, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" },
    ];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.list({ siteId: 10 })).resolves.toMatchObject([{ profile: { id: 126, tenantId: 20, siteId: 10, role: "accountant", createdAt: expect.any(Date) }, user: { id: 2, name: "محاسب الفرع", email: "accountant@example.com" } }]);
    await expect(caller.staff.directory({ siteId: 10 })).resolves.toEqual([{ id: 2, name: "محاسب الفرع", email: "accountant@example.com", role: "user" }]);
  });

  it("يقرأ سياسة أدوار وحدود الحسابات الفرعية من Supabase مع تجاوز المستأجر والعدد النشط", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active" }];
    state.tables.tenant_subscriptions = [{ tenant_id: 20, package_code: "professional", status: "active", ends_at: "2026-12-31T23:59:59.999Z" }];
    state.tables.tenants = [{ id: 20, plan: "professional", package_code: "professional" }];
    state.tables.platform_settings = [
      { setting_key: "owner_subaccount_roles", is_enabled: true, value: { allowedRoles: ["accountant", "viewer", "owner"] } },
      { setting_key: "owner_subaccount_limits", is_enabled: true, value: { limits: { professional: 5 } } },
      { setting_key: "owner_limit_overrides", is_enabled: true, value: { overrides: { "20": { subaccountLimit: 3, allowedRoles: ["accountant"] } } } },
    ];
    state.tables.tenant_members = [
      { tenant_id: 20, user_id: 2, role: "member", is_active: true, membership_status: "active" },
      { tenant_id: 20, user_id: 3, role: "member", is_active: true, membership_status: "active" },
      { tenant_id: 20, user_id: 6, role: "member", is_active: true, membership_status: "active" },
      { tenant_id: 20, user_id: 4, role: "member", is_active: false, membership_status: "active" },
      { tenant_id: 99, user_id: 5, role: "member", is_active: true, membership_status: "active" },
    ];
    state.tables.staff_profiles = [
      { id: 126, tenant_id: 20, user_id: 2, site_id: 10, role: "accountant", custom_role_id: null, permissions: [], suspension_started_at: null, suspension_ends_at: null, is_active: true, archived_at: null },
      { id: 127, tenant_id: 20, user_id: 3, site_id: 10, role: "technician", custom_role_id: null, permissions: [], suspension_started_at: null, suspension_ends_at: null, is_active: true, archived_at: null },
      { id: 128, tenant_id: 20, user_id: 6, site_id: 10, role: "viewer", custom_role_id: null, permissions: [], suspension_started_at: null, suspension_ends_at: null, is_active: true, archived_at: null },
      { id: 129, tenant_id: 20, user_id: 4, site_id: 10, role: "accountant", custom_role_id: null, permissions: [], suspension_started_at: null, suspension_ends_at: null, is_active: true, archived_at: null },
    ];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.allowedSubaccountRoles({ siteId: 10 })).resolves.toEqual({ roles: ["accountant"], limit: 3, currentCount: 2, remaining: 1, fieldUserLimit: 0, fieldUserCount: 1, fieldUserRemaining: 0 });
  });

  it("يعيّن حساباً موجوداً عبر معاملة Supabase الذرية دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.assign({ siteId: 10, userId: 2, role: "accountant", allBranches: true })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toContainEqual({ name: "powerhub_assign_existing_staff", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_actor_user_id: 1, p_target_user_id: 2, p_role: "accountant", p_all_branches: true }) });
  });

  it("يعيد تعيين كلمة مرور الحساب الفرعي عبر Supabase Auth ثم يكمل Intent ذريًا", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", auth_user_id: "auth-admin-1", email: "owner@example.test" }, { id: 2, role: "user", account_status: "active", auth_user_id: "auth-staff-1", email: "staff@example.test" }];
    state.tables.staff_profiles = [{ id: 70, tenant_id: 20, site_id: 10, user_id: 2, role: "accountant", permissions: [], custom_role_id: null, suspension_started_at: null, suspension_ends_at: null, is_active: true }, { tenant_id: 20, site_id: 10, user_id: 1, is_active: true }];
    state.client.auth = { admin: { updateUserById: vi.fn(async () => ({ data: { user: { id: "auth-staff-1" } }, error: null })) } };
    state.rpcCalls.splice(0);
    state.client.rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (name === "powerhub_staff_reset_password_begin") return { data: [{ intent_id: 501, auth_user_id: "auth-staff-1", target_user_id: 2, expires_at: "2026-09-22T18:00:00.000Z" }], error: null };
      if (name === "powerhub_staff_reset_password_complete") return { data: [{ intent_id: 501, status: "completed", target_user_id: 2 }], error: null };
      return { data: [{ success: true }], error: null };
    });
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    const result = await caller.staff.resetPassword({ siteId: 10, profileId: 70 });
    expect(result).toMatchObject({ success: true, userId: 2 });
    expect(result.temporaryPassword).toMatch(/^Ph!/);
    expect(state.client.auth.admin.updateUserById).toHaveBeenCalledWith("auth-staff-1", expect.objectContaining({ password: expect.stringMatching(/^Ph!/) }));
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "powerhub_staff_reset_password_begin", args: expect.objectContaining({ p_profile_id: 70 }) }),
      expect.objectContaining({ name: "powerhub_staff_reset_password_complete", args: expect.objectContaining({ p_intent_id: 501, p_success: true }) }),
    ]));
  });

  it("ينشئ الحساب الفرعي عبر Supabase Auth ثم يعيّنه عبر RPC دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", auth_user_id: "auth-admin-1", email: "admin@example.test" }];
    state.tables.users.push({ id: 2, auth_user_id: "auth-staff-1", email: "auth-staff@example.test", role: "user", account_status: "active" });
    state.client.auth = { admin: { createUser: vi.fn(async () => ({ data: { user: { id: "auth-staff-1" } }, error: null })), deleteUser: vi.fn(async () => ({ error: null })) } };
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.create({ siteId: 10, name: "محاسب تجريبي", email: "accountant@example.com", temporaryPassword: "StrongPass1!", role: "accountant", allBranches: false })).resolves.toMatchObject({ success: true, userId: 2 });
    expect(state.rpcCalls).toContainEqual(expect.objectContaining({ name: "powerhub_assign_existing_staff", args: expect.objectContaining({ p_target_user_id: 2, p_role: "accountant", p_all_branches: false }) }));
  });

  it("ينشئ المشترك بالدالة الذرية في Supabase من دون تشغيل عامل الرسائل الموروث", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.create({ siteId: 10, fullName: "مشترك جديد", phone: "+970595123456", subscriptionType: "residential", clientOperationId: "11111111-1111-4111-8111-111111111111" }))
      .resolves.toEqual({ id: 31, subscriberNo: expect.any(String), referenceNotifications: [], replayed: false });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([expect.objectContaining({ name: "powerhub_create_subscriber", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_quota_limit: 500 }) })]));
    expect(state.inserts.some((entry) => entry.table === "notification_messages")).toBe(false);
  });

  it("يحدّث المشترك بالدالة الذرية في Supabase من دون استدعاء MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.update({ siteId: 10, id: 30, fullName: "مشترك محدث", phone: "+970595123456", address: "غزة", subscriptionType: "commercial", serviceStatus: "active", clientOperationId: "22222222-2222-4222-8222-222222222222", expectedUpdatedAt: new Date("2026-08-01T00:00:00.000Z") }))
      .resolves.toEqual({ success: true, updatedAt: new Date("2026-08-03T00:00:00.000Z"), replayed: false });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_update_subscriber", args: expect.objectContaining({ p_tenant_id: 20, p_subscriber_id: 30, p_service_status: "active" }) })]);
  });

  it("يرفض إعادة تشغيل تعديل مشترك إذا كان معرّف العملية مسجلاً ضمن مستأجر أو فرع آخر", async () => {
    const previousOperations = state.tables.offline_sync_operations;
    const operationId = "22222222-2222-4222-8222-222222222222";
    state.tables.offline_sync_operations = [{
      tenant_id: 99, site_id: 10, user_id: 1, client_operation_id: operationId,
      entity_type: "subscriber", operation_type: "subscriber_update",
      response: { success: true, updatedAt: "2026-08-03T00:00:00.000Z" },
    }];
    try {
      const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
      await expect(caller.subscribers.update({
        siteId: 10, id: 30, fullName: "مشترك محدث", phone: "+970595123456", address: "غزة",
        subscriptionType: "commercial", serviceStatus: "active", clientOperationId: operationId,
        expectedUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
      })).rejects.toThrow("معرّف عملية المزامنة مستخدم ضمن مستأجر أو فرع مختلف.");
      expect(state.rpcCalls.some((call) => call.name === "powerhub_update_subscriber")).toBe(false);
    } finally {
      if (previousOperations) state.tables.offline_sync_operations = previousOperations;
      else delete state.tables.offline_sync_operations;
    }
  });

  it("يرفض تسجيل القراءة قبل رفع الصورة إذا لم توجد تعرفة فعالة", async () => {
    const originalTariffs = state.tables.tariffs;
    state.tables.tariffs = [];
    try {
      const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
      await expect(caller.readings.create({
        siteId: 10, subscriberId: 30, readingValue: "115", captureMethod: "manual",
        imageData: "aW1hZ2UtZGF0YQ==", imageMime: "image/jpeg",
        clientOperationId: "44444444-4444-4444-8444-444444444444",
      })).rejects.toThrow("لا توجد تعرفة فعالة");
      expect(state.rpcCalls.some((call) => call.name === "powerhub_create_reading_and_issue_invoice")).toBe(false);
    } finally {
      state.tables.tariffs = originalTariffs;
    }
  });

  it("يسجل القراءة ويعتمدها ويصدر فاتورتها بمكالمة ذرية واحدة من دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.readings.create({ siteId: 10, subscriberId: 30, readingValue: "115", captureMethod: "manual", clientOperationId: "33333333-3333-4333-8333-333333333333", notes: "قراءة دورية" }))
      .resolves.toMatchObject({ id: 61, consumptionKwh: 15, status: "approved", replayed: false, invoiceId: 71, invoiceNo: "PH-MAIN-202608-00002", totalAmount: 150, alreadyProcessed: false });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_create_reading_and_issue_invoice",
      args: expect.objectContaining({
        p_tenant_id: 20, p_site_id: 10, p_subscriber_id: 30, p_reading_value: "115",
        p_can_override_same_day: false, p_billing_period: expect.stringMatching(/^\d{4}-\d{2}$/),
        p_due_date: expect.any(String),
      }),
    })]);
  });

  it("يعدّل ويحذف القراءة المعلقة بدوال Supabase الذرية من دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.readings.updatePending({ siteId: 10, readingId: 60, baseVersion: 1, readingValue: "110", readingAt: new Date("2026-08-03T00:00:00.000Z"), notes: "تصحيح" }))
      .resolves.toEqual({ success: true, consumptionKwh: 20 });
    await expect(caller.readings.deletePending({ siteId: 10, readingId: 60, baseVersion: 2 })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual([
      expect.objectContaining({ name: "powerhub_update_pending_reading", args: expect.objectContaining({ p_tenant_id: 20, p_reading_id: 60, p_base_version: 1 }) }),
      expect.objectContaining({ name: "powerhub_delete_pending_reading", args: expect.objectContaining({ p_tenant_id: 20, p_reading_id: 60, p_base_version: 2 }) }),
    ]);
  });

  it("يعتمد القراءة ويصدر فاتورتها عبر Supabase من دون MySQL أو عامل إرسال", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.readings.approve({ siteId: 10, readingId: 60, baseVersion: 1, sendNow: false })).resolves.toEqual({ success: true });
    await expect(caller.invoices.createFromReading({ siteId: 10, readingId: 60, tariffId: 40, billingPeriod: "2026-08", dueDate: new Date("2026-09-01T00:00:00.000Z"), discountAmount: 0, clientOperationId: "44444444-4444-4444-8444-444444444444" }))
      .resolves.toEqual({ id: 71, invoiceNo: "PH-MAIN-202608-00002", totalAmount: 150, replayed: false });
    expect(state.rpcCalls).toEqual([
      expect.objectContaining({ name: "powerhub_approve_reading", args: expect.objectContaining({ p_tenant_id: 20, p_reading_id: 60, p_base_version: 1 }) }),
      expect.objectContaining({ name: "powerhub_issue_invoice_from_reading", args: expect.objectContaining({ p_tenant_id: 20, p_reading_id: 60, p_tariff_id: 40, p_billing_period: "2026-08", p_due_date: "2026-08-16T00:00:00.000Z" }) }),
    ]);
    expect(state.inserts.some((entry) => entry.table === "notification_messages")).toBe(false);
  });

  it("يسجل التحصيل الذري عبر Supabase من دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.payments.create({ siteId: 10, subscriberId: 30, invoiceId: 70, paymentNo: "PAY-202608-0001", amount: 25, paymentMethod: "cash", companyAccountId: 90, clientOperationId: "55555555-5555-4555-8555-555555555555" }))
      .resolves.toEqual({ id: 81, replayed: false });
    expect(state.rpcCalls).toEqual([
      expect.objectContaining({ name: "powerhub_create_payment", args: expect.objectContaining({ p_tenant_id: 20, p_subscriber_id: 30, p_invoice_id: 70, p_company_account_id: 90, p_amount: 25 }) }),
    ]);
  });

  it("preserves already-applied results returned by idempotent Supabase RPCs", async () => {
    const originalRpc = state.client.rpc;
    const replayResponses: Record<string, unknown[]> = {
      powerhub_create_subscriber: [{ subscriber_id: 31, subscriber_no: "MAIN-001", replayed: true }],
      powerhub_update_subscriber: [{ updated_at: "2026-08-03T00:00:00.000Z", replayed: true }],
      powerhub_issue_invoice_from_reading: [{ invoice_id: 71, invoice_no: "PH-MAIN-202608-00002", total_amount: 150, replayed: true }],
      powerhub_create_payment: [{ payment_id: 81, replayed: true }],
    };
    state.client.rpc = vi.fn(async (name: string, args: unknown) => {
      state.rpcCalls.push({ name, args });
      if (replayResponses[name]) return { data: replayResponses[name], error: null };
      return state.defaultRpc(name, args);
    });
    try {
      const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });

      await expect(caller.subscribers.create({
        siteId: 10, fullName: "مشترك جديد", phone: "+970595123456", subscriptionType: "residential",
        clientOperationId: "11111111-1111-4111-8111-111111111112",
      })).resolves.toMatchObject({ id: 31, replayed: true });

      await expect(caller.subscribers.update({
        siteId: 10, id: 30, fullName: "مشترك محدث", phone: "+970595123456", address: "غزة",
        subscriptionType: "commercial", serviceStatus: "active",
        clientOperationId: "22222222-2222-4222-8222-222222222223",
        expectedUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
      })).resolves.toMatchObject({ success: true, replayed: true });

      await expect(caller.invoices.createFromReading({
        siteId: 10, readingId: 60, tariffId: 40, billingPeriod: "2026-08",
        dueDate: new Date("2026-09-01T00:00:00.000Z"), discountAmount: 0,
        clientOperationId: "44444444-4444-4444-8444-444444444445",
      })).resolves.toMatchObject({ id: 71, invoiceNo: "PH-MAIN-202608-00002", replayed: true });

      await expect(caller.payments.create({
        siteId: 10, subscriberId: 30, invoiceId: 70, paymentNo: "PAY-202608-0004",
        amount: 25, paymentMethod: "cash", companyAccountId: 90,
        clientOperationId: "55555555-5555-4555-8555-555555555556",
      })).resolves.toEqual({ id: 81, replayed: true });
    } finally {
      state.client.rpc = originalRpc;
    }
  });

  it("يتخلص من صورة الإيصال الجديدة عندما يعيد الخادم تحصيلاً منفذاً مسبقاً", async () => {
    const storage = await import("./storage");
    const upload = vi.spyOn(storage, "storagePut").mockResolvedValue({
      key: "payment-receipts/replayed-retry.png", url: "https://signed.example/retry.png",
    });
    const remove = vi.spyOn(storage, "storageRemove").mockResolvedValue();
    state.client.rpc = vi.fn(async (name: string, args: unknown) => {
      state.rpcCalls.push({ name, args });
      if (name === "powerhub_create_payment") return { data: [{ payment_id: 81, replayed: true }], error: null };
      return state.defaultRpc(name, args);
    });
    try {
      const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
      await expect(caller.payments.create({
        siteId: 10, subscriberId: 30, invoiceId: 70, paymentNo: "PAY-202608-0001",
        amount: 25, paymentMethod: "cash", companyAccountId: 90,
        receiptImageData: "aGVsbG8=", receiptImageMime: "image/png",
        clientOperationId: "55555555-5555-4555-8555-555555555555",
      })).resolves.toEqual({ id: 81, replayed: true });
      expect(upload).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("payment-receipts/replayed-retry.png");
    } finally {
      state.client.rpc = state.defaultRpc;
      upload.mockRestore();
      remove.mockRestore();
    }
  });

  it("does not upload a receipt until a collector session has been validated", async () => {
    const storage = await import("./storage");
    const upload = vi.spyOn(storage, "storagePut").mockResolvedValue({
      key: "payment-receipts/should-not-upload.png", url: "https://signed.example/unused.png",
    });
    const oldMembers = state.tables.tenant_members;
    const oldSessions = state.tables.collector_sessions;
    const oldUsers = state.tables.users;
    const oldProfiles = state.tables.staff_profiles;
    state.tables.users = [...oldUsers, {
      id: 2, role: "user", platform_role: null, account_status: "active", platformRole: null, accountStatus: "active",
      name: "محصّل الاختبار", email: "collector@example.test",
    }];
    state.tables.staff_profiles = [...oldProfiles, {
      id: 202, tenant_id: 20, site_id: 10, user_id: 2, role: "collector", permissions: null,
      custom_role_id: null, suspension_started_at: null, suspension_ends_at: null, is_active: true,
    }];
    state.tables.tenant_members = [{
      tenant_id: 20, user_id: 2, role: "collector", is_active: true, membership_status: "active",
    }];
    state.tables.collector_sessions = [];
    try {
      const caller = powerhubRouter.createCaller({ user: { id: 2, role: "user", platform_role: null, account_status: "active", platformRole: null, accountStatus: "active" } as never, req: {} as never, res: {} as never });
      await expect(caller.payments.create({
        siteId: 10, subscriberId: 30, invoiceId: 70, paymentNo: "PAY-202608-0002",
        amount: 25, paymentMethod: "cash", companyAccountId: 90,
        receiptImageData: "aGVsbG8=", receiptImageMime: "image/png",
      })).rejects.toThrow("افتح جلسة تحصيل قبل تسجيل دفعاتك الميدانية.");
      expect(upload).not.toHaveBeenCalled();
    } finally {
      state.tables.tenant_members = oldMembers;
      state.tables.collector_sessions = oldSessions;
      state.tables.users = oldUsers;
      state.tables.staff_profiles = oldProfiles;
      upload.mockRestore();
    }
  });

  it("removes the uploaded receipt when the payment RPC rejects the collection", async () => {
    const storage = await import("./storage");
    const upload = vi.spyOn(storage, "storagePut").mockResolvedValue({
      key: "payment-receipts/rejected-attempt.png", url: "https://signed.example/rejected.png",
    });
    const remove = vi.spyOn(storage, "storageRemove").mockResolvedValue();
    state.client.rpc = vi.fn(async (name: string, args: unknown) => {
      state.rpcCalls.push({ name, args });
      if (name === "powerhub_create_payment") return { data: null, error: { code: "P0001", message: "INVOICE_BALANCE_CONFLICT" } };
      return state.defaultRpc(name, args);
    });
    try {
      const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
      await expect(caller.payments.create({
        siteId: 10, subscriberId: 30, invoiceId: 70, paymentNo: "PAY-202608-0003",
        amount: 25, paymentMethod: "cash", companyAccountId: 90,
        receiptImageData: "aGVsbG8=", receiptImageMime: "image/png",
      })).rejects.toThrow("تغير رصيد الفاتورة أثناء المزامنة؛ راجع المسودة ثم أعد المحاولة.");
      expect(upload).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("payment-receipts/rejected-attempt.png");
    } finally {
      state.client.rpc = state.defaultRpc;
      upload.mockRestore();
      remove.mockRestore();
    }
  });


  it("يفلتر سجل المصروفات في Supabase بحسب الفترة والحساب والمستأجر والفرع", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    const originalExpenses = state.tables.expenses;
    state.tables.expenses = [
      { id: 80, tenant_id: 20, site_id: 10, company_account_id: 90, generator_id: null, category: "fuel", description: "ضمن النطاق", amount: 15, occurred_at: "2026-10-03T10:00:00.000Z", reference_no: null, created_by_user_id: 1, created_at: "2026-10-03T10:00:00.000Z" },
      { id: 82, tenant_id: 20, site_id: 10, company_account_id: 91, generator_id: null, category: "fuel", description: "حساب آخر", amount: 25, occurred_at: "2026-10-10T10:00:00.000Z", reference_no: null, created_by_user_id: 1, created_at: "2026-10-10T10:00:00.000Z" },
      { id: 83, tenant_id: 20, site_id: 10, company_account_id: 90, generator_id: null, category: "fuel", description: "بعد الفترة", amount: 35, occurred_at: "2026-10-13T10:00:00.000Z", reference_no: null, created_by_user_id: 1, created_at: "2026-10-13T10:00:00.000Z" },
      { id: 84, tenant_id: 99, site_id: 10, company_account_id: 90, generator_id: null, category: "fuel", description: "مستأجر آخر", amount: 45, occurred_at: "2026-10-05T10:00:00.000Z", reference_no: null, created_by_user_id: 1, created_at: "2026-10-05T10:00:00.000Z" },
      { id: 85, tenant_id: 20, site_id: 11, company_account_id: 90, generator_id: null, category: "fuel", description: "فرع آخر", amount: 55, occurred_at: "2026-10-05T10:00:00.000Z", reference_no: null, created_by_user_id: 1, created_at: "2026-10-05T10:00:00.000Z" },
    ];
    try {
      await expect(caller.expenses.page({ siteId: 10, limit: 100, startDate: "2026-10-03", endDate: "2026-10-12", companyAccountId: 90 })).resolves.toMatchObject({
        items: [expect.objectContaining({ id: 80, tenantId: 20, siteId: 10, companyAccountId: 90 })],
        hasNext: false,
      });
      await expect(caller.expenses.page({ siteId: 10, startDate: "2026-10-19", endDate: "2026-10-18" })).rejects.toThrow();
      await expect(caller.expenses.page({ siteId: 10, startDate: "2026-99-99", endDate: "2026-10-18" })).rejects.toThrow();
      await expect(caller.expenses.filterAccounts({ siteId: 10 })).resolves.toEqual([{ id: 90, name: "كاش", accountType: "cash" }]);
      const filterAccounts = await caller.expenses.filterAccounts({ siteId: 10 });
      expect(filterAccounts[0]).not.toHaveProperty("balance");
      expect(filterAccounts[0]).not.toHaveProperty("transactions");
    } finally {
      state.tables.expenses = originalExpenses;
    }
  });

  it("يسجل المصروف عبر Supabase مع حارس الفترة المالية", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.expenses.create({ siteId: 10, companyAccountId: 90, category: "fuel", description: "وقود التشغيل", amount: 50, referenceNo: "EXP-1" })).resolves.toEqual({ id: 82, transactionId: 118 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_create_expense_with_account", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_company_account_id: 90, p_category: "fuel", p_amount: 50 }) })]);
  });

  it("ينشئ تسوية مالية بالدالة الذرية في Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.settlements.create({ siteId: 10, periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-08-31T23:59:59.999Z", totalCollected: 100, totalExpenses: 20, actualCash: 75, notes: "تسوية دورية" })).resolves.toEqual({ id: 97 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_create_financial_settlement", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_total_collected: 100, p_total_expenses: 20, p_actual_cash: 75 }) })]);
  });

  it("يغيّر حالة التسوية بالدالة الذرية في Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.settlements.setStatus({ siteId: 10, settlementId: 97, status: "approved" })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_set_financial_settlement_status", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_settlement_id: 97, p_status: "approved" }) })]);
  });

  it("يعرض قائمة التسويات من Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.settlements.list({ siteId: 10, branchId: 10 })).resolves.toMatchObject([{ id: 97, siteId: 10, totalCollected: "100", totalExpenses: "20", bookProfit: "80", status: "draft" }]);
  });

  it("ينفذ التصحيح الاستثنائي المقفل عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.settlements.exceptionalEdit({ siteId: 10, entityType: "expense", entityId: 82, reason: "تصحيح مرجعي موثق للمصروف", changes: { description: "وصف مصحح" } })).resolves.toMatchObject({ success: true, before: { description: "وصف سابق" }, after: { description: "وصف مصحح" } });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_exceptional_locked_edit", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_entity_type: "expense", p_entity_id: 82 }) })]);
  });

  it("يمنع حسابات الشركة من تجاوز نطاق الفرع للحساب المعيّن على فرع واحد", async () => {
    const branchTwo = { id: 11, tenant_id: 20, name: "الفرع الثاني", code: "BR2", city: "غزة", address: null, status: "active", anomaly_alert_percent: 50, invoice_due_days: 14, created_at: "2026-08-01T00:00:00.000Z" };
    state.tables.sites = [state.tables.sites[0], branchTwo];
    state.tables.users = [{ id: 2, role: "user", platform_role: "platform_user", account_status: "active" }];
    state.tables.tenant_members = [{ tenant_id: 20, user_id: 2, role: "manager", is_active: true, membership_status: "active" }];
    state.tables.staff_profiles = [{ tenant_id: 20, site_id: 10, user_id: 2, is_active: true, role: "manager", permissions: null, custom_role_id: null, suspension_started_at: null, suspension_ends_at: null }];
    state.tables.company_accounts = [
      state.tables.company_accounts[0],
      { id: 92, tenant_id: 20, name: "جوال بي 2", account_type: "jawwal_pay", phone_number: null, color: "#16a34a", opening_balance: 50, is_active: true, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" },
    ];
    state.tables.company_account_sites = [{ account_id: 90, site_id: 10 }, { account_id: 92, site_id: 11 }];
    state.tables.account_transactions = [];
    const caller = powerhubRouter.createCaller({ user: { id: 2, role: "user" } as never, req: {} as never, res: {} as never });

    await expect(caller.companyAccounts.list({ siteId: 10 })).resolves.toMatchObject([{ id: 90 }]);
    await expect(caller.companyAccounts.list({ siteId: 10, branchId: 11 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.companyAccounts.create({ siteId: 10, name: "حساب فرع 2", accountType: "cash", phoneNumber: "+970595123457", openingBalance: 0, siteIds: [11] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.companyAccounts.updateSites({ siteId: 10, accountId: 92, siteIds: [10] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.companyAccounts.transfer({ siteId: 10, fromAccountId: 90, toAccountId: 92, amount: 5, description: "تحويل خارج النطاق" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpcCalls).toEqual([{
      name: "powerhub_company_account_balance_rollup",
      args: { p_tenant_id: 20, p_account_ids: [90, 92] },
    }]);
  });

  it("ينشئ حساب الشركة وحركاته وتحويله عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.companyAccounts.create({ siteId: 10, name: "جوال بي 1", accountType: "jawwal_pay", phoneNumber: "+970595123456", openingBalance: 5, siteIds: [10] })).resolves.toEqual({ id: 92 });
    await expect(caller.companyAccounts.addMovement({ siteId: 10, accountId: 90, transactionType: "deposit", amount: 10, description: "إيداع" })).resolves.toEqual({ id: 93 });
    await expect(caller.companyAccounts.transfer({ siteId: 10, fromAccountId: 90, toAccountId: 92, amount: 5, description: "تحويل داخلي" })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual([
      expect.objectContaining({ name: "powerhub_create_company_account", args: expect.objectContaining({ p_tenant_id: 20, p_site_ids: [10] }) }),
      expect.objectContaining({ name: "powerhub_add_account_movement", args: expect.objectContaining({ p_account_id: 90, p_transaction_type: "deposit", p_amount: 10 }) }),
      expect.objectContaining({ name: "powerhub_transfer_company_accounts", args: expect.objectContaining({ p_from_account_id: 90, p_to_account_id: 92, p_amount: 5 }) }),
    ]);
  });

  it("يحدّث إعدادات حساب الشركة عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.companyAccounts.updatePhone({ siteId: 10, accountId: 92, phoneNumber: "+970599000001" })).resolves.toEqual({ success: true });
    await expect(caller.companyAccounts.updateOpeningBalance({ siteId: 10, accountId: 92, openingBalance: 100 })).resolves.toEqual({ success: true });
    await expect(caller.companyAccounts.updateSites({ siteId: 10, accountId: 92, siteIds: [10] })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "powerhub_update_company_account_phone", args: expect.objectContaining({ p_tenant_id: 20, p_account_id: 92 }) }),
      expect.objectContaining({ name: "powerhub_update_company_account_opening_balance", args: expect.objectContaining({ p_opening_balance: 100 }) }),
      expect.objectContaining({ name: "powerhub_update_company_account_sites", args: expect.objectContaining({ p_site_ids: [10] }) }),
    ]));
  });

  it("يعرض ويغلق جلسة التحصيل عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.collectorSessions.list({ siteId: 10 })).resolves.toMatchObject([{ session: { id: 96, openedAt: expect.any(Date) }, collector: { id: 1 } }]);
    await expect(caller.collectorSessions.close({ siteId: 10, sessionId: 96, declaredCash: 10 })).resolves.toEqual({ expectedCash: 10, varianceAmount: 0 });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([expect.objectContaining({ name: "powerhub_close_collector_session", args: expect.objectContaining({ p_session_id: 96, p_allow_foreign_close: true }) })]));
  });

  it("ينشئ موظفاً عبر RPC Supabase الذرية دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.hr.createEmployee({
      siteId: 10, fullName: "فني جديد", identityNo: "123456789", phone: "0595000001", jobTitle: "technician",
      employmentStatus: "active", contractType: "monthly", baseWage: 1200, hireDate: "2026-08-15", notes: "تغطية ميدانية",
    })).resolves.toEqual({ id: 125 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_create_employee",
      args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_full_name: "فني جديد", p_job_title: "technician", p_base_wage: 1200 }),
    })]);
  });

  it("يعدّل موظفاً عبر RPC Supabase الذرية دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.hr.updateEmployee({ siteId: 10, employeeId: 120, fullName: "محاسب محدث", baseWage: 1300, phone: null }))
      .resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_update_employee",
      args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_employee_id: 120, p_patch: { fullName: "محاسب محدث", baseWage: 1300, phone: null } }),
    })]);
  });

  it("يرفض السلفة اليدوية ويبقي الخصم العادي على مساره الذري", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.hr.createAdjustment({ siteId: 10, employeeId: 120, adjustmentType: "advance", amount: 250, reason: "سلفة تشغيلية موثقة" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.rpcCalls).toEqual([]);
    await expect(caller.hr.createAdjustment({ siteId: 10, employeeId: 120, adjustmentType: "deduction", amount: 25, reason: "خصم إداري موثق" }))
      .resolves.toEqual({ id: 125 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_create_employee_adjustment",
      args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_employee_id: 120, p_adjustment_type: "deduction", p_amount: 25 }),
    })]);
  });

  it("يصرف السلفة من حساب الشركة عبر RPC المخصص مع مفتاح العملية", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.hr.issueEmployeeAdvance({
      siteId: 10, employeeId: 120, advanceKind: "salary_advance", amount: 250, accountId: 90,
      paymentDate: "2026-08-10", reason: "سلفة قبل موعد الراتب", operationKey: "550e8400-e29b-41d4-a716-446655440000",
    })).resolves.toMatchObject({ id: 130, accountTransactionId: 131, remainingAmount: 250, replayed: false });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_issue_employee_advance",
      args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_employee_id: 120, p_advance_kind: "salary_advance", p_amount: 250, p_account_id: 90, p_payment_date: "2026-08-10" }),
    })]);
  });

  it("يسجل السداد الجزئي عبر RPC المخصص دون تكرار الحركة المالية", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.hr.repayEmployeeAdvance({
      siteId: 10, adjustmentId: 121, accountId: 90, amount: 25, paymentDate: "2026-08-12",
      notes: "سداد جزئي", operationKey: "550e8400-e29b-41d4-a716-446655440001",
    })).resolves.toMatchObject({ id: 132, adjustmentId: 121, remainingAmount: 75, accountTransactionId: 133, replayed: false });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_repay_employee_advance",
      args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_adjustment_id: 121, p_account_id: 90, p_amount: 25, p_payment_date: "2026-08-12" }),
    })]);
  });

  it("ينشئ مسودة رواتب عبر RPC Supabase الذرية دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.hr.createPayrollDraft({
      siteId: 10, period: "2026-09", items: [{ employeeId: 120, extraAmount: 100, advanceDeduction: 0, otherDeduction: 0, notes: "مكافأة تشغيل" }],
    })).resolves.toEqual({ id: 126, totalNet: 1100 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_create_payroll_draft",
      args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_period: "2026-09", p_items: [{ employee_id: 120, extra_amount: 100, advance_deduction: 0, other_deduction: 0, notes: "مكافأة تشغيل" }] }),
    })]);
  });

  it("يعتمد كشف الرواتب عبر RPC Supabase الذرية دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.hr.approvePayroll({ siteId: 10, payrollRunId: 122 })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_approve_payroll",
      args: { p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_payroll_run_id: 122 },
    })]);
  });

  it("يصرف كشف الرواتب عبر RPC Supabase الذرية دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.hr.payPayroll({ siteId: 10, payrollRunId: 122, accountId: 90 })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_pay_payroll",
      args: { p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_payroll_run_id: 122, p_account_id: 90 },
    })]);
  });

  it("ينفذ الاعتماد الجماعي عبر مسار Supabase الذري لكل قراءة مؤهلة", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.mobileSync.approveAllAndIssue({ siteId: 10, limit: 10, sendNow: false }))
      .resolves.toMatchObject({ requested: 1, succeeded: 1, failed: 0, replayed: 0 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_approve_and_issue_mobile_reading",
      args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_reading_id: 60, p_base_version: 1 }),
    })]);
  });

  it("ينشئ طلب ترقية الباقة عبر RPC Supabase الذرية دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscription.requestUpgrade({ siteId: 10, requestedPackageCode: "professional" })).resolves.toEqual({ id: 127, requestedPackageCode: "professional", alreadyRequested: false });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_request_subscription_upgrade",
      args: { p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_requested_package_code: "professional" },
    })]);
  });

  it("يحسب رصيد حساب الشركة من سجل الحركات الكامل لا من أول ألف حركة فقط", async () => {
    state.tables.company_accounts = [{
      id: 90, tenant_id: 20, name: "كاش", account_type: "cash", phone_number: null, color: "#64748b",
      opening_balance: 100, is_active: true, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
    }];
    state.tables.company_account_sites = [{ account_id: 90, site_id: 10 }];
    state.tables.account_transactions = Array.from({ length: 1005 }, (_, index) => ({
      id: index + 1, tenant_id: 20, account_id: 90, transaction_type: "collection", amount: 1,
      description: "تحصيل", reference_no: String(index + 1), related_payment_id: null, related_account_id: null,
      created_by_user_id: 1, occurred_at: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
      created_at: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    }));
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });

    const accounts = await caller.companyAccounts.list({ siteId: 10 });
    expect(accounts[0]).toMatchObject({ id: 90, balance: 1105 });
    expect(accounts[0].transactions).toHaveLength(1000);
    expect(state.rpcCalls).toContainEqual({
      name: "powerhub_company_account_balance_rollup",
      args: { p_tenant_id: 20, p_account_ids: [90] },
    });
  });

  it("loads and saves the authoritative invoice due interval in hours from Settings", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.sites.invoiceDuePolicy.get({ siteId: 10 }))
      .resolves.toEqual({ invoiceDueHours: 336, invoiceDueDays: 14 });
    await expect(caller.sites.invoiceDuePolicy.save({ siteId: 10, invoiceDueHours: 18 }))
      .resolves.toEqual({ success: true, invoiceDueHours: 18, invoiceDueDays: 1 });
    expect(state.rpcCalls).toContainEqual(expect.objectContaining({
      name: "powerhub_save_site_invoice_due_hours",
      args: { p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_invoice_due_hours: 18 },
    }));
    expect(state.rpcCalls.some((call) => call.name === "powerhub_update_site")).toBe(false);
  });

  it("يعرض حصة المشتركين من Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.quota({ siteId: 10 })).resolves.toEqual({ limit: 500, currentCount: 0, remaining: 500, plan: "professional" });
  });

  it("يعود لمسار قراءة الحصة المتوافق إذا لم تُطبّق ترحيلة RPC بعد", async () => {
    state.client.rpc = vi.fn(async (name: string, args: unknown) => {
      state.rpcCalls.push({ name, args });
      if (name === "powerhub_subscriber_quota_summary") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.powerhub_subscriber_quota_summary in the schema cache" } };
      }
      return state.defaultRpc(name, args);
    });
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.quota({ siteId: 10 })).resolves.toMatchObject({ limit: 1000, currentCount: 0, remaining: 1000, plan: "professional" });
    expect(state.rpcCalls.map((call) => call.name)).toContain("powerhub_effective_tenant_quota");
  });

  it("يحفظ الاستيراد الجماعي عبر RPC Supabase الذرية دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.bulkImport({ siteId: 10, updateExisting: false, rows: [{ sourceRow: 2, subscriberNo: "MAIN-NEW", fullName: "مشترك اختبار", phone: "+970595000111", subscriptionType: "residential" }] }))
      .resolves.toMatchObject({ created: [{ subscriberNo: expect.anything() }], updated: [], failed: [], notificationsQueued: 0 });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([expect.objectContaining({ name: "powerhub_bulk_upsert_subscribers", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_update_existing: false, p_quota_limit: 500 }) })]));
    expect(state.inserts.filter((entry) => entry.table === "subscribers")).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("يراجع أرقام المشتركين من Supabase دون MySQL", async () => {
    state.tables.subscribers = [{ ...state.tables.subscribers[0] as object, phone: "00970595000000" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.phoneReview({ siteId: 10 })).resolves.toMatchObject([{ id: 30, subscriberNo: "MAIN-001", status: "ready", normalizedPhone: "+970595000000" }]);
  });

  it("يوحّد أرقام المشتركين عبر RPC Supabase الذرية دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.applyPhoneNormalization({ siteId: 10, subscriberIds: [30] })).resolves.toEqual({ updated: 1, skipped: 0 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({
      name: "powerhub_normalize_subscriber_phones",
      args: { p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_subscriber_ids: [30] },
    })]);
  });

  it("ينشئ ويقرأ رابط مشاركة فاتورة عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    const shared = await caller.invoices.createShareLink({ siteId: 10, invoiceId: 70 });
    expect(shared.path).toMatch(/^\/invoice\/.+/);
    const result = await caller.invoices.publicByToken({ token: shared.token });
    expect(result).toMatchObject({
      siteId: 10, companyName: "شركة المولد", companyLogoUrl: null, paymentDocumentationAvailable: true,
      invoice: { id: 70, invoiceNo: "MAIN-202608-0001" },
      subscriber: { fullName: "مشترك الاختبار", subscriberNo: "MAIN-001" },
      lines: [{ description: "استهلاك كهرباء" }],
    });
    expect(state.rpcCalls.map((call) => call.name)).toEqual([
      "powerhub_create_invoice_share_link",
      "powerhub_get_shared_invoice_by_token_hash",
      "powerhub_payment_documentation_access",
      "powerhub_subscriber_portal_logo_access",
    ]);
  });

  it("يعتمد القراءة الميدانية ويصدر الفاتورة عبر RPC الذري دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.mobileSync.approveAndIssue({ siteId: 10, readingId: 60, baseVersion: 1, sendNow: false }))
      .resolves.toMatchObject({ id: 71, invoiceNo: "PH-MAIN-202608-00002", totalAmount: 150, notificationMode: "deferred" });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "powerhub_approve_and_issue_mobile_reading",
        args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_reading_id: 60, p_base_version: 1, p_billing_period: "2026-08" }),
      }),
    ]));
  });

  it("يحدّث هوية التقارير عبر RPC Supabase الذرية دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin", platform_role: "platform_admin", account_status: "active", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.reportBranding.update({ siteId: 10, companyName: "شركة الاختبار" })).resolves.toMatchObject({ companyName: "شركة الاختبار", reportLogoKey: null, logoUrl: null });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_update_report_branding", args: { p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_company_name: "شركة الاختبار", p_report_logo_key: null } })]);
  });
});
