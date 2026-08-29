import type { Express } from "express";
import { storageGetSignedUrl } from "../storage";
import { ENV } from "./env";

const BRAND_ASSETS = new Set(["powerhub-logo-light.png", "powerhub-logo-dark.png"]);

function routeKey(req: { params: unknown }): string {
  return ((req.params as Record<string, string>)["0"] ?? "").replace(/^\/+/, "");
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
      console.error("[BrandAssetProxy] failed:", err);
      res.status(502).send("Brand asset storage error");
    }
  });
}

export function registerStorageProxy(app: Express) {
  app.get(["/manus-storage/*", "/api/manus-storage/*"], async (req, res) => {
    const key = routeKey(req);
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }
    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/",
      );
      forgeUrl.searchParams.set("path", key);
      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
      });
      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }
      const { url } = (await forgeResp.json()) as { url: string };
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}
