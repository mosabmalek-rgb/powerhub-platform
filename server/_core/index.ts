import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { sdk } from "./sdk";
import { processNotificationQueue, processNotificationQueueForTenant } from "../notification-worker";
import { getDb } from "../db";
import { tenantMessagingConfigurations } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { receiveWhatsAppWebhook, verifyWhatsAppWebhook } from "../messaging-webhooks";

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

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb", verify: (req, _res, buffer) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buffer; } }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  app.get("/api/webhooks/whatsapp/:tenantId", verifyWhatsAppWebhook);
  app.post("/api/webhooks/whatsapp/:tenantId", receiveWhatsAppWebhook);
  app.post("/api/scheduled/send-invoice-sms", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron_only" });
      const db = await getDb();
      if (!db) return res.status(500).json({ error: "database_unavailable" });
      const [config] = await db.select({ tenantId: tenantMessagingConfigurations.tenantId }).from(tenantMessagingConfigurations).where(eq(tenantMessagingConfigurations.scheduleCronTaskUid, user.taskUid)).limit(1);
      if (!config) return res.json({ ok: true, skipped: "orphan" });
      return res.json({ ok: true, ...(await processNotificationQueueForTenant(config.tenantId, 50)) });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "invoice_sms_schedule_failed", timestamp: new Date().toISOString() });
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
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
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

startServer().catch(console.error);
