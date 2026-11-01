// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  readCachedWorkspaceSites,
  writeCachedWorkspaceSites,
  type WorkspaceSiteSnapshot,
} from "./workspace-sites-cache";

const site: WorkspaceSiteSnapshot = {
  id: 7,
  tenantId: 5,
  tenantName: "Tenant",
  name: "Main branch",
  code: "MAIN",
  city: null,
  address: null,
  status: "active",
  anomalyAlertPercent: 20,
  invoiceDueDays: 3,
  invoiceDueHours: 72,
  createdAt: new Date("2026-10-31T12:00:00.000Z"),
};

afterEach(() => window.sessionStorage.clear());

describe("workspace site session cache", () => {
  it("restores exact user-scoped site data and Date values", () => {
    writeCachedWorkspaceSites(10, [site]);
    const cached = readCachedWorkspaceSites(10);
    expect(cached).toEqual([site]);
    expect(cached?.[0].createdAt).toBeInstanceOf(Date);
    expect(readCachedWorkspaceSites(11)).toBeNull();
  });

  it("rejects malformed or incomplete site entries instead of selecting an unknown site", () => {
    window.sessionStorage.setItem("powerhub.workspace-sites.v1:10", JSON.stringify([
      { ...site, createdAt: "invalid" },
      { ...site, id: "7" },
    ]));
    expect(readCachedWorkspaceSites(10)).toBeNull();
  });

  it("supports older snapshots that did not store invoiceDueHours", () => {
    const { invoiceDueHours: _ignored, ...legacy } = site;
    window.sessionStorage.setItem("powerhub.workspace-sites.v1:10", JSON.stringify([legacy]));
    expect(readCac¶»§q«^