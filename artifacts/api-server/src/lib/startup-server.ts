// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
// Binds the HTTP port before the application bundle loads. Requests that
// arrive while the application is still loading are held and replayed in
// arrival order once it attaches, instead of being refused (which the platform
// proxy reports as HTTP 500). Keep this module free of non-builtin imports: it
// runs before any application code is evaluated.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export type RequestListener = (
  req: IncomingMessage,
  res: ServerResponse,
) => void;

export type StartupServerOptions = {
  /** Longest time a request waits for the application before a 503. */
  maxHoldMs?: number;
  /** Upper bound on simultaneously held requests; excess requests get a 503. */
  maxHeldRequests?: number;
  retryAfterSeconds?: number;
};

export type StartupServer = {
  readonly server: Server;
  readonly heldRequests: number;
  listen(port: number, host: string): Promise<void>;
  /** Route held and future requests to the application. */
  attach(listener: RequestListener): void;
  /** Answer held requests with 503 and stop holding new ones. */
  fail(): void;
};

type HeldRequest = {
  req: IncomingMessage;
  res: ServerResponse;
  timer: NodeJS.Timeout;
  onClose: () => void;
};

export function createStartupServer(
  options: StartupServerOptions = {},
): StartupServer {
  // Long enough for a slow cold boot; clients that give up earlier are dropped.
  const maxHoldMs = options.maxHoldMs ?? 60_000;
  const maxHeldRequests = options.maxHeldRequests ?? 1_024;
  const retryAfter = String(options.retryAfterSeconds ?? 5);
  const held = new Set<HeldRequest>();
  let failed = false;
  let attached = false;

  const unavailable = (res: ServerResponse) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(503, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": retryAfter,
    });
    res.end(JSON.stringify({ error: "Server is starting; retry shortly" }));
  };

  const release = (entry: HeldRequest) => {
    held.delete(entry);
    clearTimeout(entry.timer);
    entry.res.removeListener("close", entry.onClose);
  };

  const hold: RequestListener = (req, res) => {
    if (failed || held.size >= maxHeldRequests) {
      unavailable(res);
      return;
    }
    const entry: HeldRequest = {
      req,
      res,
      timer: setTimeout(() => {
        release(entry);
        unavailable(res);
      }, maxHoldMs),
      // A client that disconnects while waiting is simply forgotten.
      onClose: () => release(entry),
    };
    held.add(entry);
    res.once("close", entry.onClose);
  };

  const server = createServer(hold);

  return {
    server,
    get heldRequests() {
      return held.size;
    },
    listen(port, host) {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
    },
    attach(listener) {
      if (attached) throw new Error("Startup server already attached");
      if (failed) throw new Error("Startup server already failed");
      attached = true;
      server.removeListener("request", hold);
      server.on("request", listener);
      for (const entry of [...held]) {
        release(entry);
        if (!entry.res.destroyed) listener(entry.req, entry.res);
      }
    },
    fail() {
      if (attached) return;
      failed = true;
      for (const entry of [...held]) {
        release(entry);
        unavailable(entry.res);
      }
    },
  };
}
