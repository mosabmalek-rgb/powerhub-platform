import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  createNewStaffProfile, compensateUnassignedStaffAuth, StaffAuthRecoveryRequired, assertStaffAssignmentRpcAvailable,
} from "./staff-auth-provisioning";

type Admin = Parameters<typeof createNewStaffProfile>[0];

function fixture(overrides: {
  insertError?: boolean;
  record?: Record<string, unknown> | null;
  lookupError?: boolean;
  member?: boolean;
  staff?: boolean;
  membershipError?: boolean;
  staffError?: boolean;
  deletionError?: boolean;
  deletionThrows?: boolean;
} = {}) {
  const captured = { upsert: null as any, conflict: "", selected: "", lookups: [] as string[] };
  const deleteUser = vi.fn(async () => {
    if (overrides.deletionThrows) throw Error("unavailable Auth backend");
    return { data: null, error: overrides.deletionError ? { message: "Auth error" } : null };
  });
  const defaultRecord = { id: 41, auth_user_id: "auth-id", role: "user",
    platform_role: null, account_status: "active", must_change_password: true };
  const returnRecord = overrides.record === undefined ? defaultRecord : overrides.record;
  const from = vi.fn((table: string) => ({
    upsert: (data: unknown, opts: { onConflict: string }) => {
      captured.upsert = data;
      captured.conflict = opts.onConflict;
      return {
        select: (columns: string) => {
          captured.selected = columns;
          return { single: async () => ({
            data: returnRecord,
            error: overrides.insertError ? { message: "profile write rejected" } : null,
          }) };
        },
      };
    },
    select: () => {
      const chain = {
        eq: (field: string, value: unknown) => {
          captured.lookups.push(table+":"+field+":"+String(value));
          return chain;
        },
        limit: () => chain,
        maybeSingle: async () => {
          if (table === "users") return {
            data: overrides.record === null ? null : { id: 41 },
            error: overrides.lookupError ? { message: "lookup unavailable" } : null,
          };
          if (table === "tenant_members") return {
            data: overrides.member ? { id: 91 } : null,
            error: overrides.membershipError ? { message: "membership unavailable" } : null,
          };
          if (table === "staff_profiles") return {
            data: overrides.staff ? { id: 92 } : null,
            error: overrides.staffError ? { message: "staff unavailable" } : null,
          };
          throw Error("unexpected table");
        },
      };
      return chain;
    },
  }));
  return {
    admin: { from, auth: { admin: { deleteUser } } } as unknown as Admin,
    captured, deleteUser, from,
  };
}
describe("E46 RPC discovery preflight", () => {
  const props = { tenantId: 1, siteId: 7, actorUserId: 55, role: "accountant", allBranches: false };
  const setup = (response: { data: unknown; error: { code: string; message: string } | null }) => {
    const rpc=vi.fn(async () => response);
    const createUser=vi.fn();
    return { admin: { rpc, auth: { admin: { createUser } } } as unknown as Admin, rpc, createUser };
  };
  it("accepts only the definitive missing-target rejection, without modifying data", async () => {
    const f=setup({ data:null, error:{ code:"P0001", message:"TARGET_USER_NOT_FOUND" } });
    await expect(assertStaffAssignmentRpcAvailable(f.admin, props)).resolves.toBeUndefined();
    expect(f.rpc).toHaveBeenCalledOnce();
    expect(f.rpc).toHaveBeenCalledWith("powerhub_assign_existing_staff", {
      p_tenant_id:1,p_site_id:7,p_actor_user_id:55,p_target_user_id:-1,
      p_role:"accountant",p_all_branches:false,
    });
    expect(f.createUser).not.toHaveBeenCalled();
  });
  it.each([
    { data:null,error:{code:"PGRST202",message:"function not found in schema cache"}},
    { data:null,error:{code:"42501",message:"permission denied"}},
    { data:null,error:{code:"P0001",message:"SITE_OUT_OF_SCOPE"}},
    { data:[{profile_id:99}],error:null },
    { data:null,error:null },
  ])("fails closed on missing/invalid RPC result (%o)",async result=>{
    const f=setup(result);
    await expect(assertStaffAssignmentRpcAvailable(f.admin,props))
      .rejects.toThrow("STAFF_ASSIGNMENT_RPC_UNAVAILABLE");
    expect(f.createUser).not.toHaveBeenCalled();
  });
  it("hides unexpected service exceptions",async()=>{
    const rpc=vi.fn(async()=>{throw Error("private exception with credentials");});
    await expect(assertStaffAssignmentRpcAvailable({rpc} as unknown as Admin,props))
      .rejects.toThrow("STAFF_ASSIGNMENT_RPC_UNAVAILABLE");
  });
});

describe("E45 staff profile creation — explicit backend bootstrap", () => {
  it("persists the new Auth-linked user, with restricted role and temporary-password flags", async () => {
    const f=fixture();
    await expect(createNewStaffProfile(f.admin, {
      authUserId:"auth-id",email:"  USER@EXAMPLE.COM ",name:" Staff E45 ",
    })).resolves.toBe(41);
    expect(f.from).toHaveBeenCalledWith("users");
    expect(f.captured.conflict).toBe("auth_user_id");
    expect(f.captured.upsert).toMatchObject({
      auth_user_id:"auth-id",email:"user@example.com",name:"Staff E45",
      role:"user",platform_role:null,account_status:"active",login_method:"supabase",
      must_change_password:true,
    });
    expect(new Date(f.captured.upsert.temporary_password_issued_at).getTime())
      .toBeGreaterThan(0);
    expect(f.captured.selected).toContain("account_status");
  });
  it("rejects invalid or silently partial database profile responses", async () => {
    const bad=[
      {record:null},{insertError:true},{record:{id:0,auth_user_id:"auth-id"}},
      {record:{id:41,auth_user_id:"foreign-id",role:"user",platform_role:null,
        account_status:"active",must_change_password:true}},
      {record:{id:41,auth_user_id:"auth-id",role:"admin",platform_role:null,
        account_status:"active",must_change_password:true}},
      {record:{id:41,auth_user_id:"auth-id",role:"user",platform_role:"platform_admin",
        account_status:"active",must_change_password:true}},
      {record:{id:41,auth_user_id:"auth-id",role:"user",platform_role:null,
        account_status:"disabled",must_change_password:true}},
    ];
    for(const opts of bad) {
      const f=fixture(opts);
      await expect(createNewStaffProfile(f.admin,{
        authUserId:"auth-id",email:"user@example.com",name:"Staff",
      })).rejects.toThrow("STAFF_APPLICATION_PROFILE_NOT_PROVISIONED");
    }
  });
  it("deletes a completely unassigned Auth identity only after successful checks", async () => {
    const f=fixture();
    await compensateUnassignedStaffAuth(f.admin,{authUserId:"auth-id",tenantId:1});
    expect(f.deleteUser).toHaveBeenCalledOnce();
    expect(f.deleteUser).toHaveBeenCalledWith("auth-id");
    expect(f.captured.lookups).toContain("tenant_members:user_id:41");
    expect(f.captured.lookups).toContain("staff_profiles:user_id:41");
  });
  it.each([{member:true},{staff:true}])(
    "preserves Auth when the assignment committed (%o)", async opts => {
      const f=fixture(opts);
      await expect(compensateUnassignedStaffAuth(f.admin,{
        authUserId:"auth-id",tenantId:1,
      })).rejects.toMatchObject({
        reason:"ASSIGNMENT_MAY_HAVE_COMMITTED",
      });
      expect(f.deleteUser).not.toHaveBeenCalled();
    },
  );
  it.each([
    {lookupError:true},{membershipError:true},{staffError:true},
  ])("fails closed when post-condition cannot be established (%o)",async opts=>{
    const f=fixture(opts);
    await expect(compensateUnassignedStaffAuth(f.admin,{
      authUserId:"auth-id",tenantId:1,
    })).rejects.toMatchObject({reason:"UNVERIFIED_DATABASE_STATE"});
    expect(f.deleteUser).not.toHaveBeenCalled();
  });
  it.each([{deletionError:true},{deletionThrows:true}])(
    "does not falsely confirm Auth rollback on provider failure (%o)",async opts=>{
      const f=fixture(opts);
      await expect(compensateUnassignedStaffAuth(f.admin,{
        authUserId:"auth-id",tenantId:1,
      })).rejects.toMatchObject({reason:"AUTH_COMPENSATION_FAILED"});
      expect(f.deleteUser).toHaveBeenCalledOnce();
    },
  );
  it("keeps app request auth reads side-effect free and the assignment server-authorized", () => {
    const source=readFileSync("server/powerhub.ts","utf8");
    const start=source.indexOf("create: protectedProcedure.input(",source.indexOf("permissionCatalog:"));
    const create=source.slice(start,start+5200);
    expect(create).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam")');
    expect(create).toContain("createNewStaffProfile(admin, {");
    expect(create).toContain('"powerhub_assign_existing_staff_with_permissions"');
    expect(create).toContain('input.permissions === undefined ? "powerhub_assign_existing_staff"');
    expect(create).toContain("compensateUnassignedStaffAuth(admin, {");
    expect(create).not.toContain('await admin.auth.admin.deleteUser(authData.user.id)');
    const profile=readFileSync("server/supabase-profile.ts","utf8");
    expect(profile).toContain("if (!options.bootstrap)");
  });
  it("exposes distinct remediation reasons only (no credentials)", () => {
    expect(new StaffAuthRecoveryRequired("UNVERIFIED_DATABASE_STATE"))
      .toMatchObject({reason:"UNVERIFIED_DATABASE_STATE"});
  });
});
