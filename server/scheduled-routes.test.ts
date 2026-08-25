import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";

vi.mock("./_core/runtime", () => ({ isVercelRuntime: () => true }));

import { createPowerHubApp } from "./_core/index";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("مسارات الجدولة الخارجية", () => {
  it("ترفض تشغيل جدولة Heartbeat الموروثة أثناء الانتقال إلى Vercel Cron", async () => {
    const server = createPowerHubApp().listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("تعذر فتح خادم الاختبار.");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/scheduled/process-notifications`, { method: "POST" });
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: "scheduled_jobs_disabled" });
  });
});
