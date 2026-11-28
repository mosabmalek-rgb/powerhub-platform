import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { captureSnapshotQueryBoundary } from "./offline-snapshot-query-boundary";

describe("snapshot query boundary", () => {
  it("rejects a live query success even at the same millisecond", () => {
    const client = new QueryClient();
    try {
      client.setQueryData(["list"], ["old"], { updatedAt: 10 });
      const boundary = captureSnapshotQueryBoundary(() => client.getQueryCache().findAll());
      client.setQueryData(["list"], ["new"], { updatedAt: 10 });
      expect(boundary.isUnchanged()).toBe(false);
      expect(() => boundary.assertUnchanged()).toThrow(/live query/);
      expect(client.getQueryData(["list"])).toEqual(["new"]);
    } finally { client.clear(); }
  });
  it("accepts the expected local write but rejects another matching query changing", () => {
    const client = new QueryClient();
    try {
      client.setQueryData(["list", 1], ["old"]);
      client.setQueryData(["list", 2], ["old"]);
      const boundary = captureSnapshotQueryBoundary(() => client.getQueryCache().findAll());
      const query = client.getQueryCache().find({ queryKey: ["list", 1], exact: true })!;
      client.setQueryData(["list", 1], ["snapshot"]);
      boundary.acceptLocalWrite(query);
      expect(boundary.isUnchanged()).toBe(true);
      client.setQueryData(["list", 2], ["live"]);
      expect(() => boundary.assertUnchanged()).toThrow();
    } finally { client.clear(); }
  });
  it("rejects a newly added or recreated matching query", () => {
    const client = new QueryClient();
    try {
      client.setQueryData(["list"], ["old"]);
      const boundary = captureSnapshotQueryBoundary(() => client.getQueryCache().findAll());
      client.removeQueries({ queryKey: ["list"], exact: true });
      client.setQueryData(["list"], ["old"]);
      expect(boundary.isUnchanged()).toBe(false);
      const next = captureSnapshotQueryBoundary(() => client.getQueryCache().findAll());
      client.setQueryData(["list", 2], ["new"]);
      expect(next.isUnchanged()).toBe(false);
    } finally { client.clear(); }
  });
  it("defers if a real network query is fetching", async () => {
    const client = new QueryClient();
    let resolve!: (value: string[]) => void;
    const pending = new Promise<string[]>(done => { resolve = done; });
    try {
      client.setQueryData(["list"], ["old"]);
      const boundary = captureSnapshotQueryBoundary(() => client.getQueryCache().findAll());
      const fetch = client.fetchQuery({ queryKey: ["list"], queryFn: () => pending, staleTime: 0 });
      expect(boundary.isUnchanged()).toBe(false);
      expect(() => captureSnapshotQueryBoundary(() => client.getQueryCache().findAll())).toThrow();
      resolve(["live"]);
      await fetch;
      expect(client.getQueryData(["list"])).toEqual(["live"]);
    } finally { resolve(["live"]); client.clear(); }
  });
});
