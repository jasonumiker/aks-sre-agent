import { checkoutApp } from "./checkout.js";

try {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
  const server = checkoutApp(process.env.CHECKOUT_MODE ?? "conference").listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "checkout.listening", port }));
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
} catch (error) {
  console.error(JSON.stringify({ event: "checkout.startup_failed", error: String(error) }));
  process.exitCode = 1;
}
