import { supabase } from "@/lib/supabase";

export type OfflineGeneratorCreateInput = {
  siteId: number;
  code: string;
  name: string;
  serialNumber?: string;
  ratedCapacityKw?: string;
  fuelType: "diesel" | "gasoline" | "gas" | "other";
  clientOperationId: string;
};

export type OfflineGeneratorUpdateInput = {
  siteId: number;
  generatorId: number;
  name: string;
  ratedCapacityKw?: string;
  fuelLevelLiters: string;
  operatingHours: string;
  status: "active" | "maintenance" | "stopped" | "offline";
  expectedUpdatedAt: string;
  clientOperationId: string;
};

export type OfflineGeneratorSyncResult = {
  id: number;
  name: string;
  updatedAt?: Date;
  replayed: boolean;
};

function translateGeneratorSyncError(message: string): Error & { data?: { code?: string } } {
  const error = new Error(
    message.includes("GENERATOR_VERSION_CONFLICT")
      ? "تغيرت بيانات المولد على الخادم منذ حفظ هذه المسودة. راجع التعارض ثم أعد المحاولة."
      : message.includes("GENERATOR_OUT_OF_SCOPE") || message.includes("SITE_OUT_OF_SCOPE")
        ? "المولد أو المحطة لا تتبع لنطاق حسابك الحالي."
        : message.includes("GENERATOR_OPERATION_TYPE_CONFLICT")
          ? "معرف عملية المزامنة مستخدم لنوع عملية مختلف."
          : message.includes("GENERATOR_MANAGEMENT_FORBIDDEN")
            ? "لا تملك صلاحية إدارة المولدات في هذه المحطة."
            : message.includes("AUTH_USER_NOT_FOUND")
              ? "انتهت جلسة الدخول؛ أعد تسجيل الدخول ثم أعد المزامنة."
              : message,
  ) as Error & { data?: { code?: string } };
  if (message.includes("GENERATOR_VERSION_CONFLICT")) error.data = { code: "CONFLICT" };
  else if (message.includes("GENERATOR_MANAGEMENT_FORBIDDEN")) error.data = { code: "FORBIDDEN" };
  else if (message.includes("GENERATOR_OUT_OF_SCOPE") || message.includes("SITE_OUT_OF_SCOPE")) error.data = { code: "NOT_FOUND" };
  else error.data = { code: "INTERNAL_SERVER_ERROR" };
  return error;
}

export async function syncGeneratorCreate(input: OfflineGeneratorCreateInput): Promise<OfflineGeneratorSyncResult> {
  const { data, error } = await supabase.rpc("powerhub_sync_generator_create", {
    p_site_id: input.siteId,
    p_code: input.code,
    p_name: input.name,
    p_serial_number: input.serialNumber ?? "",
    p_rated_capacity_kw: input.ratedCapacityKw ?? null,
    p_fuel_type: input.fuelType,
    p_client_operation_id: input.clientOperationId,
  });
  if (error) throw translateGeneratorSyncError(error.message);
  const row = (data as Array<{ id: number | string; name: string; replayed: boolean }> | null)?.[0];
  if (!row) throw new Error("تعذر إتمام مزامنة إنشاء المولد.");
  return { id: Number(row.id), name: row.name, replayed: Boolean(row.replayed) };
}

export async function syncGeneratorUpdate(input: OfflineGeneratorUpdateInput): Promise<OfflineGeneratorSyncResult> {
  const { data, error } = await supabase.rpc("powerhub_sync_generator_update", {
    p_site_id: input.siteId,
    p_generator_id: input.generatorId,
    p_name: input.name,
    p_rated_capacity_kw: input.ratedCapacityKw,
    p_fuel_level_liters: input.fuelLevelLiters,
    p_operating_hours: input.operatingHours,
    p_status: input.status,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_client_operation_id: input.clientOperationId,
  });
  if (error) throw translateGeneratorSyncError(error.message);
  const row = (data as Array<{ id: number | string; name: string; updated_at: string; replayed: boolean }> | null)?.[0];
  if (!row) throw new Error("تعذر إتمام مزامنة تعديل المولد.");
  return { id: Number(row.id), name: row.name, updatedAt: new Date(row.updated_at), replayed: Boolean(row.replayed) };
}
