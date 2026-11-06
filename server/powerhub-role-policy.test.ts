import { describe, expect, it } from "vitest";
import type { PowerCapability } from "../shared/powerhub-rbac";
import { getPolicyAllowedCapabilities } from "./powerhub-role-policy";

const caps = (...values: PowerCapability[]) => values;

describe("PowerHub platform role policy capability filtering", () => {
  it("keeps a granted requested capability when no explicit policy row exists", () => {
    expect(getPolicyAllowedCapabilities(caps("viewInventory"), caps("viewInventory"), []))
      .toEqual(["viewInventory"]);
  });

  it("supports a granted alternate capability when the primary capability is absent", () => {
    expect(getPolicyAllowedCapabilities(
      caps("viewInventory", "viewInventoryReports"),
      caps("viewInventoryReports"),
      [],
    )).toEqual(["viewInventoryReports"]);
  });

  it("falls through when the primary capability is denied but an alternate is allowed", () => {
    expect(getPolicyAllowedCapabilities(
      caps("viewInventory", "viewInventoryReports"),
      caps("viewInventory", "viewInventoryReports"),
      [{ capability: "viewInventory", is_allowed: false }],
    )).toEqual(["viewInventoryReports"]);
  });

  it("denies all granted alternatives when every one is explicitly denied", () => {
    expect(getPolicyAllowedCapabilities(
      caps("viewInventory", "viewInventoryReports"),
      caps("viewInventory", "viewInventoryReports"),
      [
        { capability: "viewInventory", is_allowed: false },
        { capability: "viewInventoryReports", is_allowed: false },
      ],
    )).toEqual([]);
  });

  it("does not return unrequested or ungranted capabilities and removes duplicates", () => {
    expect(getPolicyAllowedCapabilities(
      caps("viewInventory", "viewInventory", "viewInventoryReports"),
      caps("viewInventory", "manageFuelAndConsumption"),
      [{ capability: "manageFuelAndConsumption", is_allowed: true }],
    )).toEqual(["viewInventory"]);
  });
});
