import { describe, expect, it } from "vitest";
import { canUserReceiveAnnouncement, type AnnouncementMembership, type AnnouncementStaffProfile } from "./announcement-audience";

const actor = { accountStatus: "active", platformRole: null };
const memberships: AnnouncementMembership[] = [
  { tenant_id: 10, role: "owner", is_active: true, membership_status: "active", expires_at: null },
  { tenant_id: 20, role: "member", is_active: true, membership_status: "active", expires_at: null },
];
const profiles: AnnouncementStaffProfile[] = [
  { tenant_id: 10, role: "manager" },
  { tenant_id: 20, role: "viewer" },
];

describe("tenant-scoped platform announcement audience", () => {
  it("does not carry a role from one tenant into another tenant's announcement", () => {
    expect(canUserReceiveAnnouncement(20, ["manager"], actor, memberships, profiles)).toBe(false);
    expect(canUserReceiveAnnouncement(20, ["viewer"], actor, memberships, profiles)).toBe(true);
    expect(canUserReceiveAnnouncement(10, ["manager"], actor, memberships, profiles)).toBe(true);
    expect(canUserReceiveAnnouncement(10, ["owner"], actor, memberships, profiles)).toBe(true);
  });

  it("uses only unexpired memberships when resolving tenant roles", () => {
    const expiredMembership: AnnouncementMembership[] = [
      { tenant_id: 10, role: "owner", is_active: true, membership_status: "active", expires_at: "2026-11-02T11:59:59.000Z" },
    ];
    const staleProfile: AnnouncementStaffProfile[] = [{ tenant_id: 10, role: "manager" }];
    expect(canUserReceiveAnnouncement(
      10,
      ["manager"],
      actor,
      expiredMembership,
      staleProfile,
    )).toBe(false);
  });

  it("uses active tenant roles for global audiences but still allows all announcements", () => {
    expect(canUserReceiveAnnouncement(null, ["manager"], actor, memberships, profiles)).toBe(true);
    expect(canUserReceiveAnnouncement(null, ["all"], actor, [], [])).toBe(true);
  });

  it("keeps platform roles independent from tenant membership", () => {
    expect(canUserReceiveAnnouncement(
      null,
      ["platform_admin"],
      { accountStatus: "active", platformRole: "platform_admin" },
      [],
      [],
    )).toBe(true);
    expect(canUserReceiveAnnouncement(
      20,
      ["platform_admin"],
      { accountStatus: "active", platformRole: "platform_admin" },
      [],
      [],
    )).toBe(false);
  });

  it("rejects an inactive account", () => {
    expect(canUserReceiveAnnouncement(
      null,
      ["all"],
      { accountStatus: "suspended", platformRole: null },
      memberships,
      profiles,
    )).toBe(false);
  });
});
