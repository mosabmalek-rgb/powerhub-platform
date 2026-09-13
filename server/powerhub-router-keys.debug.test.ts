import { describe, it } from "vitest";
import { powerhubRouter } from "./powerhub";

describe("powerhub router debug", () => {
  it("prints current router keys for migration analysis", () => {
    console.log(`POWERHUB_ROUTER_KEYS=${JSON.stringify(Object.keys((powerhubRouter as any)._def.record).sort())}`);
  });
});
