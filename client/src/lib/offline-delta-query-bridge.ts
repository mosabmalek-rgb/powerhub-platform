import type { DeltaChange, DeltaEntityType, DeltaPage, DeltaCursorScope } from "./offline-delta-sync";

export type DeltaOperationalEntity = DeltaEntityType;
type Row = Record<string, unknown>;

function toNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}
function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}
function dateOrNow(value: unknown): Date {
  return dateOrNull(value) ?? new Date(0);
}
function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function isRow(value: unknown): value is Row {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeDeltaEntityRow(entityType: DeltaOperationalEntity, raw: Row): Row {
  if (entityType === "fuel_events") {
    const id = toNumber(raw.event_id ?? raw.id);
    return {
      ...raw, id, event_id: id,
      tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
      siteId: toNumber(raw.site_id ?? raw.siteId),
      generator_id: toNumber(raw.generator_id ?? raw.generatorId),
      generator_name: String(raw.generator_name ?? raw.generatorName ?? ""),
      fuel_item_id: toNumber(raw.fuel_item_id ?? raw.fuelItemId),
      fuel_item_name: String(raw.fuel_item_name ?? raw.fuelItemName ?? ""),
      source_warehouse_id: toNumber(raw.source_warehouse_id ?? raw.sourceWarehouseId),
      source_warehouse_name: String(raw.source_warehouse_name ?? raw.sourceWarehouseName ?? ""),
      destination_warehouse_id: toNumber(raw.destination_warehouse_id ?? raw.destinationWarehouseId),
      destination_warehouse_name: String(raw.destination_warehouse_name ?? raw.destinationWarehouseName ?? ""),
      litres: String(raw.litres ?? 0),
      occurred_at: dateOrNow(raw.occurred_at ?? raw.occurredAt).toISOString(),
      level_before_liters: optionalNumber(raw.level_before_liters ?? raw.levelBeforeLiters),
      level_after_liters: optionalNumber(raw.level_after_liters ?? raw.levelAfterLiters),
      operating_hours: optionalNumber(raw.operating_hours ?? raw.operatingHours),
      reference_no: (raw.reference_no ?? raw.referenceNo ?? null) as string | null,
      notes: null,
      stock_transfer_id: toNumber(raw.stock_transfer_id ?? raw.stockTransferId),
      created_by_user_id: null,
      created_at: dateOrNow(raw.created_at ?? raw.createdAt).toISOString(),
    };
  }
  if (entityType === "maintenance_work_orders") {
    const id = toNumber(raw.work_order_id ?? raw.id);
    return {
      ...raw, id, work_order_id: id,
      tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
      siteId: toNumber(raw.site_id ?? raw.siteId),
      work_order_number: String(raw.work_order_number ?? raw.workOrderNumber ?? ""),
      generator_id: toNumber(raw.generator_id ?? raw.generatorId),
      generator_name: String(raw.generator_name ?? raw.generatorName ?? ""),
      preventive_plan_id: optionalNumber(raw.preventive_plan_id ?? raw.preventivePlanId),
      order_type: String(raw.order_type ?? raw.orderType ?? "other"),
      priority: String(raw.priority ?? "normal"),
      status: String(raw.status ?? "new"),
      title: String(raw.title ?? ""),
      description: (raw.description ?? null) as string | null,
      work_summary: (raw.work_summary ?? raw.workSummary ?? null) as string | null,
      reported_at: dateOrNow(raw.reported_at ?? raw.reportedAt).toISOString(),
      scheduled_for: (raw.scheduled_for ?? raw.scheduledFor ?? null) as string | null,
      started_at: (raw.started_at ?? raw.startedAt ?? null) as string | null,
      completed_at: (raw.completed_at ?? raw.completedAt ?? null) as string | null,
      assigned_to_user_id: optionalNumber(raw.assigned_to_user_id ?? raw.assignedToUserId),
      assigned_supplier_id: optionalNumber(raw.assigned_supplier_id ?? raw.assignedSupplierId),
      assigned_supplier_name: (raw.assigned_supplier_name ?? raw.assignedSupplierName ?? null) as string | null,
      assigned_supplier_code: (raw.assigned_supplier_code ?? raw.assignedSupplierCode ?? null) as string | null,
      operating_hours_at_open: optionalNumber(raw.operating_hours_at_open ?? raw.operatingHoursAtOpen),
      operating_hours_at_close: optionalNumber(raw.operating_hours_at_close ?? raw.operatingHoursAtClose),
      downtime_minutes: toNumber(raw.downtime_minutes ?? raw.downtimeMinutes),
      labor_cost: String(raw.labor_cost ?? raw.laborCost ?? 0),
      external_service_cost: String(raw.external_service_cost ?? raw.externalServiceCost ?? 0),
      parts_cost: String(raw.parts_cost ?? raw.partsCost ?? 0),
      total_cost_amount: String(raw.total_cost_amount ?? raw.totalCostAmount ?? 0),
      created_by_user_id: null,
    };
  }
  if (entityType.startsWith("maintenance_work_order_parts:")) {
    const id = toNumber(raw.part_id ?? raw.id);
    return {
      ...raw, id, part_id: id,
      tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
      siteId: toNumber(raw.site_id ?? raw.siteId),
      work_order_id: toNumber(raw.work_order_id ?? raw.workOrderId),
      generator_id: toNumber(raw.generator_id ?? raw.generatorId),
      item_id: toNumber(raw.item_id ?? raw.itemId),
      item_name: String(raw.item_name ?? raw.itemName ?? ""),
      category: String(raw.category ?? "other"),
      warehouse_id: toNumber(raw.warehouse_id ?? raw.warehouseId),
      warehouse_name: String(raw.warehouse_name ?? raw.warehouseName ?? ""),
      quantity: String(raw.quantity ?? 0),
      unit_cost: String(raw.unit_cost ?? raw.unitCost ?? 0),
      total_cost_amount: String(raw.total_cost_amount ?? raw.totalCostAmount ?? 0),
      stock_movement_id: toNumber(raw.stock_movement_id ?? raw.stockMovementId),
      issued_at: dateOrNow(raw.issued_at ?? raw.issuedAt).toISOString(),
      notes: null,
    };
  }
  switch (entityType) {
    case "sites": {
      const invoiceDueDays = optionalNumber(raw.invoice_due_days ?? raw.invoiceDueDays) ?? 14;
      const invoiceDueHours = optionalNumber(raw.invoice_due_hours ?? raw.invoiceDueHours) ??
        Math.max(1, Math.min(2160, invoiceDueDays * 24));
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        tenantName: String(raw.tenant_name ?? raw.tenantName ?? raw.name ?? ""),
        name: String(raw.name ?? ""),
        code: String(raw.code ?? ""),
        city: (raw.city ?? null) as string | null,
        address: (raw.address ?? null) as string | null,
        status: String(raw.status ?? "active"),
        anomalyAlertPercent: optionalNumber(raw.anomaly_alert_percent ?? raw.anomalyAlertPercent),
        invoiceDueDays,
        invoiceDueHours,
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
      };
    }
    case "subscribers":
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        subscriberNo: String(raw.subscriber_no ?? raw.subscriberNo ?? ""),
        clientOperationId: (raw.client_operation_id ?? raw.clientOperationId ?? null) as string | null,
        fullName: String(raw.full_name ?? raw.fullName ?? ""),
        phone: String(raw.phone ?? ""),
        whatsappNumber: (raw.whatsapp_number ?? raw.whatsappNumber ?? null) as string | null,
        address: (raw.address ?? null) as string | null,
        subscriptionType: String(raw.subscription_type ?? raw.subscriptionType ?? "residential"),
        serviceStatus: String(raw.service_status ?? raw.serviceStatus ?? "active"),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
        updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
      };
    case "generators":
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        code: String(raw.code ?? ""),
        name: String(raw.name ?? ""),
        serialNumber: (raw.serial_number ?? raw.serialNumber ?? null) as string | null,
        ratedCapacityKw: raw.rated_capacity_kw == null && raw.ratedCapacityKw == null
          ? null : String(raw.rated_capacity_kw ?? raw.ratedCapacityKw),
        fuelType: String(raw.fuel_type ?? raw.fuelType ?? "other"),
        fuelLevelLiters: String(raw.fuel_level_liters ?? raw.fuelLevelLiters ?? 0),
        operatingHours: String(raw.operating_hours ?? raw.operatingHours ?? 0),
        status: String(raw.status ?? "active"),
        lastMaintenanceAt: dateOrNull(raw.last_maintenance_at ?? raw.lastMaintenanceAt),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
        updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
      };
    case "readings":
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        ...(raw.site_id !== undefined || raw.siteId !== undefined ? { siteId: optionalNumber(raw.site_id ?? raw.siteId) } : {}),
        subscriberId: toNumber(raw.subscriber_id ?? raw.subscriberId),
        clientOperationId: (raw.client_operation_id ?? raw.clientOperationId ?? null) as string | null,
        readingAt: dateOrNow(raw.reading_at ?? raw.readingAt),
        readingValue: String(raw.reading_value ?? raw.readingValue ?? 0),
        previousReadingValue: raw.previous_reading_value == null && raw.previousReadingValue == null
          ? null : String(raw.previous_reading_value ?? raw.previousReadingValue),
        consumptionKwh: raw.consumption_kwh == null && raw.consumptionKwh == null
          ? null : String(raw.consumption_kwh ?? raw.consumptionKwh),
        captureMethod: String(raw.capture_method ?? raw.captureMethod ?? "manual"),
        imageKey: (raw.image_key ?? raw.imageKey ?? null) as string | null,
        imageHash: (raw.image_hash ?? raw.imageHash ?? null) as string | null,
        status: String(raw.status ?? "pending"),
        enteredByUserId: optionalNumber(raw.entered_by_user_id ?? raw.enteredByUserId),
        reviewedByUserId: optionalNumber(raw.reviewed_by_user_id ?? raw.reviewedByUserId),
        reviewedAt: dateOrNull(raw.reviewed_at ?? raw.reviewedAt),
        notes: (raw.notes ?? null) as string | null,
        versionNo: toNumber(raw.version_no ?? raw.versionNo),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
        updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
      };
    case "expenses": {
      return {
        id: toNumber(raw.id), tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId), generatorId: optionalNumber(raw.generator_id ?? raw.generatorId),
        companyAccountId: optionalNumber(raw.company_account_id ?? raw.companyAccountId),
        category: String(raw.category ?? "other"), description: String(raw.description ?? ""),
        amount: String(raw.amount ?? 0), occurredAt: dateOrNow(raw.occurred_at ?? raw.occurredAt),
        referenceNo: (raw.reference_no ?? raw.referenceNo ?? null) as string | null,
        createdByUserId: optionalNumber(raw.created_by_user_id ?? raw.createdByUserId),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
      };
    }
    case "payments": {
      const rawPayment = isRow(raw.payment) ? raw.payment : raw;
      const payment = {
        id: toNumber(rawPayment.id), tenantId: toNumber(rawPayment.tenant_id ?? rawPayment.tenantId),
        siteId: toNumber(rawPayment.site_id ?? rawPayment.siteId),
        subscriberId: toNumber(rawPayment.subscriber_id ?? rawPayment.subscriberId),
        invoiceId: optionalNumber(rawPayment.invoice_id ?? rawPayment.invoiceId),
        paymentNo: String(rawPayment.payment_no ?? rawPayment.paymentNo ?? ""),
        clientOperationId: (rawPayment.client_operation_id ?? rawPayment.clientOperationId ?? null) as string | null,
        amount: String(rawPayment.amount ?? 0), paymentMethod: String(rawPayment.payment_method ?? rawPayment.paymentMethod ?? "cash"),
        transferFromAccount: (rawPayment.transfer_from_account ?? rawPayment.transferFromAccount ?? null) as string | null,
        transferFromType: (rawPayment.transfer_from_type ?? rawPayment.transferFromType ?? null) as string | null,
        transferToAccount: (rawPayment.transfer_to_account ?? rawPayment.transferToAccount ?? null) as string | null,
        transferToType: (rawPayment.transfer_to_type ?? rawPayment.transferToType ?? null) as string | null,
        referenceNo: (rawPayment.reference_no ?? rawPayment.referenceNo ?? null) as string | null,
        hasReceiptImage: Boolean(rawPayment.has_receipt_image ?? rawPayment.hasReceiptImage),
        status: String(rawPayment.status ?? "completed"),
        collectedByUserId: optionalNumber(rawPayment.collected_by_user_id ?? rawPayment.collectedByUserId),
        collectorSessionId: optionalNumber(rawPayment.collector_session_id ?? rawPayment.collectorSessionId),
        paidAt: dateOrNow(rawPayment.paid_at ?? rawPayment.paidAt),
        createdAt: dateOrNow(rawPayment.created_at ?? rawPayment.createdAt), receiptImageUrl: null,
      };
      const rawSubscriber = isRow(raw.subscriber) ? raw.subscriber : null;
      return {
        id: toNumber(raw.id ?? rawPayment.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId ?? rawPayment.tenant_id ?? rawPayment.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId ?? rawPayment.site_id ?? rawPayment.siteId),
        payment, subscriber: rawSubscriber ? normalizeDeltaEntityRow("subscribers", rawSubscriber) : null,
        invoiceNo: (raw.invoice_no ?? raw.invoiceNo ?? null) as string | null,
      };
    }
    case "invoices":
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        subscriberId: toNumber(raw.subscriber_id ?? raw.subscriberId),
        readingId: optionalNumber(raw.reading_id ?? raw.readingId),
        tariffId: optionalNumber(raw.tariff_id ?? raw.tariffId),
        invoiceNo: String(raw.invoice_no ?? raw.invoiceNo ?? ""),
        clientOperationId: (raw.client_operation_id ?? raw.clientOperationId ?? null) as string | null,
        billingPeriod: String(raw.billing_period ?? raw.billingPeriod ?? ""),
        issueDate: dateOrNow(raw.issue_date ?? raw.issueDate),
        dueDate: dateOrNow(raw.due_date ?? raw.dueDate),
        previousReading: raw.previous_reading == null && raw.previousReading == null ? null : String(raw.previous_reading ?? raw.previousReading),
        currentReading: raw.current_reading == null && raw.currentReading == null ? null : String(raw.current_reading ?? raw.currentReading),
        consumptionKwh: String(raw.consumption_kwh ?? raw.consumptionKwh ?? 0),
        pricePerKwh: String(raw.price_per_kwh ?? raw.pricePerKwh ?? 0),
        fixedFee: String(raw.fixed_fee ?? raw.fixedFee ?? 0),
        taxAmount: String(raw.tax_amount ?? raw.taxAmount ?? 0),
        discountAmount: String(raw.discount_amount ?? raw.discountAmount ?? 0),
        totalAmount: String(raw.total_amount ?? raw.totalAmount ?? 0),
        paidAmount: String(raw.paid_amount ?? raw.paidAmount ?? 0),
        balanceDue: String(raw.balance_due ?? raw.balanceDue ?? 0),
        status: String(raw.status ?? "draft"),
        cycleKey: (raw.cycle_key ?? raw.cycleKey ?? null) as string | null,
        cycleStartAt: dateOrNull(raw.cycle_start_at ?? raw.cycleStartAt),
        cycleEndAt: dateOrNull(raw.cycle_end_at ?? raw.cycleEndAt),
        createdByUserId: optionalNumber(raw.created_by_user_id ?? raw.createdByUserId),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
        updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
      };
    case "company_accounts":
    case "company_accounts_all": {
      const rawLinkedSites = raw.linked_sites ?? raw.linkedSites;
      const linkedSites: unknown[] = Array.isArray(rawLinkedSites) ? rawLinkedSites : [];
      const rawTransactions = raw.transactions;
      const transactions = Array.isArray(rawTransactions) ? rawTransactions.filter(isRow).map((tx) => ({
        id: toNumber(tx.id),
        tenantId: toNumber(tx.tenant_id ?? tx.tenantId),
        accountId: toNumber(tx.account_id ?? tx.accountId),
        transactionType: String(tx.transaction_type ?? tx.transactionType ?? ""),
        amount: String(tx.amount ?? 0),
        description: (tx.description ?? null) as string | null,
        referenceNo: (tx.reference_no ?? tx.referenceNo ?? null) as string | null,
        relatedPaymentId: optionalNumber(tx.related_payment_id ?? tx.relatedPaymentId),
        relatedAccountId: optionalNumber(tx.related_account_id ?? tx.relatedAccountId),
        createdByUserId: optionalNumber(tx.created_by_user_id ?? tx.createdByUserId),
        occurredAt: dateOrNow(tx.occurred_at ?? tx.occurredAt),
        createdAt: dateOrNow(tx.created_at ?? tx.createdAt),
      })) : [];
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: optionalNumber(raw.site_id ?? raw.siteId),
        name: String(raw.name ?? ""),
        accountType: String(raw.account_type ?? raw.accountType ?? "other"),
        phoneNumber: (raw.phone_number ?? raw.phoneNumber ?? null) as string | null,
        color: (raw.color ?? null) as string | null,
        openingBalance: String(raw.opening_balance ?? raw.openingBalance ?? 0),
        balance: String(raw.balance ?? 0),
        isActive: Boolean(raw.is_active ?? raw.isActive),
        allowPaymentDocumentation: Boolean(raw.allow_payment_documentation ?? raw.allowPaymentDocumentation),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
        updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
        linkedSites: linkedSites.filter(isRow).map((site) => ({
          accountId: toNumber(site.account_id ?? site.accountId),
          siteId: toNumber(site.site_id ?? site.siteId),
          siteName: String(site.site_name ?? site.siteName ?? ""),
        })),
        transactions,
      };
    }
    case "tariffs":
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        name: String(raw.name ?? ""),
        code: String(raw.code ?? ""),
        pricePerKwh: String(raw.price_per_kwh ?? raw.pricePerKwh ?? 0),
        fixedFee: String(raw.fixed_fee ?? raw.fixedFee ?? 0),
        taxRate: String(raw.tax_rate ?? raw.taxRate ?? 0),
        isActive: Boolean(raw.is_active ?? raw.isActive),
        effectiveFrom: dateOrNow(raw.effective_from ?? raw.effectiveFrom),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
      };
    case "inventory_items":
      return {
        id: toNumber(raw.id), tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        sku: (raw.sku ?? null) as string | null, name: String(raw.name ?? ""),
        category: String(raw.category ?? "other"), base_unit: String(raw.base_unit ?? raw.baseUnit ?? ""),
        baseUnit: String(raw.base_unit ?? raw.baseUnit ?? ""),
        reorder_point: String(raw.reorder_point ?? raw.reorderPoint ?? 0),
        reorderPoint: String(raw.reorder_point ?? raw.reorderPoint ?? 0),
        specification: (raw.specification ?? null) as string | null,
        notes: (raw.notes ?? null) as string | null,
        is_active: Boolean(raw.is_active ?? raw.isActive), isActive: Boolean(raw.is_active ?? raw.isActive),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt), updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
      };
    case "inventory_item_units":
      return {
        id: toNumber(raw.id), tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        itemId: toNumber(raw.item_id ?? raw.itemId), unit_label: String(raw.unit_label ?? raw.unitLabel ?? ""),
        unitLabel: String(raw.unit_label ?? raw.unitLabel ?? ""),
        factor_to_base: String(raw.factor_to_base ?? raw.factorToBase ?? 1),
        factorToBase: String(raw.factor_to_base ?? raw.factorToBase ?? 1),
        is_active: Boolean(raw.is_active ?? raw.isActive), isActive: Boolean(raw.is_active ?? raw.isActive),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt), updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
      };
    case "suppliers":
      return {
        id: toNumber(raw.id), tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        supplier_code: (raw.supplier_code ?? raw.supplierCode ?? null) as string | null,
        supplierCode: (raw.supplier_code ?? raw.supplierCode ?? null) as string | null,
        name: String(raw.name ?? ""), contact_name: (raw.contact_name ?? raw.contactName ?? null) as string | null, contactName: (raw.contact_name ?? raw.contactName ?? null) as string | null,
        phone: (raw.phone ?? null) as string | null, email: (raw.email ?? null) as string | null,
        address: (raw.address ?? null) as string | null, taxNumber: (raw.tax_number ?? raw.taxNumber ?? null) as string | null,
        default_payment_terms_days: toNumber(raw.default_payment_terms_days ?? raw.defaultPaymentTermsDays),
        defaultPaymentTermsDays: toNumber(raw.default_payment_terms_days ?? raw.defaultPaymentTermsDays),
        supplier_type: String(raw.supplier_type ?? raw.supplierType ?? "permanent"),
        supplierType: String(raw.supplier_type ?? raw.supplierType ?? "permanent"),
        notes: (raw.notes ?? null) as string | null,
        is_active: Boolean(raw.is_active ?? raw.isActive), isActive: Boolean(raw.is_active ?? raw.isActive),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt), updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
      };
    case "inventory_stock_movements": {
      const id = toNumber(raw.id ?? raw.movement_id);
      return {
        id, movement_id: id,
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        warehouse_id: toNumber(raw.warehouse_id ?? raw.warehouseId),
        warehouse_code: String(raw.warehouse_code ?? raw.warehouseCode ?? ""),
        warehouse_name: String(raw.warehouse_name ?? raw.warehouseName ?? ""),
        item_id: toNumber(raw.item_id ?? raw.itemId),
        sku: (raw.sku ?? null) as string | null,
        item_name: String(raw.item_name ?? raw.itemName ?? ""),
        category: String(raw.category ?? "other"),
        base_unit: String(raw.base_unit ?? raw.baseUnit ?? ""),
        generator_id: optionalNumber(raw.generator_id ?? raw.generatorId),
        movement_type: String(raw.movement_type ?? raw.movementType ?? ""),
        quantity: String(raw.quantity ?? 0),
        reference_no: (raw.reference_no ?? raw.referenceNo ?? null) as string | null,
        notes: (raw.notes ?? null) as string | null,
        operation_key: String(raw.operation_key ?? raw.operationKey ?? ""),
        occurred_at: String(raw.occurred_at ?? raw.occurredAt ?? ""),
        created_by_user_id: optionalNumber(raw.created_by_user_id ?? raw.createdByUserId),
        created_at: String(raw.created_at ?? raw.createdAt ?? ""),
        reversal_of_movement_id: optionalNumber(raw.reversal_of_movement_id ?? raw.reversalOfMovementId),
        corrects_movement_id: optionalNumber(raw.corrects_movement_id ?? raw.correctsMovementId),
        correction_reason: (raw.correction_reason ?? raw.correctionReason ?? null) as string | null,
        corrected_by_movement_id: optionalNumber(raw.corrected_by_movement_id ?? raw.correctedByMovementId),
      };
    }
    case "inventory_purchase_receipt_headers": {
      const id = toNumber(raw.receipt_id ?? raw.id);
      return {
        ...raw, id, receipt_id: id,
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        purchaseId: toNumber(raw.purchase_id ?? raw.purchaseId),
        supplierId: toNumber(raw.supplier_id ?? raw.supplierId),
        supplierName: String(raw.supplier_name ?? raw.supplierName ?? ""),
        supplierCode: (raw.supplier_code ?? raw.supplierCode ?? null) as string | null,
        warehouseId: toNumber(raw.warehouse_id ?? raw.warehouseId),
        warehouseName: String(raw.warehouse_name ?? raw.warehouseName ?? ""),
        receipt_number: String(raw.receipt_number ?? ""),
        receipt_date: String(raw.receipt_date ?? ""),
        purchase_number: String(raw.purchase_number ?? ""),
        status: String(raw.status ?? ""),
        line_count: toNumber(raw.line_count ?? 0),
        received_quantity: String(raw.received_quantity ?? "0.000"),
      };
    }
    case "inventory_supplier_return_headers": {
      const id = toNumber(raw.return_id ?? raw.id);
      return {
        ...raw, id, return_id: id,
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        purchaseId: toNumber(raw.purchase_id ?? raw.purchaseId),
        supplierId: toNumber(raw.supplier_id ?? raw.supplierId),
        supplierName: String(raw.supplier_name ?? raw.supplierName ?? ""),
        supplierCode: (raw.supplier_code ?? raw.supplierCode ?? null) as string | null,
        warehouseId: toNumber(raw.warehouse_id ?? raw.warehouseId),
        warehouseName: String(raw.warehouse_name ?? raw.warehouseName ?? ""),
        return_number: String(raw.return_number ?? ""),
        return_date: String(raw.return_date ?? ""),
        purchase_number: String(raw.purchase_number ?? ""),
        status: String(raw.status ?? ""),
        line_count: toNumber(raw.line_count ?? 0),
        returned_quantity: String(raw.returned_quantity ?? "0.000"),
      };
    }
    case "inventory_purchase_headers": {
      const id = toNumber(raw.purchase_id ?? raw.id);
      const tenantId = toNumber(raw.tenant_id ?? raw.tenantId);
      const siteId = toNumber(raw.site_id ?? raw.siteId);
      const supplierId = toNumber(raw.supplier_id ?? raw.supplierId);
      const warehouseId = toNumber(raw.warehouse_id ?? raw.warehouseId);
      return {
        ...raw, id, purchase_id: id, tenantId, siteId,
        supplier_id: supplierId, supplierId,
        supplierName: String(raw.supplier_name ?? raw.supplierName ?? ""),
        supplierCode: (raw.supplier_code ?? raw.supplierCode ?? null) as string | null,
        warehouse_id: warehouseId, warehouseId,
        warehouseName: String(raw.warehouse_name ?? raw.warehouseName ?? ""),
        purchase_number: String(raw.purchase_number ?? ""),
        invoice_date: String(raw.invoice_date ?? ""),
        status: String(raw.status ?? ""),
      };
    }
    case "inventory_stocktakes": {
      const id = toNumber(raw.stocktake_id ?? raw.id);
      return {
        ...raw, id, stocktake_id: id,
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        warehouse_id: toNumber(raw.warehouse_id ?? raw.warehouseId),
      };
    }
    case "fuel_readings": {
      const id = toNumber(raw.reading_id ?? raw.id);
      return {
        id, reading_id: id,
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        generator_id: toNumber(raw.generator_id ?? raw.generatorId),
        generator_name: String(raw.generator_name ?? raw.generatorName ?? ""),
        reading_type: String(raw.reading_type ?? raw.readingType ?? ""),
        tank_warehouse_id: optionalNumber(raw.tank_warehouse_id ?? raw.tankWarehouseId),
        tank_name: (raw.tank_name ?? raw.tankName ?? null) as string | null,
        reading_value: String(raw.reading_value ?? raw.readingValue ?? 0),
        recorded_at: dateOrNow(raw.recorded_at ?? raw.recordedAt).toISOString(),
        reference_no: (raw.reference_no ?? raw.referenceNo ?? null) as string | null,
        notes: (raw.notes ?? null) as string | null,
        corrects_reading_id: optionalNumber(raw.corrects_reading_id ?? raw.correctsReadingId),
        correction_reason: (raw.correction_reason ?? raw.correctionReason ?? null) as string | null,
        created_by_user_id: optionalNumber(raw.created_by_user_id ?? raw.createdByUserId),
        created_at: dateOrNow(raw.created_at ?? raw.createdAt).toISOString(),
      };
    }
    case "maintenance_preventive_plans": {
      const id = toNumber(raw.plan_id ?? raw.id);
      return {
        ...raw, id, plan_id: id,
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        plan_code: String(raw.plan_code ?? raw.planCode ?? ""),
        generator_id: toNumber(raw.generator_id ?? raw.generatorId),
        generator_name: String(raw.generator_name ?? raw.generatorName ?? ""),
        title: String(raw.title ?? ""),
        description: (raw.description ?? null) as string | null,
        interval_days: optionalNumber(raw.interval_days ?? raw.intervalDays),
        interval_operating_hours: optionalNumber(raw.interval_operating_hours ?? raw.intervalOperatingHours),
        next_due_at: (raw.next_due_at ?? raw.nextDueAt ?? null) as string | null,
        next_due_operating_hours: optionalNumber(raw.next_due_operating_hours ?? raw.nextDueOperatingHours),
        due_soon_days: toNumber(raw.due_soon_days ?? raw.dueSoonDays),
        due_soon_hours: toNumber(raw.due_soon_hours ?? raw.dueSoonHours),
        is_active: Boolean(raw.is_active ?? raw.isActive),
        last_completed_at: (raw.last_completed_at ?? raw.lastCompletedAt ?? null) as string | null,
        last_completed_operating_hours: optionalNumber(raw.last_completed_operating_hours ?? raw.lastCompletedOperatingHours),
        alert_type: (raw.alert_type ?? raw.alertType ?? null) as string | null,
        observed_operating_hours: optionalNumber(raw.observed_operating_hours ?? raw.observedOperatingHours),
      };
    }
    case "inventory_warehouses":
      return {
        id: toNumber(raw.id), tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId), code: String(raw.code ?? ""), name: String(raw.name ?? ""),
        notes: (raw.notes ?? null) as string | null, is_active: Boolean(raw.is_active ?? raw.isActive), isActive: Boolean(raw.is_active ?? raw.isActive),
        location_type: String(raw.location_type ?? raw.locationType ?? "branch_warehouse"),
        locationType: String(raw.location_type ?? raw.locationType ?? "branch_warehouse"),
        generator_id: optionalNumber(raw.generator_id ?? raw.generatorId), generatorId: optionalNumber(raw.generator_id ?? raw.generatorId),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt), updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
      };
  }
}

export function normalizeDeltaPage(
  entityType: DeltaOperationalEntity,
  page: DeltaPage<Row>,
): DeltaPage<Row> {
  if (page.entity_type !== entityType) throw new Error("استجابة المزامنة لا تطابق نوع البيانات المطلوب.");
  return {
    ...page,
    changes: page.changes.map((change): DeltaChange<Row> => ({
      ...change,
      row_data: change.operation === "upsert" && isRow(change.row_data)
        ? normalizeDeltaEntityRow(entityType, change.row_data)
        : null,
    })),
  };
}

export function snapshotRowsFromQuery(entityType: DeltaOperationalEntity, data: unknown): Row[] {
  if (!Array.isArray(data)) throw new Error("لقطة المزامنة ليست قائمة بيانات صالحة.");
  if (entityType !== "readings") {
    return data.filter(isRow).map((row) => normalizeDeltaEntityRow(entityType, row));
  }
  return data.flatMap((entry) => {
    if (!isRow(entry) || !isRow(entry.reading)) return [];
    return [normalizeDeltaEntityRow("readings", entry.reading)];
  });
}

function idOf(row: unknown): string | null {
  if (!isRow(row)) return null;
  const id = row.id ?? row.stocktake_id ?? row.stocktakeId;
  if (id === null || id === undefined) return null;
  return String(id);
}
function scopedTo(row: Row, scope: DeltaCursorScope) {
  if (row.tenantId !== undefined && toNumber(row.tenantId) !== scope.tenantId) return false;
  if (row.siteId !== undefined && toNumber(row.siteId) !== scope.siteId) return false;
  return true;
}

export function applyDeltaPageToList(
  entityType: DeltaOperationalEntity,
  current: readonly unknown[],
  page: DeltaPage<Row>,
  scope: DeltaCursorScope,
  subscriberRows: readonly Row[] = [],
): unknown[] {
  const byId = new Map<string, unknown>();
  for (const row of current) {
    const shaped = entityType === "readings" && isRow(row) ? row.reading : row;
    const id = idOf(shaped);
    if (id !== null) byId.set(id, row);
  }
  const subscribersById = new Map(subscriberRows.filter(isRow).map((row) => [String(row.id), row]));
  for (const change of page.changes) {
    if (change.operation === "delete") {
      if (entityType === "sites" && change.entity_id !== String(scope.siteId)) continue;
      byId.delete(change.entity_id);
      continue;
    }
    if (!isRow(change.row_data) || idOf(change.row_data) !== change.entity_id || !scopedTo(change.row_data, scope)) continue;
    if (entityType === "sites" && change.entity_id !== String(scope.siteId)) continue;
    if (entityType !== "readings") {
      byId.set(change.entity_id, change.row_data);
      continue;
    }
    const existing = byId.get(change.entity_id);
    const oldPair = isRow(existing) ? existing : null;
    const oldSubscriber = oldPair && isRow(oldPair.subscriber) ? oldPair.subscriber : null;
    const subscriberId = String(change.row_data.subscriberId);
    const subscriber = subscribersById.get(subscriberId) ??
      (oldSubscriber && String(oldSubscriber.id) === subscriberId ? oldSubscriber : null);
    // A reading is not inserted into the view cache until its parent subscriber is
    // present in the same authorized site scope. The sidecar still retains the row.
    if (!subscriber || toNumber(subscriber.siteId) !== scope.siteId || toNumber(subscriber.tenantId) !== scope.tenantId) continue;
    byId.set(change.entity_id, { reading: change.row_data, subscriber });
  }
  return [...byId.values()];
}

export function refreshReadingSubscriberProjection(
  current: readonly unknown[],
  page: DeltaPage<Row>,
  scope: DeltaCursorScope,
): unknown[] {
  const updatedSubscribers = new Map<string, Row>();
  for (const change of page.changes) {
    if (change.operation === "upsert" && isRow(change.row_data) && scopedTo(change.row_data, scope)) {
      updatedSubscribers.set(change.entity_id, change.row_data);
    }
  }
  if (!updatedSubscribers.size) return [...current];
  return current.map((item) => {
    if (!isRow(item) || !isRow(item.reading) || !isRow(item.subscriber)) return item;
    const row = updatedSubscribers.get(String(item.subscriber.id));
    return row ? { ...item, subscriber: { ...item.subscriber, ...row } } : item;
  });
}



function decodeReadingPageCursor(value: string): { at: number; id: number } {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const parsed = JSON.parse(atob(padded)) as { at?: unknown; id?: unknown };
    const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
    const id = Number(parsed.id);
    if (!Number.isFinite(at) || !Number.isSafeInteger(id) || id < 1) throw new Error("invalid");
    return { at, id };
  } catch {
    throw new Error("مؤشر صفحة القراءات المحلي غير صالح؛ يلزم تحديث الصفحة من الخادم.");
  }
}

function encodeReadingPageCursor(row: Row): string {
  const readingAt = dateOrNull(row.readingAt);
  const id = Number(row.id);
  if (!readingAt || !Number.isSafeInteger(id) || id < 1) throw new Error("تعذر إنشاء مؤشر صفحة القراءات المحلي.");
  return btoa(JSON.stringify({ at: readingAt.toISOString(), id }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

/** Rebuilds a keyset reading page from the full scoped reading Delta snapshot. */
export function projectReadingDeltaPage(
  rows: readonly Row[],
  subscriberRows: readonly Row[],
  input: { siteId?: unknown; limit?: unknown; cursor?: unknown },
  previousData: unknown,
  scope: DeltaCursorScope,
): Row & { items: Array<{ reading: Row; subscriber: Row }>; hasNext: boolean; nextCursor: string | null } {
  if (Number(input.siteId) !== scope.siteId) throw new Error("نطاق صفحة القراءات لا يطابق الفرع الجاري مزامنته.");
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("حجم صفحة القراءات المحلي غير صالح.");
  const cursor = typeof input.cursor === "string" && input.cursor.length ? decodeReadingPageCursor(input.cursor) : null;

  // Prefer the current subscribers.list projection, while allowing rows already
  // present in this exact page to be used as a bounded fallback during startup.
  const subscribersById = new Map<string, Row>();
  for (const subscriber of subscriberRows) {
    if (Number(subscriber.tenantId) === scope.tenantId && Number(subscriber.siteId) === scope.siteId) {
      subscribersById.set(String(subscriber.id), subscriber);
    }
  }
  if (isRow(previousData) && Array.isArray(previousData.items)) {
    for (const item of previousData.items) {
      if (!isRow(item) || !isRow(item.subscriber)) continue;
      const subscriber = item.subscriber;
      if (Number(subscriber.tenantId) === scope.tenantId && Number(subscriber.siteId) === scope.siteId &&
          !subscribersById.has(String(subscriber.id))) {
        subscribersById.set(String(subscriber.id), subscriber);
      }
    }
  }

  const ordered = rows.filter((row) => {
    const readingAt = dateOrNull(row.readingAt);
    const subscriber = subscribersById.get(String(row.subscriberId));
    return Number(row.tenantId) === scope.tenantId &&
      Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0 &&
      readingAt !== null && Boolean(subscriber);
  }).filter((row) => {
    if (!cursor) return true;
    const at = dateOrNull(row.readingAt)!.getTime();
    const id = Number(row.id);
    return at < cursor.at || (at === cursor.at && id < cursor.id);
  }).sort((a, b) => {
    const byDate = dateOrNull(b.readingAt)!.getTime() - dateOrNull(a.readingAt)!.getTime();
    return byDate || Number(b.id) - Number(a.id);
  });

  const hasNext = ordered.length > limit;
  const readingItems = ordered.slice(0, limit);
  const items = readingItems.map((reading) => ({
    reading,
    subscriber: subscribersById.get(String(reading.subscriberId))!,
  }));
  const last = readingItems.at(-1);
  return {
    ...(isRow(previousData) ? previousData : {}),
    items,
    hasNext,
    nextCursor: hasNext && last ? encodeReadingPageCursor(last) : null,
  };
}



function decodeExpensePageCursor(value: string): { at: number; id: number } {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const parsed = JSON.parse(atob(padded)) as { at?: unknown; id?: unknown };
    const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : NaN;
    const id = Number(parsed.id);
    if (!Number.isFinite(at) || !Number.isSafeInteger(id) || id < 1) throw new Error("invalid");
    return { at, id };
  } catch { throw new Error("مؤشر صفحة المصروفات المحلي غير صالح؛ يلزم تحديث الصفحة من الخادم."); }
}
function encodeExpensePageCursor(row: Row): string {
  const at = dateOrNull(row.occurredAt), id = Number(row.id);
  if (!at || !Number.isSafeInteger(id) || id < 1) throw new Error("تعذر إنشاء مؤشر صفحة المصروفات المحلي.");
  return btoa(JSON.stringify({ at: at.toISOString(), id })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function expenseDateBoundary(dateKey: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || new Date(dateKey + "T00:00:00.000Z").toISOString().slice(0,10) !== dateKey) throw new Error("تاريخ فلتر المصروفات المحلي غير صالح.");
  const [y,m,d] = dateKey.split("-").map(Number), wall = Date.UTC(y,m-1,d);
  const fmt = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Gaza",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
  let candidate = wall;
  for(let i=0;i<4;i++){const parts=fmt.formatToParts(new Date(candidate));const get=(k:string)=>Number(parts.find(p=>p.type===k)?.value??0);const represented=Date.UTC(get("year"),get("month")-1,get("day"),get("hour"),get("minute"),get("second"));const delta=represented-candidate;if(delta===0)break;candidate=wall-delta;}
  return candidate;
}
function nextExpenseDateKey(dateKey: string): string {
  const [y,m,d]=dateKey.split("-").map(Number), next=new Date(Date.UTC(y,m-1,d+1));
  return next.toISOString().slice(0,10);
}
export function projectExpenseDeltaPage(rows: readonly Row[], input: {siteId?:unknown;limit?:unknown;cursor?:unknown;startDate?:unknown;endDate?:unknown;companyAccountId?:unknown}, previousData: unknown, scope: DeltaCursorScope): Row & {items:Row[];hasNext:boolean;nextCursor:string|null} {
  if(Number(input.siteId)!==scope.siteId) throw new Error("نطاق صفحة المصروفات لا يطابق الفرع الجاري مزامنته.");
  const limit=input.limit===undefined?50:Number(input.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>200) throw new Error("حجم صفحة المصروفات المحلي غير صالح.");
  const start=input.startDate===undefined?null:String(input.startDate), end=input.endDate===undefined?null:String(input.endDate);
  if(Boolean(start)!==Boolean(end)) throw new Error("يلزم تحديد تاريخ البداية والنهاية معًا.");
  if(start&&end&&start>end) throw new Error("تاريخ بداية المصروفات يجب ألا يتجاوز تاريخ النهاية.");
  const startAt=start?expenseDateBoundary(start):null, endAt=end?expenseDateBoundary(nextExpenseDateKey(end)):null;
  const account=input.companyAccountId===undefined?null:Number(input.companyAccountId);
  if(account!==null&&(!Number.isSafeInteger(account)||account<1)) throw new Error("حساب فلتر المصروفات المحلي غير صالح.");
  const cursor=typeof input.cursor==="string"&&input.cursor?decodeExpensePageCursor(input.cursor):null;
  const ordered=rows.filter(r=>{const at=dateOrNull(r.occurredAt);return Number(r.tenantId)===scope.tenantId&&Number(r.siteId)===scope.siteId&&Number.isSafeInteger(Number(r.id))&&Number(r.id)>0&&at!==null&&(account===null||Number(r.companyAccountId)===account)&&(startAt===null||at.getTime()>=startAt)&&(endAt===null||at.getTime()<endAt);})
    .filter(r=>{if(!cursor)return true;const at=dateOrNull(r.occurredAt)!.getTime(),id=Number(r.id);return at<cursor.at||(at===cursor.at&&id<cursor.id);})
    .sort((a,b)=>dateOrNull(b.occurredAt)!.getTime()-dateOrNull(a.occurredAt)!.getTime()||Number(b.id)-Number(a.id));
  const hasNext=ordered.length>limit,items=ordered.slice(0,limit),last=items.at(-1);
  return {...(isRow(previousData)?previousData:{}),items,hasNext,nextCursor:hasNext&&last?encodeExpensePageCursor(last):null};
}


function decodePaymentPageCursor(value: string): { at: number; id: number } {
  try {
    const normalized=value.replace(/-/g,"+").replace(/_/g,"/");
    const padded=normalized+"=".repeat((4-normalized.length%4)%4);
    const parsed=JSON.parse(atob(padded)) as {at?:unknown;id?:unknown};
    const at=typeof parsed.at==="string"?Date.parse(parsed.at):Number.NaN;
    const id=Number(parsed.id);
    if(!Number.isFinite(at)||!Number.isSafeInteger(id)||id<1) throw new Error("invalid");
    return {at,id};
  } catch { throw new Error("مؤشر صفحة المدفوعات المحلي غير صالح؛ يلزم تحديث الصفحة من الخادم."); }
}
function encodePaymentPageCursor(payment: Row): string {
  const paidAt=dateOrNull(payment.paidAt), id=Number(payment.id);
  if(!paidAt||!Number.isSafeInteger(id)||id<1) throw new Error("تعذر إنشاء مؤشر صفحة المدفوعات المحلي.");
  return btoa(JSON.stringify({at:paidAt.toISOString(),id})).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"");
}
export function projectPaymentDeltaPage(
  rows: readonly Row[], input: {siteId?:unknown;limit?:unknown;cursor?:unknown}, previousData: unknown, scope: DeltaCursorScope,
): Row & {items:Array<{payment:Row;subscriber:Row;invoiceNo:string|null}>;hasNext:boolean;nextCursor:string|null} {
  if(Number(input.siteId)!==scope.siteId) throw new Error("نطاق صفحة المدفوعات لا يطابق الفرع الجاري مزامنته.");
  const limit=input.limit===undefined?50:Number(input.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>200) throw new Error("حجم صفحة المدفوعات المحلي غير صالح.");
  const cursor=typeof input.cursor==="string"&&input.cursor.length?decodePaymentPageCursor(input.cursor):null;
  const ordered=rows.filter(row=>{
    if(!isRow(row)||!isRow(row.payment)||!isRow(row.subscriber)) return false;
    const payment=row.payment, subscriber=row.subscriber, paidAt=dateOrNull(payment.paidAt);
    return Number(row.tenantId)===scope.tenantId&&Number(row.siteId)===scope.siteId&&
      Number(payment.tenantId)===scope.tenantId&&Number(payment.siteId)===scope.siteId&&
      Number(subscriber.tenantId)===scope.tenantId&&Number(subscriber.siteId)===scope.siteId&&
      Number.isSafeInteger(Number(payment.id))&&Number(payment.id)>0&&paidAt!==null;
  }).filter(row=>{
    if(!cursor)return true;
    const payment=row.payment as Row, at=dateOrNull(payment.paidAt)!.getTime(), id=Number(payment.id);
    return at<cursor.at||(at===cursor.at&&id<cursor.id);
  }).sort((a,b)=>{
    const left=a.payment as Row,right=b.payment as Row;
    return dateOrNull(right.paidAt)!.getTime()-dateOrNull(left.paidAt)!.getTime()||Number(right.id)-Number(left.id);
  });
  const hasNext=ordered.length>limit;
  const items=ordered.slice(0,limit).map(row=>({payment:{...(row.payment as Row),receiptImageUrl:null},subscriber:row.subscriber as Row,invoiceNo:typeof row.invoiceNo==="string"?row.invoiceNo:null}));
  const last=items.at(-1);
  return {...(isRow(previousData)?previousData:{}),items,hasNext,nextCursor:hasNext&&last?encodePaymentPageCursor(last.payment):null};
}
export function refreshPaymentRelatedProjection(current: readonly unknown[], page: DeltaPage<Row>, scope: DeltaCursorScope, relation: "subscribers"|"invoices"): unknown[] {
  const upserts=new Map<string,Row>(), deleted=new Set<string>();
  for(const change of page.changes){
    if(change.operation==="delete") deleted.add(change.entity_id);
    else if(isRow(change.row_data)&&scopedTo(change.row_data,scope)) upserts.set(change.entity_id,change.row_data);
  }
  return current.map(entry=>{
    if(!isRow(entry)||!isRow(entry.payment))return entry;
    const payment=entry.payment as Row;
    if(relation==="subscribers"&&upserts.has(String(payment.subscriberId))){
      const subscriber=isRow(entry.subscriber)?entry.subscriber:{};
      return {...entry,subscriber:{...subscriber,...upserts.get(String(payment.subscriberId))}};
    }
    if(relation==="invoices"&&payment.invoiceId!=null){
      const id=String(payment.invoiceId);
      if(deleted.has(id))return {...entry,invoiceNo:null};
      const invoice=upserts.get(id);
      if(invoice&&typeof invoice.invoiceNo==="string")return {...entry,invoiceNo:invoice.invoiceNo};
    }
    return entry;
  });
}

function decodeInvoicePageCursor(value: string): { at: number; id: number } {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const parsed = JSON.parse(atob(padded)) as { at?: unknown; id?: unknown };
    const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
    const id = Number(parsed.id);
    if (!Number.isFinite(at) || !Number.isSafeInteger(id) || id < 1) throw new Error("invalid");
    return { at, id };
  } catch {
    throw new Error("مؤشر صفحة الفواتير المحلي غير صالح؛ يلزم تحديث الصفحة من الخادم.");
  }
}

function encodeInvoicePageCursor(row: Row): string {
  const issueDate = dateOrNull(row.issueDate);
  const id = Number(row.id);
  if (!issueDate || !Number.isSafeInteger(id) || id < 1) throw new Error("تعذر إنشاء مؤشر صفحة الفواتير المحلي.");
  return btoa(JSON.stringify({ at: issueDate.toISOString(), id }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

/** Rebuilds the keyset page from the full scoped invoice Delta snapshot. */
export function projectInvoiceDeltaPage(
  rows: readonly Row[],
  input: { siteId?: unknown; limit?: unknown; cursor?: unknown },
  previousData: unknown,
  scope: DeltaCursorScope,
): Row & { items: Row[]; hasNext: boolean; nextCursor: string | null } {
  if (Number(input.siteId) !== scope.siteId) throw new Error("نطاق صفحة الفواتير لا يطابق الفرع الجاري مزامنته.");
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("حجم صفحة الفواتير المحلي غير صالح.");
  const cursor = typeof input.cursor === "string" && input.cursor.length ? decodeInvoicePageCursor(input.cursor) : null;
  const ordered = rows.filter(row =>
    Number(row.tenantId) === scope.tenantId && Number(row.siteId) === scope.siteId &&
    Number.isSafeInteger(Number(row.id)) && dateOrNull(row.issueDate) !== null
  ).filter(row => {
    if (!cursor) return true;
    const at = dateOrNull(row.issueDate)!.getTime();
    const id = Number(row.id);
    return at < cursor.at || (at === cursor.at && id < cursor.id);
  }).sort((a,b) => {
    const byDate = dateOrNull(b.issueDate)!.getTime() - dateOrNull(a.issueDate)!.getTime();
    return byDate || Number(b.id) - Number(a.id);
  });
  const hasNext = ordered.length > limit;
  const items = ordered.slice(0, limit);
  const last = items.at(-1);
  return {
    ...(isRow(previousData) ? previousData : {}),
    items,
    hasNext,
    nextCursor: hasNext && last ? encodeInvoicePageCursor(last) : null,
  };
}
