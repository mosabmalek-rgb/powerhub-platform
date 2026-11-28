import { describe, expect, it } from "vitest";
import { resolveSupabaseAdminProjectUrl } from "./supabase-admin";

const productionUrl = "https://vvcdiqcyhaloxesvpppc.supabase.co";
const stagingUrl = "https://iyuryuhaylhisjfcrwkz.supabase.co";

describe("Supabase server project URL contract", () => {
  it("requires an explicit server URL in Vercel Preview instead of falling back to the browser URL", () => {
    expect(() => resolveSupabaseAdminProjectUrl({
      VERCEL_ENV: "preview",
      VITE_SUPABASE_URL: productionUrl,
    })).toThrow("Both server and client Supabase URLs must be explicitly configured for Preview deployments.");
  });

  it("rejects mismatched server and browser project URLs in Preview", () => {
    expect(() => resolveSupabaseAdminProjectUrl({
      VERCEL_ENV: "preview",
      SUPABASE_URL: stagingUrl,
      VITE_SUPABASE_URL: productionUrl,
    })).toThrow("Server and client Supabase URLs must target the same project.");
  });

  it("accepts matching Staging URLs and uses the server-only URL", () => {
    expect(resolveSupabaseAdminProjectUrl({
      VERCEL_ENV: "preview",
      SUPABASE_URL: stagingUrl,
      VITE_SUPABASE_URL: stagingUrl,
    })).toBe(stagingUrl);
  });

  it("prefers the explicit server URL when both project URLs match", () => {
    expect(resolveSupabaseAdminProjectUrl({
      SUPABASE_URL: productionUrl,
      VITE_SUPABASE_URL: productionUrl,
    })).toBe(productionUrl);
  });

  it("retains the VITE URL fallback for local development only", () => {
    expect(resolveSupabaseAdminProjectUrl({
      VITE_SUPABASE_URL: stagingUrl,
    })).toBe(stagingUrl);
  });

  it("rejects malformed or non-HTTP project URLs", () => {
    expect(() => resolveSupabaseAdminProjectUrl({
      SUPABASE_URL: "not-a-url",
    })).toThrow("SUPABASE_URL is not a valid Supabase project URL.");
    expect(() => resolveSupabaseAdminProjectUrl({
      SUPABASE_URL: "file:///tmp/project",
    })).toThrow("SUPABASE_URL is not a valid Supabase project URL.");
  });
});
