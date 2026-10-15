// Process entry. Binds the HTTP port first, then loads the application bundle
// (dist/server.mjs). While the application loads, the platform proxy and
// connecting agents are held instead of refused, so a republish or container
// restart does not surface connection failures as HTTP 500s. Keep this file
// free of application imports: everything imported here is evaluated before
// the port opens.
import { createStartupServer } from "./lib/startup-server";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const startup = createStartupServer();
await startup.listen(port, "0.0.0.0");
const portBoundMs = performance.now();

// A computed specifier keeps the application out of this entry chunk.
const applicationUrl = new URL("./server.mjs", import.meta.url).href;
let application: typeof import("./server") | undefined;
try {
  application = (await import(applicationUrl)) as typeof import("./server");
} catch (error) {
  console.error("API application failed to load", error);
  // Answer held requests with 503, then exit so the platform restarts us.
  startup.fail();
  startup.server.close();
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1_000).unref();
}
application?.startApplication({ startup, port, portBoundMs });
