import { describe, expect, it } from "vitest";
import { hasAuthoritativeServerRead } from "./authoritative-server-read";

const success = {
  isSuccess: true,
  isError: false,
  isFetchedAfterMount: true,
  isFetching: false,
  isPlaceholderData: false,
};

describe("authoritative server read gate", () => {
  it("accepts a successful exact query fetched in the current mounted view", () => {
    expect(hasAuthoritativeServerRead(success)).toBe(true);
  });

  it("rejects retained data after a failed background refetch", () => {
    expect(hasAuthoritativeServerRead({ ...success, isSuccess: false, isError: true })).toBe(false);
  });

  it("rejects cached data that has not been fetched after the current view mounted", () => {
    expect(hasAuthoritativeServerRead({ ...success, isFetchedAfterMount: false })).toBe(false);
  });

  it("rejects placeholder data carried from a previous filter", () => {
    expect(hasAuthoritativeServerRead({ ...success, isPlaceholderData: true })).toBe(false);
  });

  it("rejects an in-flight refresh until the server confirms its result", () => {
    expect(hasAuthoritativeServerRead({ ...success, isFetching: true })).toBe(false);
  });

  it("fails closed when query state is missing", () => {
    expect(hasAuthoritativeServerRead({})).toBe(false);
  });
});
