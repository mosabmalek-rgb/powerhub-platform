import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");

  const indexPath = path.resolve(distPath, "index.html");
  const indexHtml = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : null;

  if (indexHtml === null) {
    console.error(`Could not find the build directory entry point: ${indexPath}, make sure to build the client first`);
  }

  app.use(express.static(distPath));
  // The trusted build artifact is loaded once when the app is mounted; the
  // catch-all request handler does not perform filesystem access per request.
  app.use("*", (_req, res) => {
    if (indexHtml === null) return res.sendStatus(503);
    return res.type("html").send(indexHtml);
  });
}
