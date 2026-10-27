import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export function checkoutApp(mode: string) {
  if (mode !== "conference") {
    throw new Error(`Startup validation failed: CHECKOUT_MODE must be conference; received ${mode}`);
  }
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
      res.status(415).json({ error: "Compressed requests are not supported" }); return;
    }
    next();
  });
  app.use(express.json({ limit: "4kb", inflate: false }));
  app.get("/health/live", (_req, res) => res.json({ status: "live" }));
  app.get("/health/ready", (_req, res) => res.json({ status: "ready" }));
  app.post("/api/checkout", (req, res) => {
    const body = z.object({ sku: z.literal("conference-pass"), quantity: z.number().int().min(1).max(5) })
      .strict().safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Expected conference-pass and a quantity from 1 to 5" });
      return;
    }
    const order = { orderId: randomUUID(), sku: body.data.sku, quantity: body.data.quantity,
      total: body.data.quantity * 49, currency: "USD", synthetic: true };
    console.log(JSON.stringify({ event: "checkout.completed", at: new Date().toISOString(), ...order }));
    res.status(201).json(order);
  });
  return app;
}
