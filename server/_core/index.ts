import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./static";
import { sdk } from "./sdk";
import { processNotificationQueue, processNotificationQueueForTenant } from "../notification-worker";
import { getDb } from "../db";
import { messagingScheduleRuns, tenantMessagingConfigurations } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { receiveWhatsAppWebhook, verifyWhatsAppWebhook } from "../messaging-webhooks";
import { registerMobileApi } from "../mobile-api";
import { isVercelRuntime } from "./runtime";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

export function createPowerHubApp() {
  const app = express();
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb", verify: (req, _res, buffer) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buffer; } }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerMobileApi(app);
  app.get("/api/webhooks/whatsapp/:tenantId", verifyWhatsAppWebhook);
  app.post("/api/webhooks/whatsapp/:tenantId", receiveWhatsAppWebhook);
  app.post("/api/scheduled/send-invoice-sms", async (req, res) => {
    const startedAt = new Date();
    let runConfig: { id: number; tenantId: number } | undefined;
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron_only" });
      const db = await getDb();
      if (!db) return res.status(500).json({ error: "database_unavailable" });
      const [config] = await db.select({ id: tenantMessagingConfigurations.id, tenantId: tenantMessagingConfigurations.tenantId }).from(tenantMessagingConfigurations).where(eq(tenantMessagingConfigurations.scheduleCronTaskUid, user.taskUid)).limit(1);
      if (!config) return res.json({ ok: true, skipped: "orphan" });
      runConfig = config;
      const result = await processNotificationQueueForTenant(config.tenantId, 50);
      await db.insert(messagingScheduleRuns).values({ tenantId: config.tenantId, configurationId: config.id, taskUid: user.taskUid, status: "success", scanned: result.scanned, submitted: result.submitted, failed: result.failed, skipped: result.skipped, startedAt, finishedAt: new Date() });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2000) : "invoice_sms_schedule_failed";
      if (runConfig) {
        const db = await getDb();
        if (db) await db.insert(messagingScheduleRuns).values({ tenantId: runConfig.tenantId, configurationId: runConfig.id, status: "failed", error: message, startedAt, finishedAt: new Date() });
      }
      return res.status(500).json({ error: message, timestamp: new Date().toISOString() });
    }
  });
  app.post("/api/scheduled/process-notifications", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron_only" });
      return res.json({ ok: true, ...(await processNotificationQueue(25)) });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "notification_processing_failed", timestamp: new Date().toISOString() });
    }
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  return app;
}

async function startServer() {
  const app = createPowerHubApp();
  const server = createServer(app);
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    const viteModulePath = process.env.POWERHUB_VITE_MODULE ?? "./vite";
    const { setupVite } = await import(viteModulePath);
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

if (!isVercelRuntime()) {
  startServer().catch(console.error);
}
