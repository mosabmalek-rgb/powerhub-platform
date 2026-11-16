import { supabaseAdmin } from "./supabase-admin";
import { mobileDeltaScopeVersion } from "./mobile-delta-protocol";

type DbError = { message: string } | null;
function checkDb(error: DbError, name: string): void {
  if (error) throw new Error(`MOBILE_DELTA_${name}: ${error.message}`);
}
function validSequence(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("MOBILE_DELTA_UNSAFE_SEQUENCE");
  }
  return number;
}

export async function loadMobileDeltaScope(tenantId: number, userId: number, branchId: number) {
  const admin = supabaseAdmin();
  const [profiles, member, site, distribution] = await Promise.all([
    admin.from("staff_profiles")
      .select("id,site_id,role,permissions,custom_role_id,is_active,updated_at,suspension_started_at,suspension_ends_at")
      .eq("tenant_id", tenantId).eq("user_id", userId).eq("is_active", true).is("archived_at", null)
      .order("id", { ascending: true }),
    admin.from("tenant_members")
      .select("role,updated_at,expires_at,membership_status,is_active")
      .eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle(),
    admin.from("sites").select("id,status,updated_at")
      .eq("tenant_id", tenantId).eq("id", branchId).maybeSingle(),
    admin.from("field_reading_distribution_settings")
      .select("is_enabled,updated_at").eq("tenant_id", tenantId).eq("site_id", branchId)
      .maybeSingle(),
  ]);
  checkDb(profiles.error, "PROFILES");
  checkDb(member.error, "MEMBERSHIP");
  checkDb(site.error, "SITE");
  checkDb(distribution.error, "DISTRIBUTION");
  if (!member.data || !site.data || site.data.status !== "active" ||
      !profiles.data?.some((row) => row.site_id === null || Number(row.site_id) === branchId)) {
    throw new Error("MOBILE_DELTA_SCOPE_NOT_AVAILABLE");
  }
  const scopeVersion = mobileDeltaScopeVersion({
    tenantId, userId, branchId, member: member.data,
    site: site.data, profiles: profiles.data,
    distribution: distribution.data ?? null,
  });
  return { scopeVersion, distributionEnabled: distribution.data?.is_enabled === true };
}

export async function mobileDeltaFence(tenantId: number, branchId: number) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_mobile_delta_fence", {
    p_tenant_id: tenantId,p_branch_id:branchId,
  });
  checkDb(error, "FENCE");
  const value = Array.isArray(data) ? data[0] : data;
  if (!value) throw new Error("MOBILE_DELTA_FENCE_MISSING");
  return {
    highwater: validSequence(value.highwater),
    retainedFloor: validSequence(value.retained_floor),
    ceiling: validSequence(value.max_subscriber_id),
  };
}

export async function mobileBootstrapIds(input: {
  tenantId: number; branchId: number; userId: number; distributed: boolean;
  after: number; ceiling: number; limit: number;
}) {
  let query = supabaseAdmin().from("subscribers").select("id")
    .eq("tenant_id", input.tenantId).eq("site_id", input.branchId)
    .eq("service_status", "active").is("archived_at", null)
    .gt("id", input.after).lte("id", input.ceiling)
    .order("id", { ascending: true }).limit(input.limit+1);
  if (input.distributed) query = query.eq("assigned_reader_user_id", input.userId);
  const { data,error } = await query;
  checkDb(error,"BOOTSTRAP");
  const ids = (data ?? []).map((row) => validSequence(row.id));
  return { ids: ids.slice(0,input.limit),hasMore: ids.length>input.limit };
}

export async function mobileDeltaEvents(input: {
  tenantId: number; branchId: number; userId: number; distributed: boolean;
  after: number; highwater: number; limit: number;
}) {
  let query = supabaseAdmin().from("mobile_subscriber_change_log")
    .select("sequence_id,subscriber_id,change_type")
    .eq("tenant_id",input.tenantId).eq("branch_id",input.branchId)
    .gt("sequence_id",input.after).lte("sequence_id",input.highwater)
    .order("sequence_id",{ascending:true}).limit(input.limit+1);
  if(input.distributed){
    // Both the old and new technician must see the assignment transfer.
    query = query.or(`old_reader_user_id.eq.${input.userId},new_reader_user_id.eq.${input.userId}`);
  }
  const {data,error}=await query;
  checkDb(error,"EVENTS");
  const events=(data??[]).slice(0,input.limit).map((event) => ({
    sequence: validSequence(event.sequence_id),
    id: validSequence(event.subscriber_id),
  }));
  if (events.some((e,i) => i>0 && e.sequence<=events[i-1].sequence))
    throw new Error("MOBILE_DELTA_EVENT_ORDER_INVALID");
  return {events,hasMore:(data??[]).length>input.limit};
}

export type MobileSubscriberProjection = {
  id:number;subscriberNo:string;fullName:string;phone:string;address:string|null;
  branchId:number;lastReading:string|null;lastReadingAt:string|null;
  hasReadingInCurrentCycle:boolean;
  currentCycleReading:{readingId:number;readingValue:string;readingAt:string;status:string}|null;
};
export async function mobileDeltaProject(input:{
  tenantId:number;branchId:number;userId:number;distributed:boolean;ids:number[];
  cycleStart:string;cycleEnd:string;
}):Promise<MobileSubscriberProjection[]>{
  if(input.ids.length===0)return [];
  const {data,error}=await supabaseAdmin().rpc("powerhub_mobile_subscriber_projection",{
    p_tenant_id:input.tenantId,p_branch_id:input.branchId,
    p_user_id:input.userId,p_distribution_enabled:input.distributed,
    p_subscriber_ids:input.ids,
    p_cycle_start:input.cycleStart,p_cycle_end:input.cycleEnd,
  });
  checkDb(error,"PROJECTION");
  return (data??[]).map((r:{[key:string]:any})=>({
    id:validSequence(r.id),subscriberNo:String(r.subscriber_no),
    fullName:String(r.full_name),phone:String(r.phone??""),
    address:r.address??null,branchId:validSequence(r.branch_id),
    lastReading:r.last_reading==null?null:String(r.last_reading),
    lastReadingAt:r.last_reading_at??null,
    hasReadingInCurrentCycle:r.has_reading_in_current_cycle===true,
    currentCycleReading:r.cycle_reading_id==null?null:{
      readingId:validSequence(r.cycle_reading_id),
      readingValue:String(r.cycle_reading_value),
      readingAt:String(r.cycle_reading_at),status:String(r.cycle_reading_status),
    },
  }));
}
