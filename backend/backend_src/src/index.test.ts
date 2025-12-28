import request from "supertest";
import express from "express";
import * as h from "./routes.js";

test("health returns ok", async () => {
  const app = express();
  app.get("/api/health", h.health);
  const res = await request(app).get("/api/health");
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});
