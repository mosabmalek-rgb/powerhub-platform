import { describe, expect, it } from "vitest";
import { isStaffSuspended } from "./powerhub";

describe("temporary staff suspension", () => {
  const startsAt = new Date("2026-08-22T10:00:00.000Z");
  const endsAt = new Date("2026-08-22T12:00:00.000Z");

  it("is inactive before the suspension starts", () => {
    expect(isStaffSuspended(new Date("2026-08-22T09:59:59.000Z"), startsAt, endsAt)).toBe(false);
  });

  it("blocks access during the suspension window", () => {
    expect(isStaffSuspended(new Date("2026-08-22T11:00:00.000Z"), startsAt, endsAt)).toBe(true);
  });

  it("automatically expires at the end timestamp", () => {
    expect(isStaffSuspended(endsAt, startsAt, endsAt)).toBe(false);
  });

  it("does not suspend when the schedule is incomplete", () => {
    expect(isStaffSuspended(new Date("2026-08-22T11:00:00.000Z"), startsAt, null)).toBe(false);
  });
});
