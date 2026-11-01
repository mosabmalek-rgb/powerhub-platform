import { describe, expect, it } from "vitest";
import { filterInventoryMovementRows, filterInventoryStockRows } from "./inventory-warehouse-filter";

describe("inventory warehouse filter", () => {
  const stock = [
    { warehouse_id: 9, warehouse_name: "Central", item_name: "Diesel", sku: "DSL-1" },
    { warehouse_id: 10, warehouse_name: "Branch", item_name: "Oil", sku: "OIL-1" },
    { warehouse_id: 11, warehouse_name: "Tank", item_name: "Diesel", sku: "DSL-2" },
  ];
  const movements = [
    { warehouse_id: 9, movement_id: 1 },
    { warehouse_id: 10, movement_id: 2 },
    { warehouse_id: 11, movement_id: 3 },
  ];

  it("shows all warehouses by default and scopes balances and movements to one warehouse", () => {
    expect(filterInventoryStockRows(stock, "all", "")).toEqual(stock);
    expect(filterInventoryMovementRows(movements, "all")).toEqual(movements);
    expect(filterInventoryStockRows(stock, "10", "")).toEqual([stock[1]]);
    expect(filterInventoryMovementRows(movements, "10")).toEqual([movements[1]]);
  });

  it("preserves the existing item, SKU, and warehouse text search within the selected warehouse", () => {
    expect(filterInventoryStockRows(stock, "all", "diesel")).toEqual([stock[0], stock[2]]);
    expect(filterInventoryStockRows(stock, "9", "DSL-1")).toEqual([stock[0]]);
    expect(filterInventoryStockRows(stock, "10", "diesel")).toEqual([]);
  });

  it("does not leak rows from another warehouse when the requested filter is unknown", () => {
    exp¶»§q«^