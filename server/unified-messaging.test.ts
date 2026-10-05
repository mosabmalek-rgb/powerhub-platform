import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderInvoiceMessage } from "./invoice-message-template";

const sendType = z.enum(["manual","automatic","scheduled"]);
const scheduleType = z.enum(["none","one_time","weekly","every_10_days","every_15_days","monthly","custom"]);

describe("unified messaging contract", () => {
  it("supports the three delivery modes", () => {
    expect(sendType.options).toEqual(["manual","automatic","scheduled"]);
  });
  it("supports one-time and recurring schedules", () => {
    expect(scheduleType.options).toEqual(["none","one_time","weekly","every_10_days","every_15_days","monthly","custom"]);
  });
  it("does not accept an unsupported delivery mode", () => {
    expect(() => sendType.parse("instant")).toThrow();
  });
});
