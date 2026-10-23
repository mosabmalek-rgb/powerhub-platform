import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireSupabaseSiteRole, resolveSupabaseSiteAccess } from "./powerhub-supabase";
import { supabaseAdmin } from "./supabase-admin";

const roles = ["owner", "manager", "accountant", "collector", "technician", "viewer"] as const;

type InventoryStockOverviewRow = {
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  item_id: number;
  sku: string | null;
  item_name: string;
  category: string;
  base_unit: string;
  reorder_point: number | string;
  on_hand_quantity: number | string;
  stock_value: number | string;
  average_unit_cost: number | string;
  below_reorder_point: boolean;
};

type InventoryStockMovementRow = {
  movement_id: number;
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  item_id: number;
  sku: string | null;
  item_name: string;
  category: string;
  base_unit: string;
  generator_id: number | null;
  movement_type: string;
  quantity: number | string;
  unit_cost: number | string;
  total_cost_amount: number | string;
  reference_no: string | null;
  notes: string | null;
  operation_key: string;
  occurred_at: string;
  created_by_user_id: number | null;
  created_at: string;
  source_issue_movement_id?: number | null;
  returnable_quantity?: number | string;
};

const categorySchema = z.enum(["fuel", "oil", "filter", "spare_part", "maintenance_supply", "other"]);
const unitSchema = z.enum(["liter", "milliliter", "piece", "container", "kg", "gram", "meter", "set", "gallon", "other"]);

function mapDatabaseError(error: { code?: string } | null, operation: string): never {
  if (error?.code === "23505") {
    throw new TRPCError({ code: "CONFLICT", message: "يوجد سجل بنفس الرمز أو البيانات الفريدة." });
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: operation });
}


function mapPurchaseDatabaseError(
  error: { code?: string; message?: string } | null,
  fallback: string,
): never {
  if (error?.code === "23505" && (error.message ?? "").includes("inventory_item_units_label_unique_idx")) {
    throw new TRPCError({ code: "CONFLICT", message: "وحدة شراء بهذا الاسم موجودة لهذا الصنف." });
  }
  if (error?.code === "23505") {
    throw new TRPCError({ code: "CONFLICT", message: "يوجد رقم فاتورة أو مفتاح عملية مستخدم مسبقًا." });
  }
  const message = error?.message ?? "";
  const known: Record<string, { code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND" | "FORBIDDEN"; message: string }> = {
    INVALID_OPERATION_KEY: { code: "BAD_REQUEST", message: "مفتاح العملية غير صالح." },
    INVALID_STOCK_TRANSFER: { code: "BAD_REQUEST", message: "بيانات التحويل المخزني غير صالحة؛ اختر مخزنين مختلفين." },
    INVALID_STOCK_TRANSFER_QUANTITY: { code: "BAD_REQUEST", message: "كمية التحويل غير صالحة أو تتجاوز ثلاث منازل عشرية." },
    STOCK_DESTINATION_WAREHOUSE_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المخزن المستلم غير نشط أو لا يتبع هذا الفرع." },
    STOCK_MOVEMENT_NOT_FOUND: { code: "NOT_FOUND", message: "حركة المخزون غير موجودة في هذا الفرع." },
    STOCK_MOVEMENT_NOT_RETURNABLE: { code: "BAD_REQUEST", message: "يمكن إرجاع الصرف اليدوي المؤهل فقط." },
    RETURN_FROM_ISSUE_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لإرجاع الصرف." },
    RETURN_FROM_ISSUE_EXCEEDS_UNRETURNED_QUANTITY: { code: "CONFLICT", message: "الكمية تتجاوز الكمية المصروفة المتبقية للإرجاع." },
    RETURN_FROM_ISSUE_COST_RECONCILIATION_FAILED: { code: "CONFLICT", message: "تعذر مطابقة تكلفة المرتجع مع تكلفة الصرف الأصلي." },
    INVENTORY_BALANCE_INVALID: { code: "CONFLICT", message: "رصيد المخزون غير متزن؛ أوقفنا الإرجاع لحماية السجلات." },
    STOCK_MOVEMENT_NOT_EDITABLE: { code: "BAD_REQUEST", message: "هذا النوع من الحركات لا يقبل التعديل المباشر؛ عدّل المستند الأصلي أو سجّل تسوية." },
    STOCK_MOVEMENT_ALREADY_CORRECTED: { code: "CONFLICT", message: "سبق تصحيح هذه الحركة." },
    STOCK_MOVEMENT_NOT_LATEST: { code: "CONFLICT", message: "لا يمكن تعديل حركة سبقتها حركة أحدث للصنف نفسه؛ استخدم تسوية مخزون جديدة." },
    STOCK_MOVEMENT_CORRECTION_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا للتعديل (3 أحرف على الأقل)." },
    STOCK_MOVEMENT_CORRECTION_WOULD_NEGATE_BALANCE: { code: "CONFLICT", message: "التعديل سيؤدي إلى رصيد أو قيمة مخزون سالبة." },
    STOCK_MOVEMENT_CORRECTION_COST_NEGATIVE: { code: "CONFLICT", message: "التعديل سيؤدي إلى قيمة مخزون سالبة." },
    STOCK_MOVEMENT_CORRECTION_INCOMPLETE: { code: "CONFLICT", message: "لم يكتمل سجل التصحيح؛ أوقفنا إعادة المحاولة." },
    STOCK_MOVEMENT_DIRECT_UPDATE_WAS_ACCEPTED: { code: "CONFLICT", message: "سجل الحركة غير قابل للتعديل المباشر." },
    INVALID_STOCK_REFERENCE: { code: "BAD_REQUEST", message: "رقم مرجع الحركة أطول من المسموح." },
    INVALID_STOCK_NOTES: { code: "BAD_REQUEST", message: "ملاحظات الحركة أطول من المسموح." },
    FUEL_MOVEMENT_SCOPE_INVALID: { code: "BAD_REQUEST", message: "المولد أو صنف الوقود المرتبط بالحركة غير صالح." },
    INVALID_PURCHASE_LINES: { code: "BAD_REQUEST", message: "تحقق من بنود فاتورة المشتريات والكميات والأسعار." },
    INVALID_RECEIPT_LINES: { code: "BAD_REQUEST", message: "تحقق من كميات الاستلام." },
    INVALID_PAYMENT_TERMS: { code: "BAD_REQUEST", message: "مدة السداد غير صالحة." },
    INVALID_PAYMENT_MODE: { code: "BAD_REQUEST", message: "طريقة السداد غير صالحة." },
    INVALID_IMMEDIATE_PAYMENT_TERMS: { code: "BAD_REQUEST", message: "الدفع الفوري يتطلب الاستحقاق في تاريخ الفاتورة." },
    INVALID_SUPPLIER_TYPE: { code: "BAD_REQUEST", message: "نوع المورد غير صالح." },
    INVALID_ONE_TIME_SUPPLIER_TERMS: { code: "BAD_REQUEST", message: "المورد لمرة واحدة يتطلب أجلًا افتراضيًا صفرًا." },
    INVALID_DUE_DATE: { code: "BAD_REQUEST", message: "تاريخ الاستحقاق لا يجوز أن يسبق تاريخ الفاتورة." },
    PURCHASE_NOT_FOUND: { code: "NOT_FOUND", message: "فاتورة المشتريات غير موجودة في هذا الفرع." },
    SUPPLIER_RETURN_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لمرتجع المورد." },
    INVALID_SUPPLIER_RETURN_LINES: { code: "BAD_REQUEST", message: "تحقق من بنود وكميات مرتجع المورد." },
    DUPLICATE_OR_INVALID_SUPPLIER_RETURN_LINE: { code: "BAD_REQUEST", message: "لا تكرر بند الفاتورة نفسه في المرتجع." },
    SUPPLIER_RETURN_EXCEEDS_UNRETURNED_RECEIPT: { code: "CONFLICT", message: "كمية المرتجع تتجاوز الكمية المستلمة المتبقية بعد المرتجعات السابقة." },
    PURCHASE_RECEIPT_QUANTITY_MISMATCH: { code: "CONFLICT", message: "سجل الاستلام لا يطابق كميات الفاتورة؛ أوقفنا المرتجع لحماية المخزون." },
    SUPPLIER_RETURN_PURCHASE_NOT_RECEIVABLE: { code: "CONFLICT", message: "يمكن إرجاع البنود المستلمة فقط من فاتورة غير ملغاة." },
    INVALID_SUPPLIER_RETURN_REFUND: { code: "BAD_REQUEST", message: "مبلغ الاسترداد النقدي غير صالح." },
    SUPPLIER_RETURN_REFUND_ACCOUNT_REQUIRED: { code: "BAD_REQUEST", message: "حدد حساب الشركة إذا كان المورد سيرد مبلغًا نقديًا." },
    SUPPLIER_RETURN_REFUND_EXCEEDS_CREDIT: { code: "BAD_REQUEST", message: "مبلغ الاسترداد يتجاوز قيمة المرتجع." },
    INSUFFICIENT_STOCK_FOR_SUPPLIER_RETURN: { code: "CONFLICT", message: "الرصيد المتاح لا يكفي لإرجاع الكمية المحددة؛ راجع المخزون أولًا." },
    INVALID_INVENTORY_ITEM: { code: "BAD_REQUEST", message: "تحقق من بيانات الصنف ووحدة القياس وحد إعادة الطلب." },
    INVALID_ITEM_UNIT_CONVERSION: { code: "BAD_REQUEST", message: "أدخل وحدة شراء ومعامل تحويل موجبًا حتى 6 منازل عشرية." },
    ITEM_UNIT_EQUALS_BASE_UNIT: { code: "BAD_REQUEST", message: "وحدة الشراء الأساسية لا تحتاج إلى تعريف إضافي؛ معاملها يساوي 1." },
    INVENTORY_ITEM_UNIT_NOT_FOUND: { code: "NOT_FOUND", message: "وحدة الشراء غير موجودة لهذا الصنف." },
    INVENTORY_ITEM_UNIT_HAS_OPEN_PURCHASE: { code: "CONFLICT", message: "لا يمكن إيقاف وحدة شراء مستخدمة في كميات معلقة بفواتير مفتوحة." },
    PURCHASE_UNIT_NOT_CONFIGURED: { code: "BAD_REQUEST", message: "وحدة الشراء غير معرّفة لهذا الصنف أو موقوفة؛ حدّث دليل وحدات الصنف." },
    PURCHASE_UNIT_CONVERSION_MISMATCH: { code: "BAD_REQUEST", message: "معامل التحويل لا يطابق دليل وحدات الصنف؛ لم تُحفظ الفاتورة." },
    ITEM_BASE_UNIT_HAS_PURCHASE_UNITS: { code: "CONFLICT", message: "لا يمكن تغيير الوحدة الأساسية بعد تعريف وحدات شراء مرتبطة بها." },
    INVENTORY_ITEM_NOT_FOUND: { code: "NOT_FOUND", message: "الصنف غير موجود في هذه المؤسسة." },
    INVENTORY_ITEM_INACTIVE: { code: "CONFLICT", message: "الصنف موقوف؛ أعد تفعيله قبل تعديل بياناته." },
    ITEM_BASE_UNIT_IMMUTABLE_AFTER_USE: { code: "CONFLICT", message: "لا يمكن تغيير وحدة الصنف الأساسية بعد استخدامه في حركة أو فاتورة؛ أنشئ صنفًا جديدًا إذا تغيرت الوحدة." },
    ITEM_IDENTITY_IMMUTABLE_AFTER_USE: { code: "CONFLICT", message: "لا يمكن تغيير الرمز أو الاسم أو التصنيف لصنف له حركات تاريخية؛ أنشئ صنفًا جديدًا حتى تبقى التقارير السابقة دقيقة." },
    INVENTORY_ITEM_HAS_STOCK: { code: "CONFLICT", message: "لا يمكن إيقاف الصنف ما دام له رصيد في أي مخزن. صفّر الأرصدة أولًا." },
    INVENTORY_ITEM_HAS_OPEN_PURCHASE: { code: "CONFLICT", message: "لا يمكن إيقاف الصنف مع وجود كميات معلقة في فواتير شراء مفتوحة." },
    INVALID_ACTIVE_STATE: { code: "BAD_REQUEST", message: "حالة التفعيل غير صالحة." },
    INVENTORY_DEACTIVATION_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لإيقاف الصنف." },
    INVALID_SUPPLIER_PROFILE: { code: "BAD_REQUEST", message: "تحقق من بيانات المورد وأجل السداد والبريد الإلكتروني." },
    SUPPLIER_DEACTIVATION_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لإيقاف المورد." },
    SUPPLIER_HAS_OUTSTANDING_PAYABLE: { code: "CONFLICT", message: "لا يمكن إيقاف المورد قبل تسوية ذممه المستحقة." },
    SUPPLIER_HAS_OPEN_PURCHASE: { code: "CONFLICT", message: "لا يمكن إيقاف المورد مع وجود فاتورة شراء مفتوحة." },
    INVALID_INVENTORY_WAREHOUSE: { code: "BAD_REQUEST", message: "تحقق من رمز المخزن واسمه." },
    INVALID_INVENTORY_LOCATION_TYPE: { code: "BAD_REQUEST", message: "اختر نوع موقع التخزين واربط خزان المولد بالمولد الصحيح." },
    WAREHOUSE_IDENTITY_IMMUTABLE_AFTER_USE: { code: "CONFLICT", message: "لا يمكن تغيير رمز الموقع أو اسمه أو نوعه بعد تسجيل حركة أو فاتورة عليه؛ أنشئ موقعًا جديدًا وانقل الرصيد بطريقة موثقة." },
    FUEL_ITEM_REQUIRED_FOR_TANK: { code: "BAD_REQUEST", message: "يقبل موقع خزان الوقود أصناف الوقود فقط." },
    STOCKTAKE_SCOPE_REQUIRED: { code: "BAD_REQUEST", message: "حدد الفرع وموقع التخزين لجلسة الجرد." },
    STOCKTAKE_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا للجرد الفعلي." },
    INVALID_STOCKTAKE_NOTES: { code: "BAD_REQUEST", message: "ملاحظات الجرد أطول من المسموح." },
    STOCKTAKE_CATALOG_EMPTY: { code: "CONFLICT", message: "لا توجد أصناف نشطة لإدراجها في جلسة الجرد." },
    STOCKTAKE_NOT_FOUND: { code: "NOT_FOUND", message: "جلسة الجرد غير موجودة في هذا الفرع." },
    STOCKTAKE_NOT_COUNTABLE: { code: "CONFLICT", message: "جلسة الجرد ليست في حالة تسمح بإدخال العد أو تعديله." },
    STOCKTAKE_ITEM_NOT_FOUND: { code: "NOT_FOUND", message: "الصنف غير مدرج ضمن لقطة جلسة الجرد هذه." },
    INVALID_STOCKTAKE_COUNT: { code: "BAD_REQUEST", message: "الكمية المعدودة يجب أن تكون صفرًا أو أكثر وبحد أقصى ثلاث منازل عشرية." },
    INVALID_STOCKTAKE_UNIT_COST: { code: "BAD_REQUEST", message: "تكلفة وحدة الزيادة غير صالحة أو تتجاوز أربع منازل عشرية." },
    INVALID_STOCKTAKE_COUNT_NOTES: { code: "BAD_REQUEST", message: "ملاحظات العد أطول من المسموح." },
    STOCKTAKE_COUNTS_INCOMPLETE: { code: "CONFLICT", message: "لا يمكن إرسال الجرد قبل إدخال العد لكل الأصناف." },
    STOCKTAKE_STOCK_CHANGED_DURING_COUNT: { code: "CONFLICT", message: "تغير رصيد أو قيمة المخزون أو دليل الأصناف منذ بدء العد؛ ألغِ الجلسة وافتح جردًا جديدًا حتى لا تُرحّل نتائج قديمة." },
    STOCKTAKE_NOT_SUBMITTABLE: { code: "CONFLICT", message: "حالة جلسة الجرد لا تسمح بإرسالها للاعتماد." },
    STOCKTAKE_NOT_APPROVED: { code: "CONFLICT", message: "يجب إرسال جلسة الجرد للاعتماد قبل ترحيلها." },
    STOCKTAKE_SURPLUS_UNIT_COST_REQUIRED: { code: "BAD_REQUEST", message: "أدخل تكلفة وحدة للكمية الزائدة عندما لا يوجد رصيد سابق لتقييمها." },
    STOCKTAKE_POSTING_MOVEMENT_FAILED: { code: "CONFLICT", message: "تعذر إنشاء حركة التسوية الناتجة عن الجرد؛ لم تُرحّل الجلسة." },
    STOCKTAKE_CANCEL_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لإلغاء جلسة الجرد." },
    STOCKTAKE_NOT_CANCELLABLE: { code: "CONFLICT", message: "لا يمكن إلغاء جلسة جرد مُرحّلة أو لها حركات تسوية مرتبطة." },

    STOCK_WAREHOUSE_INACTIVE: { code: "CONFLICT", message: "المخزن موقوف؛ أعد تفعيله قبل تعديل بياناته." },
    WAREHOUSE_DEACTIVATION_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لإيقاف المخزن." },
    WAREHOUSE_HAS_STOCK: { code: "CONFLICT", message: "لا يمكن إيقاف المخزن ما دام يحتوي على كمية أو قيمة مخزون." },
    WAREHOUSE_HAS_OPEN_PURCHASE: { code: "CONFLICT", message: "لا يمكن إيقاف المخزن مع وجود فاتورة شراء مفتوحة مرتبطة به." },
    PURCHASE_LINE_NOT_FOUND: { code: "NOT_FOUND", message: "أحد بنود المشتريات غير موجود." },
    SUPPLIER_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المورد غير نشط أو لا ينتمي إلى الشركة." },
    SUPPLIER_INACTIVE: { code: "CONFLICT", message: "المورد موقوف؛ أعد تفعيله قبل تعديل بياناته." },
    WAREHOUSE_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المخزن غير نشط أو لا يتبع هذا الفرع." },
    ITEM_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "أحد الأصناف غير نشط أو لا ينتمي إلى الشركة." },
    OVER_RECEIPT: { code: "CONFLICT", message: "كمية الاستلام تتجاوز الكمية المتبقية في الفاتورة." },
    PURCHASE_NOT_RECEIVABLE: { code: "CONFLICT", message: "لا يمكن استلام هذه الفاتورة قبل اعتمادها أو بعد اكتمالها." },
    PURCHASE_STATE_CONFLICT: { code: "CONFLICT", message: "حالة فاتورة المشتريات لا تسمح بهذه العملية." },
    PURCHASE_CANNOT_BE_CANCELLED_AFTER_RECEIPT: { code: "CONFLICT", message: "لا يمكن إلغاء فاتورة بعد تسجيل أي استلام أو حركة مخزون." },
    PURCHASE_HAS_POSTED_PAYMENTS: { code: "CONFLICT", message: "لا يمكن إلغاء الفاتورة قبل عكس دفعات المورد المسجلة." },
    PURCHASE_CANCELLATION_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لإلغاء فاتورة المشتريات." },
    SUPPLIER_PAYMENT_NOT_FOUND: { code: "NOT_FOUND", message: "دفعة المورد غير موجودة في هذا الفرع." },
    SUPPLIER_PAYMENT_ALLOCATION_NOT_FOUND: { code: "CONFLICT", message: "لا يوجد تخصيص فاتورة صالح لهذه الدفعة." },
    SUPPLIER_PAYMENT_ALLOCATION_MISMATCH: { code: "CONFLICT", message: "تخصيصات الدفعة لا تطابق مستندات المورد أو سجلاته؛ أوقفنا العملية لحماية الأرصدة." },
    SUPPLIER_PAYMENT_ORIGINAL_TRANSACTION_MISMATCH: { code: "CONFLICT", message: "تعذر مطابقة حركة السحب الأصلية في حساب الشركة؛ لم يُسجل أي عكس." },
    SUPPLIER_PAYMENT_REVERSAL_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لعكس دفعة المورد." },
    SUPPLIER_OPENING_BALANCE_SCOPE_REQUIRED: { code: "BAD_REQUEST", message: "حدد الفرع والمورد والمستخدم لتسجيل الرصيد الافتتاحي." },
    INVALID_SUPPLIER_OPENING_BALANCE: { code: "BAD_REQUEST", message: "قيمة الرصيد الافتتاحي يجب أن تكون موجبة وبمنزلتين عشريتين كحد أقصى." },
    SUPPLIER_OPENING_BALANCE_ALREADY_EXISTS: { code: "CONFLICT", message: "تم تسجيل رصيد افتتاحي لهذا المورد والفرع مسبقًا." },
    SUPPLIER_OPENING_BALANCE_NOT_PAYABLE: { code: "CONFLICT", message: "قيد الرصيد الافتتاحي المحدد غير صالح للتسوية." },
    SUPPLIER_OPENING_BALANCE_EXCEEDED: { code: "CONFLICT", message: "المبلغ المخصص يتجاوز المتبقي من الرصيد الافتتاحي." },
    SUPPLIER_PAYMENT_SCOPE_REQUIRED: { code: "BAD_REQUEST", message: "حدد الفرع والمورد وحساب الشركة لتسجيل الدفعة." },
    INVALID_SUPPLIER_PAYMENT_ALLOCATIONS: { code: "BAD_REQUEST", message: "تحقق من الفواتير والمبالغ المحددة لتوزيع الدفعة." },
    DUPLICATE_OR_INVALID_SUPPLIER_PAYMENT_ALLOCATION: { code: "BAD_REQUEST", message: "لا تكرر الفاتورة أو الرصيد الافتتاحي نفسه ضمن دفعة واحدة." },
    SUPPLIER_PAYMENT_ALLOCATION_TOTAL_MISMATCH: { code: "BAD_REQUEST", message: "مجموع التخصيصات يجب أن يساوي مبلغ الدفعة تمامًا." },
    SUPPLIER_PAYMENT_SUPPLIER_MISMATCH: { code: "FORBIDDEN", message: "يجب أن تكون كل الفواتير والأرصدة المحددة تابعة للمورد نفسه." },

    IDEMPOTENCY_KEY_REUSED: { code: "CONFLICT", message: "مفتاح العملية مستخدم بطلب مختلف؛ أنشئ مفتاحًا جديدًا." },
    DUPLICATE_PURCHASE_LINE: { code: "BAD_REQUEST", message: "لا تكرر بند الفاتورة نفسه ضمن طلب الاستلام الواحد." },
    INVALID_SUPPLIER_PAYMENT_AMOUNT: { code: "BAD_REQUEST", message: "مبلغ دفعة المورد يجب أن يكون موجبًا وبحد أقصى منزلتين عشريتين." },
    COMPANY_ACCOUNT_NOT_FOUND: { code: "NOT_FOUND", message: "حساب الشركة غير موجود." },
    COMPANY_ACCOUNT_INACTIVE: { code: "BAD_REQUEST", message: "حساب الشركة غير نشط ولا يمكن الدفع منه." },
    COMPANY_ACCOUNT_OUT_OF_SCOPE: { code: "FORBIDDEN", message: "حساب الشركة غير متاح لهذا الفرع." },
    INSUFFICIENT_ACCOUNT_BALANCE: { code: "BAD_REQUEST", message: "رصيد حساب الشركة لا يكفي لهذه الدفعة." },
    FINANCIAL_PERIOD_LOCKED: { code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تسجيل هذه الحركة خلال الفترة المقفلة." },
    INVALID_STOCK_MOVEMENT: { code: "BAD_REQUEST", message: "نوع حركة المخزون غير صالح." },
    INVALID_STOCK_QUANTITY: { code: "BAD_REQUEST", message: "أدخل كمية موجبة لا تتجاوز ثلاث منازل عشرية." },
    INVALID_STOCK_UNIT_COST: { code: "BAD_REQUEST", message: "تكلفة الوحدة غير صالحة أو لا تتوافق مع نوع الحركة." },
    STOCK_ADJUSTMENT_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سبب تسوية الجرد." },
    OPENING_BALANCE_ALREADY_EXISTS: { code: "CONFLICT", message: "تم تسجيل رصيد افتتاحي لهذا الصنف في المخزن؛ استخدم تسوية جرد موثقة بدل تكراره." },
    STOCK_UNIT_COST_REQUIRED: { code: "BAD_REQUEST", message: "أدخل تكلفة الوحدة عند إضافة كمية لصنف بلا رصيد سابق." },
    STOCK_ITEM_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "الصنف غير نشط أو لا ينتمي إلى هذه الشركة." },
    STOCK_WAREHOUSE_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المخزن غير نشط أو لا يتبع هذا الفرع." },
    STOCK_GENERATOR_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المولد المحدد لا يتبع هذه الشركة أو الفرع." },
    GENERATOR_REQUIRED: { code: "BAD_REQUEST", message: "اختر المولد المرتبط باستهلاك الوقود." },
    FUEL_ITEM_REQUIRED: { code: "BAD_REQUEST", message: "استهلاك الوقود متاح لأصناف الوقود فقط." },
    INSUFFICIENT_STOCK: { code: "CONFLICT", message: "الكمية المتاحة لا تكفي لهذه الحركة؛ حدّث الرصيد وحاول مجددًا." },
    PURCHASE_BALANCE_EXCEEDED: { code: "CONFLICT", message: "مبلغ الدفعة يتجاوز المتبقي من فاتورة المشتريات." },
    PURCHASE_NOT_PAYABLE: { code: "CONFLICT", message: "لا يمكن دفع فاتورة مسودة أو ملغاة." },
    PURCHASE_HAS_NO_LINES: { code: "BAD_REQUEST", message: "لا يمكن اعتماد فاتورة بلا بنود." },
    SITE_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "الفرع المحدد غير متاح لهذه الشركة." },
  };
  const match = Object.entries(known).find(([key]) => message.includes(key));
  if (match) {
    const [, value] = match;
    throw new TRPCError({ code: value.code, message: value.message });
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: fallback });
}

function mapFuelDatabaseError(error: { code?: string; message?: string } | null, fallback: string): never {
  if (error?.code === "23505") throw new TRPCError({ code: "CONFLICT", message: "سبق تسجيل العملية نفسها؛ حدّث السجل قبل إعادة المحاولة." });
  const message = error?.message ?? "";
  const known: Record<string, { code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND" | "FORBIDDEN"; message: string }> = {
    IDEMPOTENCY_KEY_REUSED: { code: "CONFLICT", message: "مفتاح العملية مستخدم بطلب مختلف." },
    INSUFFICIENT_STOCK: { code: "CONFLICT", message: "رصيد مصدر الوقود لا يكفي للتعبئة." },
    INVENTORY_BALANCE_INVALID: { code: "CONFLICT", message: "رصيد موقع الوقود غير متزن." },
    FUEL_GENERATOR_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المولد لا يتبع هذا الفرع." },
    FUEL_TANK_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "خزان الوقود لا يرتبط بالمولد المحدد." },
    FUEL_SOURCE_LOCATION_INVALID: { code: "BAD_REQUEST", message: "موقع مصدر الوقود غير صالح." },
    FUEL_DESTINATION_TANK_INVALID: { code: "BAD_REQUEST", message: "اختر خزان الوقود المرتبط بالمولد المحدد." },
    FUEL_ITEM_MUST_BE_LITRES: { code: "BAD_REQUEST", message: "اختر صنف وقود وحدته الأساسية اللتر." },
    INVALID_FUEL_FILL: { code: "BAD_REQUEST", message: "تحقق من كمية التعبئة والتاريخ ومستوى الخزان." },
    INVALID_FUEL_READING: { code: "BAD_REQUEST", message: "تحقق من نوع القراءة وقيمتها وتاريخها." },
    FUEL_READING_CORRECTION_TARGET_REQUIRED: { code: "BAD_REQUEST", message: "حدد القراءة السابقة التي تصححها." },
    FUEL_READING_CORRECTION_TARGET_INVALID: { code: "CONFLICT", message: "صحح أحدث قراءة من النوع والخزان نفسيهما فقط." },
    FUEL_READING_CORRECTION_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا موثقًا للتصحيح." },
    OPERATING_HOURS_BACKWARDS: { code: "CONFLICT", message: "عداد ساعات التشغيل رجع إلى قيمة أقل من القراءة السابقة." },
    OPERATING_HOURS_BELOW_PREVIOUS_READING: { code: "CONFLICT", message: "قراءة ساعات التشغيل المصححة لا تتسق مع القراءة السابقة." },
    OPERATING_HOURS_ABOVE_NEXT_READING: { code: "CONFLICT", message: "ساعات التشغيل تتجاوز قراءة لاحقة." },
    OPERATING_HOURS_BELOW_GENERATOR_BASELINE: { code: "CONFLICT", message: "القراءة أقل من القيمة المحفوظة للمولد؛ استخدم تصحيحًا موثقًا." },
    FUEL_TANK_REQUIRED: { code: "BAD_REQUEST", message: "اختر خزانًا لقراءة مستوى الوقود." },
    OPERATING_HOURS_DO_NOT_USE_TANK: { code: "BAD_REQUEST", message: "قراءة ساعات التشغيل لا ترتبط بخزان." },
    INVALID_FUEL_ALERT_SETTINGS: { code: "BAD_REQUEST", message: "أدخل حد مستوى الوقود أو حد الاستهلاك، وتحقق من الحد الأدنى لساعات القياس." },
    FUEL_ALERT_IDEMPOTENCY_KEY_REUSED: { code: "CONFLICT", message: "مفتاح حفظ إعدادات التنبيه استُخدم بإعدادات مختلفة." },
    FUEL_REPORT_TANK_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "الخزان المحدد لا يتبع المولد أو الفرع المحدد." },
    INVALID_FUEL_REPORT_PERIOD: { code: "BAD_REQUEST", message: "نوع فترة التقرير غير صالح." },
    FUEL_REPORT_ANCHOR_DATE_REQUIRED: { code: "BAD_REQUEST", message: "حدد التاريخ المرجعي للفترة." },
    INVALID_FUEL_REPORT_DATE_RANGE: { code: "BAD_REQUEST", message: "نطاق تاريخ التقرير غير صالح." },
    FUEL_ALERT_SITE_REQUIRES_TENANT: { code: "BAD_REQUEST", message: "يجب تحديد المؤسسة مع الفرع." },
    SITE_OUT_OF_SCOPE: { code: "FORBIDDEN", message: "الفرع المحدد غير متاح لحسابك." },
  };
  const match = Object.entries(known).find(([key]) => message.includes(key));
  if (match) throw new TRPCError({ code: match[1].code, message: match[1].message });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: fallback });
}

async function requireFuelReadAccess(userId: number, siteId: number) {
  const access = await resolveSupabaseSiteAccess(userId, siteId);
  const canManageFuel = access.permissions.includes("manageFuelAndConsumption");
  const canViewFuelReports = access.permissions.includes("viewInventoryReports");
  if (!canManageFuel && !canViewFuelReports) {
    throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض سجلات الوقود أو تقاريره." });
  }
  return { ...access, canManageFuel, canViewFuelReports };
}

async function requirePurchaseReadAccess(userId: number, siteId: number) {
  const access = await resolveSupabaseSiteAccess(userId, siteId);
  const canManageSupplierPayments = access.permissions.includes("manageSupplierPayments");
  const canViewFinancials = access.permissions.includes("viewPurchases") || canManageSupplierPayments;
  const canAdjustInventory = access.permissions.includes("adjustInventory");
  if (!canViewFinancials && !access.permissions.includes("receiveInventory") && !canAdjustInventory) {
    throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض المشتريات أو تنفيذ استلام أو مرتجع مخزني." });
  }
  return { ...access, canViewFinancials, canManageSupplierPayments };
}

async function requireStockReadAccess(userId: number, siteId: number) {
  const access = await resolveSupabaseSiteAccess(userId, siteId);
  if (!access.permissions.includes("viewInventory") && !access.permissions.includes("viewInventoryReports")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض أرصدة المخزون وحركاته." });
  }
  return access;
}

async function requireStocktakeReadAccess(userId: number, siteId: number) {
  const access = await resolveSupabaseSiteAccess(userId, siteId);
  const canReadStocktakes = access.permissions.includes("viewStocktakes")
    || access.permissions.includes("manageStocktakes")
    || access.permissions.includes("approveStocktakes");
  if (!canReadStocktakes) {
    throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض جلسات الجرد." });
  }
  return access;
}

const purchaseStatusSchema = z.enum(["draft", "confirmed", "partially_received", "received", "cancelled"]);
const purchaseLineInputSchema = z.object({
  itemId: z.number().int().positive(),
  quantity: z.number().finite().positive().max(1_000_000_000),
  unit: z.string().trim().min(1).max(40),
  unitsToBaseFactor: z.number().finite().positive().max(1_000_000),
  unitPrice: z.number().finite().min(0).max(1_000_000_000),
  discountAmount: z.number().finite().min(0).max(1_000_000_000).default(0),
  taxAmount: z.number().finite().min(0).max(1_000_000_000).default(0),
  notes: z.string().trim().max(1000).optional(),
});

export const powerhubInventoryRouter = router({
  stockOverview: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireStockReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_stock_overview", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أرصدة المخزون." });
      if (access.permissions.includes("viewInventoryReports")) return data ?? [];
      return (data ?? []).map((row: InventoryStockOverviewRow) => {
        const { stock_value: _stockValue, average_unit_cost: _averageUnitCost, ...visible } = row;
        return visible;
      });
    }),

  listStockMovements: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ ctx, input }) => {
      const access = await requireStockReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_list_stock_movements", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_limit: input.limit,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل حركات المخزون." });
      if (access.permissions.includes("viewInventoryReports")) return data ?? [];
      return (data ?? []).map((row: InventoryStockMovementRow) => {
        const { unit_cost: _unitCost, total_cost_amount: _totalCostAmount, ...visible } = row;
        return visible;
      });
    }),

  listInventoryReportWarehouses: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireStockReadAccess(ctx.user.id, input.siteId);
      if (!access.permissions.includes("viewInventoryReports")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض تقارير المخزون." });
      }
      const { data, error } = await supabaseAdmin().from("inventory_warehouses")
        .select("id,code,name")
        .eq("tenant_id", access.tenantId)
        .eq("site_id", input.siteId)
        .eq("is_active", true)
        .order("name", { ascending: true })
        .limit(200);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مخازن التقرير." });
      return (data ?? []).map((row: { id: number; code: string; name: string }) => ({
        id: row.id, code: row.code, name: row.name,
      }));
    }),

  listStockMovementReport: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      limit: z.number().int().min(1).max(200).default(100),
      beforeOccurredAt: z.string().datetime({ offset: true }).optional(),
      beforeMovementId: z.number().int().positive().optional(),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      warehouseId: z.number().int().positive().optional(),
      search: z.string().trim().max(150).optional(),
    }).refine((value) => Boolean(value.beforeOccurredAt) === Boolean(value.beforeMovementId), {
      message: "مؤشر صفحة الحركات غير مكتمل.",
    }).refine((value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate, {
      message: "نطاق تاريخ الحركات غير صحيح.",
    }))
    .query(async ({ ctx, input }) => {
      const access = await requireStockReadAccess(ctx.user.id, input.siteId);
      if (!access.permissions.includes("viewInventoryReports")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض أو تصدير تقارير المخزون." });
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_list_stock_movement_report", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_limit: input.limit + 1,
        p_before_occurred_at: input.beforeOccurredAt ?? null,
        p_before_movement_id: input.beforeMovementId ?? null,
        p_from_date: input.fromDate ?? null,
        p_to_date: input.toDate ?? null,
        p_warehouse_id: input.warehouseId ?? null,
        p_search: input.search?.trim() || null,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تقرير حركات المخزون." });
      const rows = (data ?? []) as InventoryStockMovementRow[];
      const hasMore = rows.length > input.limit;
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
      const itemIds = [...new Set(pageRows.map((row) => Number(row.item_id)))];
      const categoryResult = itemIds.length
        ? await supabaseAdmin().from("inventory_items").select("id,category")
            .eq("tenant_id", access.tenantId).in("id", itemIds)
        : { data: [], error: null };
      if (categoryResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تصنيفات أصناف الحركات." });
      }
      const categoryByItemId = new Map<number, string>((categoryResult.data ?? []).map((row) => [Number(row.id), row.category] as const));
      const items = pageRows.map((row) => ({
        movement_id: row.movement_id,
        warehouse_id: row.warehouse_id,
        warehouse_code: row.warehouse_code,
        warehouse_name: row.warehouse_name,
        item_id: row.item_id,
        sku: row.sku,
        item_name: row.item_name,
        category: categoryByItemId.get(Number(row.item_id)) ?? "other",
        base_unit: row.base_unit,
        generator_id: row.generator_id,
        movement_type: row.movement_type,
        quantity: row.quantity,
        total_cost_amount: row.total_cost_amount,
        reference_no: row.reference_no,
        notes: row.notes,
        occurred_at: row.occurred_at,
      }));
      const last = pageRows[pageRows.length - 1];
      return {
        items,
        hasMore,
        nextCursor: hasMore && last ? { beforeOccurredAt: last.occurred_at, beforeMovementId: Number(last.movement_id) } : null,
      };
    }),

  recordStockMovement: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      warehouseId: z.number().int().positive(),
      itemId: z.number().int().positive(),
      movementType: z.enum(["issue", "opening_balance", "adjustment_in", "adjustment_out", "fuel_consumption"]),
      quantity: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "الكمية تقبل ثلاث منازل عشرية كحد أقصى."),
      unitCost: z.number().finite().min(0).max(1_000_000_000)
        .refine((value) => Math.abs(value * 10000 - Math.round(value * 10000)) < 1e-7, "تكلفة الوحدة تقبل أربع منازل عشرية كحد أقصى.")
        .optional(),
      generatorId: z.number().int().positive().optional(),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      operationKey: z.string().trim().min(1).max(180),
    }).refine((value) =>
      (["adjustment_in", "opening_balance"].includes(value.movementType) || value.unitCost === undefined),
      { message: "تكلفة الوحدة المدخلة تستخدم فقط عند الرصيد الافتتاحي أو تسوية زيادة المخزون.", path: ["unitCost"] }
    ).refine((value) =>
      (value.movementType !== "opening_balance" || value.unitCost !== undefined),
      { message: "أدخل تكلفة الوحدة للرصيد الافتتاحي.", path: ["unitCost"] }
    ).refine((value) =>
      (value.movementType !== "fuel_consumption" || value.generatorId !== undefined),
      { message: "اختر المولد المرتبط باستهلاك الوقود.", path: ["generatorId"] }
    ).refine((value) =>
      (!["opening_balance", "adjustment_in", "adjustment_out"].includes(value.movementType) || Boolean(value.notes?.trim())),
      { message: "أدخل سبب تسوية الجرد.", path: ["notes"] }
    ))
    .mutation(async ({ ctx, input }) => {
      const requiredCapability = input.movementType === "issue"
        ? "issueInventory"
        : input.movementType === "fuel_consumption"
          ? "manageFuelAndConsumption"
          : "adjustInventory";
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], requiredCapability);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_record_stock_movement", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_warehouse_id: input.warehouseId,
        p_item_id: input.itemId,
        p_movement_type: input.movementType,
        p_quantity: input.quantity,
        p_unit_cost: input.unitCost ?? null,
        p_generator_id: input.generatorId ?? null,
        p_reference_no: input.referenceNo || null,
        p_notes: input.notes || null,
        p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تسجيل حركة المخزون.");
      return data[0];
    }),


  returnFromIssue: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      sourceIssueMovementId: z.number().int().positive(),
      quantity: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "الكمية تقبل ثلاث منازل عشرية كحد أقصى."),
      reason: z.string().trim().min(3).max(500),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      operationKey: z.string().trim().min(1).max(180),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "adjustInventory");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_return_from_issue", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_source_issue_movement_id: input.sourceIssueMovementId,
        p_quantity: input.quantity,
        p_reason: input.reason,
        p_reference_no: input.referenceNo || null,
        p_notes: input.notes || null,
        p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر إرجاع الصرف إلى المخزون.");
      return data[0];
    }),

  correctStockMovement: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      movementId: z.number().int().positive(),
      quantity: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "الكمية تقبل ثلاث منازل عشرية كحد أقصى."),
      unitCost: z.number().finite().min(0).max(1_000_000_000)
        .refine((value) => Math.abs(value * 10000 - Math.round(value * 10000)) < 1e-7, "تكلفة الوحدة تقبل أربع منازل عشرية كحد أقصى.")
        .optional(),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      reason: z.string().trim().min(3).max(500),
      operationKey: z.string().trim().min(1).max(160),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "adjustInventory");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_correct_stock_movement", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_movement_id: input.movementId,
        p_quantity: input.quantity,
        p_unit_cost: input.unitCost ?? null,
        p_reference_no: input.referenceNo || null,
        p_notes: input.notes || null,
        p_reason: input.reason,
        p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تصحيح حركة المخزون.");
      return data[0];
    }),

  listItems: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), search: z.string().trim().max(100).optional(), includeInactive: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewInventory");
      let query = supabaseAdmin().from("inventory_items")
        .select("id,tenant_id,sku,name,category,base_unit,reorder_point,specification,notes,is_active,created_at,updated_at")
        .eq("tenant_id", access.tenantId)
        .order("name", { ascending: true })
        .limit(500);
      if (!input.includeInactive) query = query.eq("is_active", true);
      if (input.search) {
        const safeSearch = input.search.replace(/[%,*()]/g, " ").replace(/[,]/g, " ").trim();
        if (safeSearch) query = query.or(`name.ilike.%${safeSearch}%,sku.ilike.%${safeSearch}%`);
      }
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل دليل الأصناف." });
      return data ?? [];
    }),

  createItem: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      sku: z.string().trim().max(80).optional(),
      name: z.string().trim().min(1).max(180),
      category: categorySchema,
      baseUnit: unitSchema,
      reorderPoint: z.number().finite().min(0).max(1_000_000_000).default(0),
      specification: z.string().trim().max(500).optional(),
      notes: z.string().trim().max(2000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "createInventoryItems");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_create_item", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_sku: input.sku || null,
        p_name: input.name,
        p_category: input.category,
        p_base_unit: input.baseUnit,
        p_reorder_point: input.reorderPoint,
        p_specification: input.specification || null,
        p_notes: input.notes || null,
      });
      if (error || !data?.[0]) mapDatabaseError(error, "تعذر إضافة الصنف إلى الدليل الموحد.");
      return data[0];
    }),


  updateItem: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(), itemId: z.number().int().positive(),
      sku: z.string().trim().max(80).optional(),
      name: z.string().trim().min(1).max(180), category: categorySchema, baseUnit: unitSchema,
      reorderPoint: z.number().finite().min(0).max(1_000_000_000),
      specification: z.string().trim().max(500).optional(), notes: z.string().trim().max(2000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "editInventoryItems");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_update_item", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_item_id: input.itemId, p_sku: input.sku || null, p_name: input.name, p_category: input.category,
        p_base_unit: input.baseUnit, p_reorder_point: input.reorderPoint,
        p_specification: input.specification || null, p_notes: input.notes || null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تعديل الصنف.");
      return data[0];
    }),

  setItemActive: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(), itemId: z.number().int().positive(),
      isActive: z.boolean(), reason: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "deactivateInventoryItems");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_set_item_active", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_item_id: input.itemId, p_is_active: input.isActive, p_reason: input.reason || null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تغيير حالة الصنف.");
      return data[0];
    }),

  listItemUnits: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), itemId: z.number().int().positive(), includeInactive: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewInventory");
      const item = await supabaseAdmin().from("inventory_items").select("id")
        .eq("tenant_id", access.tenantId).eq("id", input.itemId).maybeSingle();
      if (item.error || !item.data) throw new TRPCError({ code: "NOT_FOUND", message: "الصنف غير موجود في هذا الفرع." });
      let query = supabaseAdmin().from("inventory_item_units")
        .select("id,tenant_id,item_id,unit_label,factor_to_base,is_active,created_at,updated_at")
        .eq("tenant_id", access.tenantId).eq("item_id", input.itemId)
        .order("unit_label", { ascending: true }).limit(100);
      if (!input.includeInactive) query = query.eq("is_active", true);
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل وحدات شراء الصنف." });
      return data ?? [];
    }),

  createItemUnit: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(), itemId: z.number().int().positive(),
      unitLabel: z.string().trim().min(1).max(40),
      factorToBase: z.number().finite().positive().max(99_999_999.999999)
        .refine((value) => Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) < 1e-5,
          "معامل التحويل يقبل 6 منازل عشرية كحد أقصى."),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "createInventoryItems");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_create_item_unit", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_item_id: input.itemId,
        p_user_id: ctx.user.id, p_unit_label: input.unitLabel, p_factor_to_base: input.factorToBase,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر إضافة وحدة شراء للصنف.");
      return data[0];
    }),

  setItemUnitActive: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(), itemId: z.number().int().positive(), unitId: z.number().int().positive(),
      isActive: z.boolean(), reason: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "deactivateInventoryItems");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_set_item_unit_active", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_item_id: input.itemId, p_unit_id: input.unitId,
        p_user_id: ctx.user.id, p_is_active: input.isActive, p_reason: input.reason || null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تغيير حالة وحدة الشراء.");
      return data[0];
    }),

  listSuppliers: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), search: z.string().trim().max(100).optional(), includeInactive: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewSuppliers");
      let query = supabaseAdmin().from("suppliers")
        .select("id,tenant_id,supplier_code,name,contact_name,phone,email,address,tax_number,default_payment_terms_days,supplier_type,notes,is_active,created_at,updated_at")
        .eq("tenant_id", access.tenantId)
        .order("name", { ascending: true })
        .limit(500);
      if (!input.includeInactive) query = query.eq("is_active", true);
      if (input.search) {
        const safeSearch = input.search.replace(/[%,*()]/g, " ").replace(/[,]/g, " ").trim();
        if (safeSearch) query = query.or(`name.ilike.%${safeSearch}%,supplier_code.ilike.%${safeSearch}%,phone.ilike.%${safeSearch}%`);
      }
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل دليل الموردين." });
      return data ?? [];
    }),

  createSupplier: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      supplierCode: z.string().trim().max(80).optional(),
      name: z.string().trim().min(1).max(180),
      contactName: z.string().trim().max(180).optional(),
      phone: z.string().trim().max(40).optional(),
      email: z.string().trim().email().max(254).optional().or(z.literal("")),
      address: z.string().trim().max(500).optional(),
      taxNumber: z.string().trim().max(100).optional(),
      defaultPaymentTermsDays: z.number().int().min(0).max(3650).default(0),
      supplierType: z.enum(["permanent", "one_time"]).default("permanent"),
      notes: z.string().trim().max(2000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "createSuppliers");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_create_supplier_with_type", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_supplier_code: input.supplierCode || null,
        p_name: input.name,
        p_contact_name: input.contactName || null,
        p_phone: input.phone || null,
        p_email: input.email || null,
        p_address: input.address || null,
        p_tax_number: input.taxNumber || null,
        p_default_payment_terms_days: input.defaultPaymentTermsDays,
        p_notes: input.notes || null,
        p_supplier_type: input.supplierType ?? "permanent",
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر إضافة المورد.");
      return data[0];
    }),


  updateSupplier: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(), supplierId: z.number().int().positive(),
      supplierCode: z.string().trim().max(80).optional(), name: z.string().trim().min(1).max(180),
      contactName: z.string().trim().max(180).optional(), phone: z.string().trim().max(40).optional(),
      email: z.string().trim().email().max(254).optional().or(z.literal("")),
      address: z.string().trim().max(500).optional(), taxNumber: z.string().trim().max(100).optional(),
      defaultPaymentTermsDays: z.number().int().min(0).max(3650),
      supplierType: z.enum(["permanent", "one_time"]).default("permanent"), notes: z.string().trim().max(2000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "editSuppliers");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_update_supplier_with_type", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_supplier_id: input.supplierId, p_supplier_code: input.supplierCode || null, p_name: input.name,
        p_contact_name: input.contactName || null, p_phone: input.phone || null, p_email: input.email || null,
        p_address: input.address || null, p_tax_number: input.taxNumber || null,
        p_default_payment_terms_days: input.defaultPaymentTermsDays, p_notes: input.notes || null,
        p_supplier_type: input.supplierType ?? "permanent",
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تعديل بيانات المورد.");
      return data[0];
    }),

  setSupplierActive: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(), supplierId: z.number().int().positive(),
      isActive: z.boolean(), reason: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "deactivateSuppliers");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_set_supplier_active", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_supplier_id: input.supplierId, p_is_active: input.isActive, p_reason: input.reason || null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تغيير حالة المورد.");
      return data[0];
    }),

  listWarehouses: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), includeInactive: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewInventory");
      let query = supabaseAdmin().from("inventory_warehouses")
        .select("id,tenant_id,site_id,code,name,notes,is_active,location_type,generator_id,created_at,updated_at")
        .eq("tenant_id", access.tenantId)
        .eq("site_id", input.siteId)
        .order("name", { ascending: true })
        .limit(200);
      if (!input.includeInactive) query = query.eq("is_active", true);
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قائمة المخازن." });
      return data ?? [];
    }),

  createWarehouse: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      code: z.string().trim().min(1).max(40),
      name: z.string().trim().min(1).max(120),
      notes: z.string().trim().max(2000).optional(),
      locationType: z.enum(["central_warehouse", "branch_warehouse", "fixed_fuel_tank", "generator_fuel_tank"]).default("branch_warehouse"),
      generatorId: z.number().int().positive().optional(),
    }).superRefine((value, issue) => {
      if ((value.locationType === "generator_fuel_tank") !== (value.generatorId !== undefined)) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: ["generatorId"], message: "خزان المولد يتطلب اختيار مولد واحد، ولا يقبل الأنواع الأخرى ربط مولد." });
      }
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "createWarehouses");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_create_warehouse_with_location", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_code: input.code,
        p_name: input.name,
        p_notes: input.notes || null,
        p_location_type: input.locationType,
        p_generator_id: input.generatorId ?? null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر إنشاء موقع التخزين.");
      return data[0];
    }),


  updateWarehouse: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(), warehouseId: z.number().int().positive(),
      code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(120),
      notes: z.string().trim().max(2000).optional(),
      locationType: z.enum(["central_warehouse", "branch_warehouse", "fixed_fuel_tank", "generator_fuel_tank"]),
      generatorId: z.number().int().positive().optional(),
    }).superRefine((value, issue) => {
      if ((value.locationType === "generator_fuel_tank") !== (value.generatorId !== undefined)) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: ["generatorId"], message: "خزان المولد يتطلب اختيار مولد واحد، ولا يقبل الأنواع الأخرى ربط مولد." });
      }
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "editWarehouses");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_update_warehouse_with_location", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_warehouse_id: input.warehouseId, p_code: input.code, p_name: input.name, p_notes: input.notes || null,
        p_location_type: input.locationType, p_generator_id: input.generatorId ?? null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تعديل موقع التخزين.");
      return data[0];
    }),

  setWarehouseActive: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(), warehouseId: z.number().int().positive(),
      isActive: z.boolean(), reason: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "deactivateWarehouses");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_set_warehouse_active", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_warehouse_id: input.warehouseId, p_is_active: input.isActive, p_reason: input.reason || null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تغيير حالة المخزن.");
      return data[0];
    }),

  listPurchaseOptions: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "createPurchases");
      const [supplierResult, warehouseResult, itemResult, unitResult] = await Promise.all([
        supabaseAdmin().from("suppliers").select("id,name,supplier_code,supplier_type,default_payment_terms_days")
          .eq("tenant_id", access.tenantId).eq("is_active", true).order("name", { ascending: true }).limit(300),
        supabaseAdmin().from("inventory_warehouses").select("id,name,code")
          .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("is_active", true).order("name", { ascending: true }).limit(200),
        supabaseAdmin().from("inventory_items").select("id,name,sku,base_unit")
          .eq("tenant_id", access.tenantId).eq("is_active", true).order("name", { ascending: true }).limit(500),
        supabaseAdmin().from("inventory_item_units").select("id,item_id,unit_label,factor_to_base")
          .eq("tenant_id", access.tenantId).eq("is_active", true).order("unit_label", { ascending: true }).limit(2000),
      ]);
      if (supplierResult.error || warehouseResult.error || itemResult.error || unitResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل خيارات إنشاء المشتريات." });
      }
      return {
        suppliers: supplierResult.data ?? [],
        warehouses: warehouseResult.data ?? [],
        items: itemResult.data ?? [],
        units: unitResult.data ?? [],
      };
    }),

  listSupplierPaymentOptions: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments");
      const { data: accountRows, error: accountError } = await supabaseAdmin().from("company_accounts")
        .select("id,tenant_id,name,account_type,is_active")
        .eq("tenant_id", access.tenantId).eq("is_active", true)
        .order("name", { ascending: true }).limit(500);
      if (accountError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حسابات الشركة المتاحة للدفع." });
      const rows = accountRows ?? [];
      if (!rows.length) return [];
      const accountIds = rows.map((account) => Number(account.id));
      const { data: siteLinks, error: siteLinksError } = await supabaseAdmin().from("company_account_sites")
        .select("account_id,site_id").eq("tenant_id", access.tenantId).in("account_id", accountIds);
      if (siteLinksError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من ربط الحسابات بالفروع." });
      const linksByAccount = new Map<number, number[]>();
      for (const link of siteLinks ?? []) {
        const id = Number(link.account_id);
        linksByAccount.set(id, [...(linksByAccount.get(id) ?? []), Number(link.site_id)]);
      }
      // No links means a tenant-wide company account. Explicitly linked accounts
      // are shown only for one of their configured branches.
      const visible = rows.filter((account) => {
        const sites = linksByAccount.get(Number(account.id)) ?? [];
        return sites.length === 0 || sites.includes(input.siteId);
      });
      if (!visible.length) return [];
      const visibleIds = visible.map((account) => Number(account.id));
      const { data: balances, error: balanceError } = await supabaseAdmin().rpc("powerhub_company_account_balance_rollup", {
        p_tenant_id: access.tenantId, p_account_ids: visibleIds,
      });
      if (balanceError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر احتساب الأرصدة الحالية لحسابات الشركة." });
      const balanceById = new Map<number, number>((balances ?? []).map((row: { account_id: number | string; balance: number | string }) => [
        Number(row.account_id), Number(row.balance),
      ]));
      return visible.map((account) => {
        const balance = balanceById.get(Number(account.id));
        if (balance === undefined || !Number.isFinite(balance)) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم يُرجع حساب الشركة رصيدًا صالحًا." });
        }
        return { id: Number(account.id), name: account.name, accountType: account.account_type, balance };
      });
    }),

  listPurchases: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), search: z.string().trim().max(100).optional(), status: purchaseStatusSchema.optional() }))
    .query(async ({ ctx, input }) => {
      const access = await requirePurchaseReadAccess(ctx.user.id, input.siteId);
      let query = supabaseAdmin().from("supplier_purchases")
        .select("id,tenant_id,site_id,supplier_id,warehouse_id,purchase_number,supplier_invoice_no,invoice_date,due_date,payment_mode,status,subtotal_amount,discount_amount,tax_amount,other_charges_amount,total_amount,payment_terms_days,reference_no,notes,operation_key,received_at,received_by_user_id,confirmed_at,confirmed_by_user_id,created_by_user_id,created_at,updated_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
        .order("invoice_date", { ascending: false }).order("id", { ascending: false }).limit(200);
      if (!access.canViewFinancials) query = query.in("status", ["confirmed", "partially_received", "received"]);
      if (input.status) query = query.eq("status", input.status);
      if (input.search) {
        const safeSearch = input.search.replace(/[%,*(),]/g, " ").trim();
        if (safeSearch) query = query.or(`purchase_number.ilike.%${safeSearch}%,supplier_invoice_no.ilike.%${safeSearch}%,reference_no.ilike.%${safeSearch}%`);
      }
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل فواتير المشتريات." });
      const purchases = data ?? [];
      if (!purchases.length) return [];
      const supplierIds = [...new Set(purchases.map((purchase) => Number(purchase.supplier_id)))];
      const warehouseIds = [...new Set(purchases.map((purchase) => Number(purchase.warehouse_id)))];
      const [supplierResult, warehouseResult] = await Promise.all([
        supabaseAdmin().from("suppliers").select("id,name,supplier_code").eq("tenant_id", access.tenantId).in("id", supplierIds),
        supabaseAdmin().from("inventory_warehouses").select("id,name,code").eq("tenant_id", access.tenantId).in("id", warehouseIds),
      ]);
      if (supplierResult.error || warehouseResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات الموردين والمخازن المرتبطة بالمشتريات." });
      }
      const suppliers = new Map((supplierResult.data ?? []).map((row) => [Number(row.id), row]));
      const warehouses = new Map((warehouseResult.data ?? []).map((row) => [Number(row.id), row]));
      return purchases.map((purchase) => ({
        ...purchase,
        supplierName: suppliers.get(Number(purchase.supplier_id))?.name ?? "مورد غير متاح",
        supplierCode: suppliers.get(Number(purchase.supplier_id))?.supplier_code ?? null,
        warehouseName: warehouses.get(Number(purchase.warehouse_id))?.name ?? "مخزن غير متاح",
        canViewFinancials: access.canViewFinancials,
        ...(access.canViewFinancials ? {} : {
          supplier_invoice_no: null, due_date: null, subtotal_amount: null, discount_amount: null,
          tax_amount: null, other_charges_amount: null, total_amount: null, payment_terms_days: null,
          reference_no: null, notes: null,
        }),
      }));
    }),

  getPurchase: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), purchaseId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requirePurchaseReadAccess(ctx.user.id, input.siteId);
      const { data: purchase, error: purchaseError } = await supabaseAdmin().from("supplier_purchases")
        .select("id,tenant_id,site_id,supplier_id,warehouse_id,purchase_number,supplier_invoice_no,invoice_date,due_date,payment_mode,status,subtotal_amount,discount_amount,tax_amount,other_charges_amount,total_amount,payment_terms_days,reference_no,notes,operation_key,received_at,received_by_user_id,confirmed_at,confirmed_by_user_id,cancelled_at,cancelled_by_user_id,created_by_user_id,created_at,updated_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("id", input.purchaseId).maybeSingle();
      if (purchaseError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل فاتورة المشتريات." });
      if (!purchase || (!access.canViewFinancials && !["confirmed", "partially_received", "received"].includes(purchase.status))) {
        throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة المشتريات غير موجودة في هذا الفرع." });
      }
      const [lineResult, receiptResult, returnResult, returnCreditResult, supplierResult, warehouseResult] = await Promise.all([
        supabaseAdmin().from("supplier_purchase_lines")
          .select("id,tenant_id,purchase_id,item_id,quantity,unit,units_to_base_factor,unit_price,discount_amount,tax_amount,line_subtotal,line_total,received_quantity,notes,created_at,updated_at")
          .eq("tenant_id", access.tenantId).eq("purchase_id", input.purchaseId).order("id", { ascending: true }),
        supabaseAdmin().from("supplier_purchase_receipts")
          .select("id,receipt_number,receipt_date,operation_key,notes,received_at,received_by_user_id,created_at")
          .eq("tenant_id", access.tenantId).eq("purchase_id", input.purchaseId).order("id", { ascending: false }).limit(100),
        supabaseAdmin().from("supplier_purchase_returns")
          .select("id,return_number,return_date,status,reason,notes,total_credit_amount,stock_cost_amount,refund_amount,refund_company_account_id,returned_at,operation_key")
          .eq("tenant_id", access.tenantId).eq("purchase_id", input.purchaseId).order("id", { ascending: false }).limit(100),
        supabaseAdmin().rpc("powerhub_inventory_purchase_supplier_return_credit", {
          p_tenant_id: access.tenantId, p_purchase_id: input.purchaseId,
        }),
        supabaseAdmin().from("suppliers").select("id,name,supplier_code")
          .eq("tenant_id", access.tenantId).eq("id", purchase.supplier_id).maybeSingle(),
        supabaseAdmin().from("inventory_warehouses").select("id,name,code")
          .eq("tenant_id", access.tenantId).eq("id", purchase.warehouse_id).maybeSingle(),
      ]);
      if (lineResult.error || receiptResult.error || returnResult.error || supplierResult.error || warehouseResult.error || returnCreditResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل البنود والاستلام والمرتجعات وأثرها على المستحق." });
      }
      const itemIds = [...new Set((lineResult.data ?? []).map((line) => Number(line.item_id)))];
      const itemResult = itemIds.length
        ? await supabaseAdmin().from("inventory_items").select("id,name,sku,base_unit").eq("tenant_id", access.tenantId).in("id", itemIds)
        : { data: [], error: null };
      if (itemResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء الأصناف." });
      const items = new Map((itemResult.data ?? []).map((item) => [Number(item.id), item]));
      const returnIds = (returnResult.data ?? []).map((row) => Number(row.id));
      const returnLinesResult = returnIds.length
        ? await supabaseAdmin().from("supplier_purchase_return_lines")
          .select("id,return_id,purchase_line_id,stock_movement_id,quantity,base_quantity,supplier_credit_amount,inventory_unit_cost,stock_cost_amount")
          .eq("tenant_id", access.tenantId).in("return_id", returnIds).order("id", { ascending: true })
        : { data: [], error: null };
      if (returnLinesResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بنود مرتجعات المورد." });
      const purchaseLinesById = new Map((lineResult.data ?? []).map((line) => [Number(line.id), line]));
      type SupplierPurchaseReturnLineView = {
        id: number;
        return_id: number;
        purchase_line_id: number;
        stock_movement_id: number;
        quantity: number;
        base_quantity: number;
        supplier_credit_amount: number | null;
        inventory_unit_cost: number | null;
        stock_cost_amount: number | null;
        itemName: string;
        unit: string;
      };
      const returnLinesByReturn = new Map<number, SupplierPurchaseReturnLineView[]>();
      for (const line of returnLinesResult.data ?? []) {
        const returnId = Number(line.return_id);
        const purchaseLine = purchaseLinesById.get(Number(line.purchase_line_id));
        const item = purchaseLine ? items.get(Number(purchaseLine.item_id)) : undefined;
        const visibleLine: SupplierPurchaseReturnLineView = {
          id: Number(line.id),
          return_id: returnId,
          purchase_line_id: Number(line.purchase_line_id),
          stock_movement_id: Number(line.stock_movement_id),
          quantity: Number(line.quantity),
          base_quantity: Number(line.base_quantity),
          supplier_credit_amount: access.canViewFinancials ? Number(line.supplier_credit_amount ?? 0) : null,
          inventory_unit_cost: access.canViewFinancials ? Number(line.inventory_unit_cost ?? 0) : null,
          stock_cost_amount: access.canViewFinancials ? Number(line.stock_cost_amount ?? 0) : null,
          itemName: item?.name ?? "صنف غير متاح",
          unit: purchaseLine?.unit ?? "",
        };
        returnLinesByReturn.set(returnId, [...(returnLinesByReturn.get(returnId) ?? []), visibleLine]);
      }
      const returns = (returnResult.data ?? []).map((row) => {
        const returnId = Number(row.id);
        return {
          id: returnId,
          return_number: String(row.return_number ?? ""),
          return_date: String(row.return_date ?? ""),
          status: String(row.status ?? ""),
          reason: String(row.reason ?? ""),
          notes: typeof row.notes === "string" ? row.notes : null,
          total_credit_amount: access.canViewFinancials ? Number(row.total_credit_amount ?? 0) : null,
          stock_cost_amount: access.canViewFinancials ? Number(row.stock_cost_amount ?? 0) : null,
          refund_amount: access.canViewFinancials ? Number(row.refund_amount ?? 0) : null,
          refund_company_account_id: access.canViewFinancials && row.refund_company_account_id != null
            ? Number(row.refund_company_account_id) : null,
          returned_at: typeof row.returned_at === "string" ? row.returned_at : null,
          operation_key: String(row.operation_key ?? ""),
          lines: returnLinesByReturn.get(returnId) ?? [],
        };
      });
      const supplierReturnCreditAmount = access.canViewFinancials
        ? Number(returnCreditResult.data ?? 0)
        : null;

      let payments: Array<{
        id: number; amount: number; allocated_amount: number; payment_date: string;
        reference_no: string | null; company_account_id: number; company_account_name: string;
        account_transaction_id: number | null; posted_at: string | null;
        status: "posted" | "reversed"; reversal_reason: string | null;
      }> = [];
      let paidAmount = 0;
      if (access.canViewFinancials) {
        const { data: allocations, error: allocationError } = await supabaseAdmin().from("supplier_payment_allocations")
          .select("payment_id,amount").eq("tenant_id", access.tenantId).eq("purchase_id", input.purchaseId)
          .order("id", { ascending: false }).limit(200);
        if (allocationError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تخصيصات دفعات المورد." });
        const allocationByPayment = new Map<number, number>();
        for (const allocation of allocations ?? []) {
          const id = Number(allocation.payment_id);
          allocationByPayment.set(id, (allocationByPayment.get(id) ?? 0) + Number(allocation.amount));
        }
        const paymentIds = [...allocationByPayment.keys()];
        if (paymentIds.length) {
          const { data: paymentRows, error: paymentError } = await supabaseAdmin().from("supplier_payments")
            .select("id,amount,payment_date,reference_no,company_account_id,account_transaction_id,posted_at,status,reversal_reason")
            .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).in("id", paymentIds)
            .order("payment_date", { ascending: false }).order("id", { ascending: false });
          if (paymentError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل دفعات المورد." });
          const visiblePayments = paymentRows ?? [];
          const accountIds = [...new Set(visiblePayments.map((payment) => Number(payment.company_account_id)))];
          const { data: accountRows, error: accountError } = accountIds.length
            ? await supabaseAdmin().from("company_accounts").select("id,name")
              .eq("tenant_id", access.tenantId).in("id", accountIds)
            : { data: [], error: null };
          if (accountError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء حسابات دفعات المورد." });
          const accountNames = new Map((accountRows ?? []).map((account) => [Number(account.id), account.name]));
          payments = visiblePayments.map((payment) => ({
            id: Number(payment.id),
            amount: Number(payment.amount),
            allocated_amount: allocationByPayment.get(Number(payment.id)) ?? 0,
            payment_date: payment.payment_date,
            reference_no: payment.reference_no ?? null,
            company_account_id: Number(payment.company_account_id),
            company_account_name: accountNames.get(Number(payment.company_account_id)) ?? "حساب غير متاح",
            account_transaction_id: payment.account_transaction_id == null ? null : Number(payment.account_transaction_id),
            posted_at: payment.posted_at ?? null,
            status: payment.status as "posted" | "reversed",
            reversal_reason: payment.reversal_reason ?? null,
          }));
          paidAmount = payments.filter((payment) => payment.status === "posted")
            .reduce((sum, payment) => sum + payment.allocated_amount, 0);
        }
      }
      return {
        purchase: {
          ...purchase,
          supplierName: supplierResult.data?.name ?? "مورد غير متاح",
          supplierCode: supplierResult.data?.supplier_code ?? null,
          warehouseName: warehouseResult.data?.name ?? "مخزن غير متاح",
          canViewFinancials: access.canViewFinancials,
          ...(access.canViewFinancials ? {
            paidAmount,
            supplierReturnCreditAmount,
            outstandingAmount: Math.max(0, Number(purchase.total_amount) - paidAmount - Number(supplierReturnCreditAmount ?? 0)),
          } : {
            supplier_invoice_no: null, due_date: null, subtotal_amount: null, discount_amount: null, tax_amount: null,
            other_charges_amount: null, total_amount: null, payment_terms_days: null, reference_no: null, notes: null,
            paidAmount: null, supplierReturnCreditAmount: null, outstandingAmount: null,
          }),
        },
        canViewFinancials: access.canViewFinancials,
        payments,
        lines: (lineResult.data ?? []).map((line) => ({
          ...line,
          ...(access.canViewFinancials ? {} : {
            unit_price: null, discount_amount: null, tax_amount: null, line_subtotal: null, line_total: null, notes: null,
          }),
          itemName: items.get(Number(line.item_id))?.name ?? "صنف غير متاح",
          itemSku: items.get(Number(line.item_id))?.sku ?? null,
          baseUnit: items.get(Number(line.item_id))?.base_unit ?? null,
        })),
        receipts: receiptResult.data ?? [],
        returns,
      };
    }),

  createPurchase: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      supplierId: z.number().int().positive(),
      warehouseId: z.number().int().positive(),
      supplierInvoiceNo: z.string().trim().max(120).optional(),
      invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      paymentTermsDays: z.number().int().min(0).max(3650).optional(),
      paymentMode: z.enum(["immediate", "deferred"]).default("deferred"),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      operationKey: z.string().trim().min(1).max(180),
      lines: z.array(purchaseLineInputSchema).min(1).max(200),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "createPurchases");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_create_purchase", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_supplier_id: input.supplierId, p_warehouse_id: input.warehouseId,
        p_supplier_invoice_no: input.supplierInvoiceNo || null,
        p_invoice_date: input.invoiceDate || null, p_due_date: input.dueDate || null,
        p_payment_terms_days: input.paymentTermsDays ?? null,
        p_payment_mode: input.paymentMode ?? "deferred",
        p_reference_no: input.referenceNo || null, p_notes: input.notes || null,
        p_operation_key: input.operationKey,
        p_lines: input.lines.map((line) => ({
          item_id: line.itemId, quantity: line.quantity, unit: line.unit,
          units_to_base_factor: line.unitsToBaseFactor, unit_price: line.unitPrice,
          discount_amount: line.discountAmount, tax_amount: line.taxAmount, notes: line.notes || null,
        })),
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر إنشاء مسودة فاتورة المشتريات.");
      return data[0];
    }),

  supplierLedgerStatement: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      supplierId: z.number().int().positive(),
      limit: z.number().int().min(1).max(500).default(200),
    }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewSupplierLedger");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_supplier_ledger_statement", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_supplier_id: input.supplierId, p_limit: input.limit,
      });
      if (error || !data) mapPurchaseDatabaseError(error, "تعذر تحميل كشف حساب المورد.");
      return data;
    }),




  listStocktakeWarehouses: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireStocktakeReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin().from("inventory_warehouses")
        .select("id,tenant_id,site_id,code,name,location_type,generator_id,is_active")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
        .eq("is_active", true).order("name", { ascending: true }).limit(200);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مواقع التخزين المتاحة للجرد." });
      return data ?? [];
    }),

  listStocktakes: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      warehouseId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ ctx, input }) => {
      const access = await requireStocktakeReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_list_stocktakes", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_warehouse_id: input.warehouseId ?? null, p_limit: input.limit,
      });
      if (error || !data) mapPurchaseDatabaseError(error, "تعذر تحميل سجل جلسات الجرد.");
      return data ?? [];
    }),

  listStocktakeLines: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), stocktakeId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireStocktakeReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_list_stocktake_lines", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_stocktake_id: input.stocktakeId,
      });
      if (error || !data) mapPurchaseDatabaseError(error, "تعذر تحميل تفاصيل جلسة الجرد.");
      return data ?? [];
    }),

  createStocktake: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(), warehouseId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500), notes: z.string().trim().max(2000).optional(),
      operationKey: z.string().trim().min(1).max(180),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageStocktakes");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_create_stocktake", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_warehouse_id: input.warehouseId, p_reason: input.reason, p_notes: input.notes || null,
        p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر فتح جلسة الجرد.");
      return data[0];
    }),

  recordStocktakeCount: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(), stocktakeId: z.number().int().positive(),
      itemId: z.number().int().positive(),
      countedQuantity: z.number().finite().min(0).max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "الكمية المعدودة تقبل ثلاث منازل عشرية كحد أقصى."),
      countedUnitCost: z.number().finite().min(0).max(1_000_000_000)
        .refine((value) => Math.abs(value * 10000 - Math.round(value * 10000)) < 1e-7).optional(),
      countNotes: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageStocktakes");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_record_stocktake_count", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_stocktake_id: input.stocktakeId, p_item_id: input.itemId,
        p_counted_quantity: input.countedQuantity, p_counted_unit_cost: input.countedUnitCost ?? null,
        p_count_notes: input.countNotes || null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر حفظ كمية العد الفعلية.");
      return data[0];
    }),

  submitStocktake: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), stocktakeId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageStocktakes");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_submit_stocktake", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_user_id: ctx.user.id, p_stocktake_id: input.stocktakeId,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر إرسال الجرد للاعتماد.");
      return data[0];
    }),

  postStocktake: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), stocktakeId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "approveStocktakes");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_post_stocktake", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_user_id: ctx.user.id, p_stocktake_id: input.stocktakeId,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر اعتماد وترحيل الجرد.");
      return data[0];
    }),

  cancelStocktake: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(), stocktakeId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageStocktakes");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_cancel_stocktake", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_stocktake_id: input.stocktakeId, p_reason: input.reason,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر إلغاء جلسة الجرد.");
      return data[0];
    }),

  supplierPayablesAging: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewSupplierLedger");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_supplier_payables_aging", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_as_of_date: input.asOfDate || null,
      });
      if (error || !data) mapPurchaseDatabaseError(error, "تعذر تحميل تقرير أعمار ذمم الموردين.");
      return data;
    }),

  phaseDFinancialSummary: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).superRefine((value, issue) => {
      const isDate = (text: string) => {
        const parsed = new Date(text + "T00:00:00.000Z");
        return /^\d{4}-\d{2}-\d{2}$/.test(text) &&
          Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
      };
      if (!isDate(value.fromDate) || !isDate(value.toDate) || value.fromDate > value.toDate) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: ["fromDate"], message: "نطاق التقرير المالي غير صالح." });
        return;
      }
      const spanDays = (Date.parse(value.toDate + "T00:00:00.000Z") - Date.parse(value.fromDate + "T00:00:00.000Z")) / 86_400_000;
      if (spanDays > 365) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["toDate"], message: "لا يمكن أن يتجاوز نطاق التقرير 366 يومًا." });
    }))
    .query(async ({ ctx, input }) => {
      const access = await resolveSupabaseSiteAccess(ctx.user.id, input.siteId);
      if (!access.permissions.includes("viewInventoryReports")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض تقارير المخزون المالية." });
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_phase_d_financial_summary", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_from_date: input.fromDate, p_to_date: input.toDate,
      });
      if (error || !data?.[0]) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الملخص المالي للمخزون والمشتريات." });
      }
      const row = data[0] as Record<string, unknown>;
      const canViewPurchaseFinancials = access.permissions.includes("viewPurchases") ||
        access.permissions.includes("manageSupplierPayments");
      const canViewSupplierFinancials = access.permissions.includes("viewSupplierLedger") ||
        access.permissions.includes("manageSupplierPayments") ||
        access.permissions.includes("reverseSupplierPayments");
      return {
        purchaseInvoiceCount: canViewPurchaseFinancials ? Number(row.purchase_invoice_count ?? 0) : null,
        purchaseInvoiceAmount: canViewPurchaseFinancials ? Number(row.purchase_invoice_amount ?? 0) : null,
        supplierPaymentCount: canViewSupplierFinancials ? Number(row.supplier_payment_count ?? 0) : null,
        supplierPaymentAmount: canViewSupplierFinancials ? Number(row.supplier_payment_amount ?? 0) : null,
        supplierReturnCount: canViewSupplierFinancials ? Number(row.supplier_return_count ?? 0) : null,
        supplierReturnCreditAmount: canViewSupplierFinancials ? Number(row.supplier_return_credit_amount ?? 0) : null,
      };
    }),

  phaseDFinancialDetails: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      limit: z.number().int().min(1).max(200).default(100),
      afterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      afterEventType: z.enum(["purchase_invoice", "supplier_payment", "supplier_return"]).optional(),
      afterEventId: z.number().int().positive().optional(),
    }).superRefine((value, issue) => {
      const isDate = (text: string) => {
        const parsed = new Date(text + "T00:00:00.000Z");
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
      };
      if (!isDate(value.fromDate) || !isDate(value.toDate) || value.fromDate > value.toDate ||
        (Date.parse(value.toDate + "T00:00:00.000Z") - Date.parse(value.fromDate + "T00:00:00.000Z")) / 86_400_000 > 365) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: ["fromDate"], message: "نطاق التقرير المالي غير صالح أو يتجاوز 366 يومًا." });
      }
      const cursorCount = [value.afterDate, value.afterEventType, value.afterEventId].filter((entry) => entry !== undefined).length;
      if (cursorCount !== 0 && cursorCount !== 3) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: ["afterDate"], message: "مؤشر صفحة التقرير المالي غير مكتمل." });
      }
    }))
    .query(async ({ ctx, input }) => {
      const access = await resolveSupabaseSiteAccess(ctx.user.id, input.siteId);
      if (!access.permissions.includes("viewInventoryReports")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض تفاصيل التقارير المالية." });
      }
      const canViewPurchaseFinancials = access.permissions.includes("viewPurchases") ||
        access.permissions.includes("manageSupplierPayments");
      const canViewSupplierFinancials = access.permissions.includes("viewSupplierLedger") ||
        access.permissions.includes("manageSupplierPayments") ||
        access.permissions.includes("reverseSupplierPayments");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_phase_d_financial_details", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_from_date: input.fromDate, p_to_date: input.toDate, p_limit: input.limit + 1,
        p_after_date: input.afterDate ?? null, p_after_event_type: input.afterEventType ?? null,
        p_after_event_id: input.afterEventId ?? null,
        p_include_purchase_invoices: canViewPurchaseFinancials,
        p_include_supplier_events: canViewSupplierFinancials,
      });
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل أحداث المشتريات ودفعات الموردين." });
      }
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      const hasMore = rows.length > input.limit;
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
      const items = pageRows.map((row) => ({
        event_date: String(row.event_date),
        event_type: String(row.event_type),
        event_id: Number(row.event_id),
        reference_no: String(row.reference_no ?? ""),
        counterparty_name: String(row.counterparty_name ?? ""),
        status: String(row.status ?? ""),
        amount: Number(row.amount ?? 0),
        related_reference: String(row.related_reference ?? ""),
        refund_amount: Number(row.refund_amount ?? 0),
        allocation_count: Number(row.allocation_count ?? 0),
      }));
      const last = pageRows[pageRows.length - 1];
      return {
        items,
        hasMore,
        nextCursor: hasMore && last ? {
          afterDate: String(last.event_date), afterEventType: String(last.event_type),
          afterEventId: Number(last.event_id),
        } : null,
      };
    }),

  listSupplierPaymentBatchOptions: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments");
      const [suppliersResult, agingResult] = await Promise.all([
        supabaseAdmin().from("suppliers")
          .select("id,name,supplier_code")
          .eq("tenant_id", access.tenantId).eq("is_active", true)
          .order("name", { ascending: true }).limit(500),
        supabaseAdmin().rpc("powerhub_inventory_supplier_payables_aging", {
          p_tenant_id: access.tenantId, p_site_id: input.siteId, p_as_of_date: input.asOfDate || null,
        }),
      ]);
      if (suppliersResult.error || agingResult.error || !agingResult.data) {
        mapPurchaseDatabaseError(suppliersResult.error || agingResult.error, "تعذر تحميل الفواتير والذمم المفتوحة لتوزيع الدفعة.");
      }
      return { suppliers: suppliersResult.data ?? [], payables: agingResult.data };
    }),


  listSupplierPaymentHistory: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      supplierId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).default(100),
    }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments");
      let paymentQuery = supabaseAdmin().from("supplier_payments")
        .select("id,tenant_id,site_id,supplier_id,company_account_id,amount,payment_date,status,reference_no,notes,account_transaction_id,posted_at,posted_by_user_id,reversed_at,reversed_by_user_id,reversal_reason")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
        .order("payment_date", { ascending: false }).order("id", { ascending: false }).limit(input.limit);
      if (input.supplierId) paymentQuery = paymentQuery.eq("supplier_id", input.supplierId);
      const { data: paymentRows, error: paymentError } = await paymentQuery;
      if (paymentError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل دفعات الموردين." });
      const payments = paymentRows ?? [];
      if (!payments.length) return [];
      const paymentIds = payments.map((row) => Number(row.id));
      const supplierIds = [...new Set(payments.map((row) => Number(row.supplier_id)))];
      const accountIds = [...new Set(payments.map((row) => Number(row.company_account_id)))];
      const [allocationResult, supplierResult, accountResult] = await Promise.all([
        supabaseAdmin().from("supplier_payment_allocations")
          .select("payment_id,purchase_id,supplier_ledger_entry_id,amount")
          .eq("tenant_id", access.tenantId).in("payment_id", paymentIds).order("id", { ascending: true }),
        supabaseAdmin().from("suppliers").select("id,name,supplier_code")
          .eq("tenant_id", access.tenantId).in("id", supplierIds),
        supabaseAdmin().from("company_accounts").select("id,name,account_type")
          .eq("tenant_id", access.tenantId).in("id", accountIds),
      ]);
      if (allocationResult.error || supplierResult.error || accountResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تخصيصات الدفعات والموردين والحسابات المرتبطة بها." });
      }
      const allocations = allocationResult.data ?? [];
      const purchaseIds = [...new Set(allocations.filter((row) => row.purchase_id != null).map((row) => Number(row.purchase_id)))];
      const openingEntryIds = [...new Set(allocations.filter((row) => row.supplier_ledger_entry_id != null).map((row) => Number(row.supplier_ledger_entry_id)))];
      const [purchaseResult, openingResult] = await Promise.all([
        purchaseIds.length
          ? supabaseAdmin().from("supplier_purchases").select("id,purchase_number").eq("tenant_id", access.tenantId).in("id", purchaseIds)
          : Promise.resolve({ data: [], error: null }),
        openingEntryIds.length
          ? supabaseAdmin().from("supplier_ledger_entries").select("id,reference_no,description").eq("tenant_id", access.tenantId).in("id", openingEntryIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (purchaseResult.error || openingResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مراجع المستندات المسددة." });
      }
      const suppliers = new Map((supplierResult.data ?? []).map((row) => [Number(row.id), row]));
      const accounts = new Map((accountResult.data ?? []).map((row) => [Number(row.id), row]));
      const purchases = new Map((purchaseResult.data ?? []).map((row) => [Number(row.id), row]));
      const openingEntries = new Map((openingResult.data ?? []).map((row) => [Number(row.id), row]));
      const allocationsByPayment = new Map<number, Array<{
        purchase_id: number | null;
        supplier_ledger_entry_id: number | null;
        amount: number;
        document_type: "purchase_invoice" | "opening_balance";
        document_reference: string;
      }>>();
      for (const row of allocations) {
        const paymentId = Number(row.payment_id);
        const isPurchase = row.purchase_id != null;
        const purchase = isPurchase ? purchases.get(Number(row.purchase_id)) : undefined;
        const opening = row.supplier_ledger_entry_id != null ? openingEntries.get(Number(row.supplier_ledger_entry_id)) : undefined;
        const entry = {
          purchase_id: row.purchase_id == null ? null : Number(row.purchase_id),
          supplier_ledger_entry_id: row.supplier_ledger_entry_id == null ? null : Number(row.supplier_ledger_entry_id),
          amount: Number(row.amount),
          document_type: (isPurchase ? "purchase_invoice" : "opening_balance") as "purchase_invoice" | "opening_balance",
          document_reference: purchase?.purchase_number ?? opening?.reference_no ?? opening?.description ?? "رصيد افتتاحي",
        };
        allocationsByPayment.set(paymentId, [...(allocationsByPayment.get(paymentId) ?? []), entry]);
      }
      return payments.map((payment) => ({
        id: Number(payment.id),
        supplier_id: Number(payment.supplier_id),
        supplier_name: suppliers.get(Number(payment.supplier_id))?.name ?? "مورد غير متاح",
        supplier_code: suppliers.get(Number(payment.supplier_id))?.supplier_code ?? null,
        company_account_id: Number(payment.company_account_id),
        company_account_name: accounts.get(Number(payment.company_account_id))?.name ?? "حساب غير متاح",
        company_account_type: accounts.get(Number(payment.company_account_id))?.account_type ?? null,
        amount: Number(payment.amount),
        payment_date: payment.payment_date,
        status: payment.status as "posted" | "reversed",
        reference_no: payment.reference_no ?? null,
        notes: payment.notes ?? null,
        account_transaction_id: payment.account_transaction_id == null ? null : Number(payment.account_transaction_id),
        posted_at: payment.posted_at ?? null,
        posted_by_user_id: payment.posted_by_user_id == null ? null : Number(payment.posted_by_user_id),
        reversed_at: payment.reversed_at ?? null,
        reversed_by_user_id: payment.reversed_by_user_id == null ? null : Number(payment.reversed_by_user_id),
        reversal_reason: payment.reversal_reason ?? null,
        allocations: allocationsByPayment.get(Number(payment.id)) ?? [],
      }));
    }),

  cancelPurchase: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      purchaseId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "approvePurchases");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_cancel_purchase", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_purchase_id: input.purchaseId, p_reason: input.reason,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر إلغاء فاتورة المشتريات.");
      return data[0];
    }),

  reverseSupplierPayment: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      paymentId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "reverseSupplierPayments");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_reverse_supplier_payment_flexible", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_payment_id: input.paymentId, p_reason: input.reason,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر عكس دفعة المورد.");
      return data[0];
    }),

  confirmPurchase: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), purchaseId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "approvePurchases");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_confirm_purchase", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_user_id: ctx.user.id, p_purchase_id: input.purchaseId,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر اعتماد فاتورة المشتريات.");
      return data[0];
    }),

  recordSupplierPayment: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      purchaseId: z.number().int().positive(),
      companyAccountId: z.number().int().positive(),
      amount: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, "يجب ألا يزيد مبلغ الدفعة عن منزلتين عشريتين."),
      paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      operationKey: z.string().trim().min(1).max(180),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_record_supplier_payment", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_purchase_id: input.purchaseId,
        p_company_account_id: input.companyAccountId,
        p_amount: input.amount,
        p_payment_date: input.paymentDate || null,
        p_reference_no: input.referenceNo || null,
        p_notes: input.notes || null,
        p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تسجيل دفعة المورد.");
      return data[0];
    }),


  recordSupplierOpeningBalance: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      supplierId: z.number().int().positive(),
      amount: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, "يجب ألا يزيد الرصيد الافتتاحي عن منزلتين عشريتين."),
      asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_record_supplier_opening_balance", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_supplier_id: input.supplierId, p_amount: input.amount, p_as_of_date: input.asOfDate || null,
        p_reference_no: input.referenceNo || null, p_notes: input.notes || null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تسجيل الرصيد الافتتاحي للمورد.");
      return data[0];
    }),

  recordSupplierPaymentBatch: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      supplierId: z.number().int().positive(),
      companyAccountId: z.number().int().positive(),
      amount: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, "يجب ألا يزيد مبلغ الدفعة عن منزلتين عشريتين."),
      paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      operationKey: z.string().trim().min(1).max(180),
      allocations: z.array(z.object({
        purchaseId: z.number().int().positive().optional(),
        openingBalanceEntryId: z.number().int().positive().optional(),
        amount: z.number().finite().positive().max(1_000_000_000)
          .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7),
      })).min(1).max(100),
    }).superRefine((value, issue) => {
      const totalCents = value.allocations.reduce((sum, allocation) => sum + Math.round(allocation.amount * 100), 0);
      if (totalCents !== Math.round(value.amount * 100)) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: ["allocations"], message: "مجموع تخصيصات الدفعة يجب أن يساوي مبلغ الدفعة." });
      }
      const keys = new Set<string>();
      for (const [index, allocation] of value.allocations.entries()) {
        const hasPurchase = allocation.purchaseId !== undefined;
        const hasOpening = allocation.openingBalanceEntryId !== undefined;
        if (hasPurchase === hasOpening) {
          issue.addIssue({ code: z.ZodIssueCode.custom, path: ["allocations", index], message: "اختر فاتورة واحدة أو رصيدًا افتتاحيًا لكل تخصيص." });
        }
        const key = hasPurchase ? `purchase:${allocation.purchaseId}` : `opening:${allocation.openingBalanceEntryId}`;
        if (keys.has(key)) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["allocations", index], message: "لا تكرر المستند نفسه في دفعة واحدة." });
        keys.add(key);
      }
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_record_supplier_payment_batch", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_supplier_id: input.supplierId, p_company_account_id: input.companyAccountId,
        p_amount: input.amount, p_payment_date: input.paymentDate || null,
        p_reference_no: input.referenceNo || null, p_notes: input.notes || null,
        p_operation_key: input.operationKey,
        p_allocations: input.allocations.map((allocation) => ({
          purchase_id: allocation.purchaseId ?? null,
          supplier_ledger_entry_id: allocation.openingBalanceEntryId ?? null,
          amount: allocation.amount,
        })),
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تسجيل دفعة المورد على المستندات المحددة.");
      return data[0];
    }),

  returnToSupplier: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      purchaseId: z.number().int().positive(),
      returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      operationKey: z.string().trim().min(1).max(120),
      reason: z.string().trim().min(3).max(500),
      notes: z.string().trim().max(2000).optional(),
      refundAmount: z.number().finite().min(0).max(1_000_000_000)
        .refine((amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-7, {
          message: "مبلغ الاسترداد النقدي يجب أن يكون بحد أقصى منزلتين عشريتين.",
        })
        .default(0),
      refundCompanyAccountId: z.number().int().positive().optional(),
      lines: z.array(z.object({
        purchaseLineId: z.number().int().positive(),
        quantity: z.number().finite().positive().max(1_000_000_000),
      })).min(1).max(200),
    }).superRefine((value, ctx) => {
      if (value.refundAmount > 0 && !value.refundCompanyAccountId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refundCompanyAccountId"], message: "حدد حساب الشركة لاستلام المبلغ النقدي." });
      }
      if (value.refundAmount === 0 && value.refundCompanyAccountId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refundCompanyAccountId"], message: "لا حاجة لحساب شركة إذا لم يُسترد مبلغ نقدي." });
      }
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "adjustInventory");
      if (input.refundAmount > 0) {
        const financialAccess = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments");
        if (financialAccess.tenantId !== access.tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "حساب الشركة غير متاح لهذا المستأجر." });
        }
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_return_to_supplier", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_purchase_id: input.purchaseId, p_return_date: input.returnDate || null,
        p_operation_key: input.operationKey, p_reason: input.reason,
        p_notes: input.notes || null,
        p_lines: input.lines.map((line) => ({ purchase_line_id: line.purchaseLineId, quantity: line.quantity })),
        p_refund_amount: input.refundAmount, p_refund_company_account_id: input.refundCompanyAccountId ?? null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تسجيل مرتجع المورد.");
      return data[0];
    }),


  transferStock: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      itemId: z.number().int().positive(),
      sourceWarehouseId: z.number().int().positive(),
      destinationWarehouseId: z.number().int().positive(),
      quantity: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "الكمية تقبل ثلاث منازل عشرية كحد أقصى."),
      operationKey: z.string().trim().min(1).max(170),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
    }).refine((value) => value.sourceWarehouseId !== value.destinationWarehouseId, {
      message: "اختر مخزنين مختلفين.", path: ["destinationWarehouseId"],
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "adjustInventory");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_transfer_stock", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_item_id: input.itemId,
        p_source_warehouse_id: input.sourceWarehouseId,
        p_destination_warehouse_id: input.destinationWarehouseId,
        p_quantity: input.quantity,
        p_operation_key: input.operationKey,
        p_reference_no: input.referenceNo || null,
        p_notes: input.notes || null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تنفيذ التحويل المخزني.");
      return data[0];
    }),

  receivePurchase: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      purchaseId: z.number().int().positive(),
      receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      operationKey: z.string().trim().min(1).max(180),
      notes: z.string().trim().max(2000).optional(),
      lines: z.array(z.object({
        purchaseLineId: z.number().int().positive(),
        quantity: z.number().finite().positive().max(1_000_000_000),
      })).min(1).max(200),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "receiveInventory");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_receive_purchase", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_purchase_id: input.purchaseId, p_receipt_date: input.receiptDate || null,
        p_operation_key: input.operationKey, p_notes: input.notes || null,
        p_lines: input.lines.map((line) => ({ purchase_line_id: line.purchaseLineId, quantity: line.quantity })),
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تسجيل استلام المشتريات.");
      return data[0];
    }),


  fuelWorkspaceOptions: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireFuelReadAccess(ctx.user.id, input.siteId);
      const admin = supabaseAdmin();
      const [generatorsResult, tanksResult, itemsResult, sourcesResult] = await Promise.all([
        admin.from("generators").select("id,code,name,fuel_type,fuel_level_liters,operating_hours,status")
          .eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
          .order("name", { ascending: true }).limit(200),
        admin.from("inventory_warehouses").select("id,code,name,location_type,generator_id")
          .eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
          .eq("is_active", true).eq("location_type", "generator_fuel_tank")
          .order("name", { ascending: true }).limit(200),
        access.canManageFuel
          ? admin.from("inventory_items").select("id,sku,name,category,base_unit")
              .eq("tenant_id", access.tenantId).eq("category", "fuel").eq("base_unit", "liter")
              .eq("is_active", true).order("name", { ascending: true }).limit(300)
          : Promise.resolve({ data: [], error: null }),
        access.canManageFuel
          ? admin.from("inventory_warehouses").select("id,code,name,location_type")
              .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("is_active", true)
              .in("location_type", ["central_warehouse", "branch_warehouse", "fixed_fuel_tank"])
              .order("name", { ascending: true }).limit(200)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (generatorsResult.error || tanksResult.error || itemsResult.error || sourcesResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل خيارات الوقود والخزانات." });
      }
      const generators = (generatorsResult.data ?? []).map((row) => ({
        id: Number(row.id), code: row.code, name: row.name, fuelType: row.fuel_type,
        fuelLevelLiters: row.fuel_level_liters, operatingHours: row.operating_hours, status: row.status,
      }));
      const generatorIds = new Set(generators.map((row) => row.id));
      return {
        generators,
        generatorTanks: (tanksResult.data ?? []).filter((row) => generatorIds.has(Number(row.generator_id))).map((row) => ({
          id: Number(row.id), code: row.code, name: row.name, generatorId: Number(row.generator_id),
        })),
        fuelItems: (itemsResult.data ?? []).map((row) => ({ id: Number(row.id), sku: row.sku, name: row.name, baseUnit: row.base_unit })),
        sourceLocations: (sourcesResult.data ?? []).map((row) => ({ id: Number(row.id), code: row.code, name: row.name, locationType: row.location_type })),
        canManageFuel: access.canManageFuel,
        canViewFuelReports: access.canViewFuelReports,
      };
    }),

  listFuelEvents: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      generatorId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }).refine((value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate, {
      message: "نطاق تاريخ التعبئة غير صحيح.",
    }))
    .query(async ({ ctx, input }) => {
      const access = await requireFuelReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_list_fuel_events", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_from_date: input.fromDate ?? null, p_to_date: input.toDate ?? null,
        p_generator_id: input.generatorId ?? null, p_limit: input.limit,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل تعبئة الوقود." });
      if (access.canViewFuelReports) return data ?? [];
      return (data ?? []).map((row: Record<string, unknown>) => {
        const { unit_cost: _unitCost, total_cost_amount: _totalCost, ...visible } = row;
        return visible;
      });
    }),

  listFuelReadings: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      generatorId: z.number().int().positive().optional(),
      readingType: z.enum(["tank_level", "operating_hours"]).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ ctx, input }) => {
      const access = await requireFuelReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_list_fuel_readings", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_generator_id: input.generatorId ?? null, p_reading_type: input.readingType ?? null,
        p_limit: input.limit,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قراءات الوقود وساعات التشغيل." });
      return data ?? [];
    }),

  fuelConsumptionReport: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      generatorId: z.number().int().positive().optional(),
    }).refine((value) => value.fromDate <= value.toDate, {
      message: "تاريخ بداية التقرير يجب ألا يتجاوز تاريخ نهايته.",
    }))
    .query(async ({ ctx, input }) => {
      const access = await resolveSupabaseSiteAccess(ctx.user.id, input.siteId);
      if (!access.permissions.includes("viewInventoryReports")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض تقرير استهلاك الوقود." });
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_fuel_consumption_report", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_from_date: input.fromDate, p_to_date: input.toDate, p_generator_id: input.generatorId ?? null,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر احتساب تقرير استهلاك الوقود المقاس." });
      return data ?? [];
    }),

  fuelConsumptionReportPeriod: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      periodType: z.enum(["day", "cycle", "month", "custom"]),
      anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      generatorId: z.number().int().positive().optional(),
      tankWarehouseId: z.number().int().positive().optional(),
    }).superRefine((value, ctx) => {
      if (value.periodType !== "custom" && !value.anchorDate) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["anchorDate"], message: "حدد التاريخ المرجعي للفترة." });
      }
      if (value.periodType === "custom" && (!value.fromDate || !value.toDate || value.fromDate > value.toDate)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fromDate"], message: "حدد نطاقًا زمنيًا صحيحًا للتقرير." });
      }
    }))
    .query(async ({ ctx, input }) => {
      const access = await resolveSupabaseSiteAccess(ctx.user.id, input.siteId);
      if (!access.permissions.includes("viewInventoryReports")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض تقرير استهلاك الوقود." });
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_fuel_consumption_report_period", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_period_type: input.periodType,
        p_anchor_date: input.anchorDate ?? null, p_from_date: input.fromDate ?? null,
        p_to_date: input.toDate ?? null, p_generator_id: input.generatorId ?? null,
        p_tank_warehouse_id: input.tankWarehouseId ?? null,
      });
      if (error) mapFuelDatabaseError(error, "تعذر احتساب تقرير الوقود للفترة المحددة.");
      return data ?? [];
    }),

  listFuelAlertSettings: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireFuelReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_list_fuel_alert_settings", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات تنبيهات الوقود." });
      return data ?? [];
    }),

  upsertFuelAlertSettings: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      generatorId: z.number().int().positive(),
      tankWarehouseId: z.number().int().positive(),
      lowLevelThresholdLiters: z.number().finite().min(0).max(1_000_000_000).nullable(),
      abnormalLitresPerHourThreshold: z.number().finite().min(0.001).max(1_000_000_000).nullable(),
      minimumHoursDelta: z.number().finite().positive().max(1_000_000).default(1),
      isEnabled: z.boolean(),
      operationKey: z.string().trim().min(1).max(180),
    }).refine((value) => !value.isEnabled || value.lowLevelThresholdLiters !== null || value.abnormalLitresPerHourThreshold !== null, {
      message: "عند تفعيل التنبيه أدخل حدًا واحدًا على الأقل.",
      path: ["lowLevelThresholdLiters"],
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageFuelAndConsumption");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_upsert_fuel_alert_settings", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_generator_id: input.generatorId, p_tank_warehouse_id: input.tankWarehouseId,
        p_low_level_threshold_liters: input.lowLevelThresholdLiters,
        p_abnormal_litres_per_hour_threshold: input.abnormalLitresPerHourThreshold,
        p_minimum_hours_delta: input.minimumHoursDelta, p_is_enabled: input.isEnabled,
        p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapFuelDatabaseError(error, "تعذر حفظ إعدادات تنبيهات الوقود.");
      return data[0];
    }),

  listFuelAlertDispatches: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      generatorId: z.number().int().positive().optional(),
      tankWarehouseId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }).refine((value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate, {
      message: "نطاق تاريخ التنبيهات غير صحيح.",
    }))
    .query(async ({ ctx, input }) => {
      const access = await requireFuelReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_list_fuel_alert_dispatches", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_from_date: input.fromDate ?? null, p_to_date: input.toDate ?? null,
        p_generator_id: input.generatorId ?? null, p_tank_warehouse_id: input.tankWarehouseId ?? null,
        p_limit: input.limit,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل تنبيهات الوقود." });
      return data ?? [];
    }),

  recordFuelFill: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      generatorId: z.number().int().positive(),
      fuelItemId: z.number().int().positive(),
      sourceWarehouseId: z.number().int().positive(),
      destinationWarehouseId: z.number().int().positive(),
      litres: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "كمية الوقود تقبل ثلاث منازل عشرية."),
      occurredAt: z.string().datetime({ offset: true }),
      levelBeforeLiters: z.number().finite().min(0).max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7).nullable().optional(),
      levelAfterLiters: z.number().finite().min(0).max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7).nullable().optional(),
      operatingHours: z.number().finite().min(0).max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7).nullable().optional(),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      operationKey: z.string().trim().min(1).max(150),
    }).refine((value) => value.sourceWarehouseId !== value.destinationWarehouseId, {
      message: "مصدر الوقود وخزان المولد يجب أن يكونا مختلفين.", path: ["destinationWarehouseId"],
    }).refine((value) => (value.levelBeforeLiters == null) === (value.levelAfterLiters == null), {
      message: "أدخل مستوى الخزان قبل التعبئة وبعدها معًا، أو اتركهما غير محددين.", path: ["levelAfterLiters"],
    }).refine((value) => value.levelBeforeLiters == null || Number(value.levelAfterLiters) >= Number(value.levelBeforeLiters), {
      message: "مستوى الخزان بعد التعبئة لا يجوز أن يقل عن المستوى المسجل قبلها.", path: ["levelAfterLiters"],
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageFuelAndConsumption");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_record_fuel_fill", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_generator_id: input.generatorId, p_fuel_item_id: input.fuelItemId,
        p_source_warehouse_id: input.sourceWarehouseId, p_destination_warehouse_id: input.destinationWarehouseId,
        p_litres: input.litres, p_occurred_at: input.occurredAt,
        p_level_before_liters: input.levelBeforeLiters ?? null, p_level_after_liters: input.levelAfterLiters ?? null,
        p_operating_hours: input.operatingHours ?? null, p_reference_no: input.referenceNo || null,
        p_notes: input.notes || null, p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapFuelDatabaseError(error, "تعذر تسجيل تعبئة الوقود وترحيل حركة المخزون.");
      if (access.permissions.includes("viewInventoryReports")) return data[0];
      const { total_cost_amount: _totalCost, ...withoutCost } = data[0];
      return withoutCost;
    }),

  recordFuelReading: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      generatorId: z.number().int().positive(),
      readingType: z.enum(["tank_level", "operating_hours"]),
      tankWarehouseId: z.number().int().positive().nullable().optional(),
      readingValue: z.number().finite().min(0).max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "القراءة تقبل ثلاث منازل عشرية."),
      recordedAt: z.string().datetime({ offset: true }),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      correctsReadingId: z.number().int().positive().nullable().optional(),
      correctionReason: z.string().trim().min(3).max(500).optional(),
      operationKey: z.string().trim().min(1).max(180),
    }).superRefine((value, ctx) => {
      if (value.readingType === "tank_level" && !value.tankWarehouseId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tankWarehouseId"], message: "اختر خزانًا لقراءة مستوى الوقود." });
      }
      if (value.readingType === "operating_hours" && value.tankWarehouseId != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tankWarehouseId"], message: "قراءة ساعات التشغيل لا ترتبط بخزان." });
      }
      if (value.correctsReadingId != null && !value.correctionReason?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["correctionReason"], message: "أدخل سببًا موثقًا للتصحيح." });
      }
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageFuelAndConsumption");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_record_fuel_reading", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_generator_id: input.generatorId, p_reading_type: input.readingType,
        p_tank_warehouse_id: input.tankWarehouseId ?? null, p_reading_value: input.readingValue,
        p_recorded_at: input.recordedAt, p_reference_no: input.referenceNo || null, p_notes: input.notes || null,
        p_corrects_reading_id: input.correctsReadingId ?? null, p_correction_reason: input.correctionReason || null,
        p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapFuelDatabaseError(error, "تعذر تسجيل قراءة الوقود أو ساعات التشغيل.");
      return data[0];
    }),

});
