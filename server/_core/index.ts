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
import { registerBrandAssetProxy } from "./storageProxy";
import { healthHandler, readinessHandler } from "./health";

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
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/webhooks/whatsapp/") && Number(req.headers["content-length"] ?? 0) > 256 * 1024) {
      return res.status(413).json({ error: "webhook_payload_too_large" });
    }
    return next();
  });
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "15mb", verify: (req, _res, buffer) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buffer; } }));
  app.use(express.urlencoded({ limit: "2mb", extended: true }));
  app.get("/api/health", healthHandler);
  app.get("/api/ready", readinessHandler);
  registerBrandAssetProxy(app);
  registerMobileApi(app);
  app.get("/api/webhooks/whatsapp/:tenantId", verifyWhatsAppWebhook);
  app.post("/api/webhooks/whatsapp/:tenantId", receiveWhatsAppWebhook);
  app.all("/api/scheduled/process-invoice-notifications", async (req, res) => {
    const configuredSecret = process.env.CRON_SECRET;
    const authorization = req.headers.authorization ?? "";
    if (!configuredSecret || authorization !== `Bearer ${configuredSecret}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    try {
      const { processAutomaticInvoiceNotifications, processAutomaticUnifiedNotifications, processAutomaticFuelAlertEvaluation } = await import("../notification-worker");
      const { processUnifiedMessagingAutomations } = await import("../powerhub-unified-messaging");
      const invoiceResult = await processAutomaticInvoiceNotifications();
      const unifiedAutomationResult = await processUnifiedMessagingAutomations();
      const unifiedDispatchResult = await processAutomaticUnifiedNotifications();
      const fuelAlertEvaluationResult = await processAutomaticFuelAlertEvaluation();
      const result = {
        invoice: invoiceResult,
        unified: unifiedAutomationResult,
        unifiedDispatch: unifiedDispatchResult,
        fuelAlerts: fuelAlertEvaluationResult,
      };
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      console.error("[process-invoice-notifications] scheduled run failed", error);
      return res.status(500).json({ ok: false, error: "invoice_notification_schedule_failed" });
    }
  });
  app.all("/api/scheduled/subscriber-retention", async (req, res) => {
    const configuredSecret = process.env.CRON_SECRET;
    const authorization = req.headers.authorization ?? "";
    if (!configuredSecret || authorization !== `Bearer ${configuredSecret}`) return res.status(401).json({ error: "unauthorized" });
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    try {
      const { processSubscriberRetention } = await import("../subscriber-retention");
      const result = await processSubscriberRetention();
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      console.error("[subscriber-retention] scheduled run failed", error);
      return res.status(500).json({ ok: false, error: "subscriber_retention_failed" });
    }
  });
  app.all("/api/scheduled/payment-documentation-retention", async (req, res) => {
    const configuredSecret = process.env.CRON_SECRET;
    const authorization = req.headers.authorization ?? "";
    if (!configuredSecret || authorization !== `Bearer ${configuredSecret}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    try {
      const { cleanupPaymentDocumentationReceiptImages } = await import("../payment-documentation-retention");
      const result = await cleanupPaymentDocumentationReceiptImages();
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      console.error("[payment-documentation-retention] cleanup failed", error);
      return res.status(500).json({ ok: false, error: "payment_documentation_retention_failed" });
    }
  });
  app.all("/api/scheduled/*", (_req, res) => res.status(410).json({
    error: "scheduled_jobs_disabled",
    message: "هذا المسار قديم؛ تتم الجدولة حالياً عبر Supabase Cron.",
  }));
  // tRPC API
  // Emit low-volume latency telemetry for slow API requests only. Never log
  // request bodies, authorization headers, cookies, or user-supplied values.
  app.use("/api/trpc", (req, res, next) => {
    const startedAt = performance.now();
    res.once("finish", () => {
      const durationMs = Math.round(performance.now() - startedAt);
      if (durationMs < 800) return;
      // Use only the pathname (never the query string, which can contain input).
      // Express strips the mounted prefix from req.path, so originalUrl is needed
      // to capture tRPC procedure names in batched requests.
      const route = req.originalUrl
        .split("?", 1)[0]
        .replace(/^\/api\/trpc\/?/, "")
        .split(",")
        .map((part) => part.replace(/[^a-zA-Z0-9_.$/-]/g, "").slice(0, 120))
        .filter(Boolean)
        .join(",");
      console.warn("[PowerHub API latency]", {
        route: route || "unknown",
        method: req.method,
        status: res.statusCode,
        durationMs,
        responseBytes: Number(res.getHeader("content-length") ?? 0) || undefined,
        vercelRegion: process.env.VERCEL_REGION ?? "local",
      });
    });
    next();
  });
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
