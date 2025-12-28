import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { config } from "./config.js";
import { migrate } from "./db.js";
import { rateLimit, requireAuth } from "./middleware.js";
import * as h from "./routes.js";

async function main() {
  await migrate();

  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: "256kb" }));
  app.use(morgan("dev"));

  // CORS: allow your site + local dev
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(new Error("CORS blocked"));
      },
      credentials: true,
    })
  );

  app.get("/api/health", h.health);

  // Swagger docs
  const openapiPath = path.join(process.cwd(), "src", "openapi.yaml");
  const openapi = YAML.parse(fs.readFileSync(openapiPath, "utf-8"));
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openapi));

  app.use("/api", rateLimit);

  // Auth-required routes
  app.get("/api/me", requireAuth, h.me);

  // Checklists
  app.get("/api/checklists", requireAuth, h.listChecklists);
  app.post("/api/checklists", requireAuth, h.createChecklist);
  app.get("/api/checklists/:id", requireAuth, h.getChecklist);
  app.delete("/api/checklists/:id", requireAuth, h.deleteChecklist);
  app.post("/api/checklists/:id/steps", requireAuth, h.addStep);
  app.delete("/api/checklists/:id/steps/:stepId", requireAuth, h.deleteChecklistStep);
  app.post("/api/checklists/:id/steps/:stepId/toggle", requireAuth, h.toggleStep);

  // Incidents
  app.get("/api/incidents", requireAuth, h.listIncidents);
  app.post("/api/incidents", requireAuth, h.createIncident);
  app.post("/api/incidents/:id/updates", requireAuth, h.addIncidentUpdate);
  app.delete("/api/incidents/:id", requireAuth, h.deleteIncident);
  app.patch("/api/incidents/:id/status", requireAuth, h.patchIncidentStatus);

  // Team feed + online users (no ping endpoint needed)
  app.get("/api/messages", requireAuth, h.listMessages);
  app.post("/api/messages", requireAuth, h.sendMessage);
  app.get("/api/online", requireAuth, h.listOnline);
  app.get("/api/presence/online", requireAuth, h.listOnline);

  app.listen(config.port, () => {
    console.log(`LaunchOps API listening on http://localhost:${config.port}`);
    console.log(`Docs: http://localhost:${config.port}/api/docs`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});