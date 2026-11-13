import { describe, expect, it } from "vitest";
import { selectFinancialSiteId } from "./finance-site-selection";

describe("financial dashboard site scope", () => {
  const sites = [
    { id: 9000000000099, status: "active" },
    { id: 1, status: "active" },
  ];

  it("defaults to the original active site when a newer isolated fixture is listed first", () => {
    expect(selectFinancialSiteId(sites, null)).toBe(1);
    expect(selectFinancialSiteId([...sites].reverse(), null)).toBe(1);
  });

  it("respects an explicit accessible selection and rejects an inactive or missing selection", () => {
    expect(selectFinancialSiteId(sites, 9000000000099)).toBe(9000000000099);
    expect(selectFinancialSiteId([...sites, { id: 2, status: "archived" }], 2)).toBe(1);
    expect(selectFinancialSiteId(sites, 999)).toBe(1);
    expect(selectFinancialSiteId([{ id: 1, status: "archived" }], null)).toBe(0);
  });
});
