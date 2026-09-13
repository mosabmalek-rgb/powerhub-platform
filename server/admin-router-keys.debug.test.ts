import { describe, it } from "vitest";
import { adminRouter } from "./admin";

describe("admin router debug", () => {
  it("prints current router keys for migration analysis", () => {
    const keys = Object.keys((adminRouter as any)._def.record).sort();
    console.log(`ADMIN_ROUTER_KEYS=${JSON.stringify(keys)}`);
  });
});
