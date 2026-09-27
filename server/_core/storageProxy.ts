import type { Express, Response } from "express";
import { storageGetSignedUrl } from "../storage";
import { POWERHUB_DARK_SVG, POWERHUB_LIGHT_SVG } from "./brandAssetsFallback";

const BRAND_ASSETS = new Set(["powerhub-logo-light.png", "powerhub-logo-dark.png"]);

function routeKey(req: { params: unknown }): string {
  return ((req.params as Record<string, string>)["0"] ?? "").replace(/^\/+/, "");
}

function sendBrandFallback(assetName: string, res: Response) {
  const svg = assetName === "powerhub-logo-dark.png" ? POWERHUB_DARK_SVG : POWERHUB_LIGHT_SVG;
  res.set("Content-Type", "image/svg+xml; charset=utf-8");
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  res.send(svg);
}

export function registerBrandAssetProxy(app: Express) {
  app.get(["/brand-assets/*", "/api/brand-assets/*"], async (req, res) => {
    const assetName = routeKey(req);
    if (!BRAND_ASSETS.has(assetName)) {
      res.status(404).send("Brand asset not found");
      return;
    }
    try {
      const signedUrl = await storageGetSignedUrl(`brand/${assetName}`);
      res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
      res.redirect(307, signedUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Object not found")) {
        console.warn(`[BrandAssetProxy] staging asset missing, using embedded fallback: ${assetName}`);
        sendBrandFallback(assetName, res);
        return;
      }
      console.error("[BrandAssetProxy] failed:", err);
      res.status(502).send("Brand asset storage error");
    }
  });
}
