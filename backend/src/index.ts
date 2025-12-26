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

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked"));
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.options("*", cors());

app.get("/api/health", h.health);

// Checklists
app.delete("/api/checklists/:id", requireAuth, h.deleteChecklist);
app.delete("/api/checklists/:id/steps/:stepId", requireAuth, h.deleteStep);

// Incidents
app.delete("/api/incidents/:id", requireAuth, h.deleteIncident);

// Swagger docs
const openapiPath = path.join(process.cwd(), "src", "openapi.yaml");
const openapi = YAML.parse(fs.readFileSync(openapiPath, "utf-8"));
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openapi));

app.use("/api", rateLimit);

// Auth-required routes
app.get("/api/me", requireAuth, h.me);

app.get("/api/checklists", requireAuth, h.listChecklists);
app.post("/api/checklists", requireAuth, h.createChecklist);
app.get("/api/checklists/:id", requireAuth, h.getChecklist);
app.post("/api/checklists/:id/steps", requireAuth, h.addStep);
app.post("/api/checklists/:id/steps/:stepId/toggle", requireAuth, h.toggleStep);

app.delete("/api/checklists/:id", requireAuth, h.deleteChecklist);
app.delete("/api/checklists/:id/steps/:stepId", requireAuth, h.deleteChecklistStep);


app.get("/api/incidents", requireAuth, h.listIncidents);
app.post("/api/incidents", requireAuth, h.createIncident);
app.post("/api/incidents/:id/updates", requireAuth, h.addIncidentUpdate);
app.patch("/api/incidents/:id/status", requireAuth, h.patchIncidentStatus);

app.delete("/api/incidents/:id", requireAuth, h.deleteIncident);

app.get("/api/messages/threads", requireAuth, h.listMessageThreads);
app.get("/api/messages/with/:other", requireAuth, h.getConversation);
app.post("/api/messages", requireAuth, h.sendMessage);


  app.listen(config.port, () => {
    console.log(`LaunchOps API listening on http://localhost:${config.port}`);
    console.log(`Docs: http://localhost:${config.port}/api/docs`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});