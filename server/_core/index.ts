import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./static";
import { receiveWhatsAppWebhook, verifyWhatsAppWebhook } from "../messaging-webhooks";
import { registerMobileApi } from "../mobile-api";
import { isVercelRuntime } from "./runtime";
import { registerBrandAssetProxy, registerStorageProxy } from "./storageProxy";

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
  registerBrandAssetProxy(app);
  registerStorageProxy(app);
  registerMobileApi(app);
  app.get("/api/webhooks/whatsapp/:tenantId", verifyWhatsAppWebhook);
  app.post("/api/webhooks/whatsapp/:tenantId", receiveWhatsAppWebhook);
  app.all("/api/scheduled/*", (_req, res) => res.status(410).json({
    error: "scheduled_jobs_disabled",
    message: "تم تعطيل الإرسال المجدول مؤقتاً أثناء تحويل التشغيل إلى Supabase وVercel.",
  }));
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
