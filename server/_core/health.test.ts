import { describe, expect, it } from "vitest";
import { healthHandler, readinessHandler } from "./health";

type MockResponse = {
  statusCode?: number;
  headers: Record<string, string>;
  body?: unknown;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => MockResponse;
  json: (value: unknown) => void;
};

function createResponse(): MockResponse {
  const response: MockResponse = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
    },
  };
  return response;
}

describe("PowerHub health endpoints", () => {
  it("returns a cache-disabled liveness response", () => {
    const response = createResponse();
    healthHandler({}, response as never);

    expect(response.statusCode).toBe(200);
    expect(response.headers["Cache-Control"]).toContain("no-store");
    expect(response.body).toMatchObject({ status: "ok", service: "powerhub-platform" });
  });

  it("reports not_ready when required Supabase runtime config is absent", () => {
    const previousUrl = process.env.VITE_SUPABASE_URL;
    const previousKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

    try {
      const response = createResponse();
      readinessHandler({}, response as never);
      expect(response.statusCode).toBe(503);
      expect(response.body).toMatchObject({ status: "not_ready", checks: { application: true, supabaseConfig: false } });
    } finally {
      if (previousUrl === undefined) delete process.env.VITE_SUPABASE_URL;
      else process.env.VITE_SUPABASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      else process.env.VITE_SUPABASE_PUBLISHABLE_KEY = previousKey;
    }
  });
  it("reports AI Gateway configuration without exposing its secret", async () => {
    const previous = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "test-secret";
    try {
      const response = createResponse();
      await readinessHandler({}, response as never);
      expect(response.body).toMatchObject({ aiGatewayConfigured: true });
      expect(JSON.stringify(response.body)).not.toContain("test-secret");
    } finally {
      if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = previous;
    }
  });
});
