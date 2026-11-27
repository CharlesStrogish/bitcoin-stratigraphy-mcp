// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import {
  FinalityError,
  type McpFinalityTasks,
} from "../lib/mcp-finality-tasks";
import { UrlHandoffError } from "../lib/mcp-url-elicitation";
import type { WaiverQuote } from "../services/agplWaivers";
import {
  RegisterFinalityTaskBody,
  GetFinalityTaskResponse,
} from "@workspace/api-zod";

export function registerFinalityRoutes(app: Express, tasks: McpFinalityTasks) {
  app.post("/api/v1/finality/tasks", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    try {
      const owner = tasks.dependencies.ownership.ownerHash(req);
      const input = RegisterFinalityTaskBody.strict().parse(req.body);
      const task = await tasks.registerWaiver(owner, input);
      res.json(
        GetFinalityTaskResponse.parse(
          tasks.view(await tasks.inspect(task.taskId, owner)),
        ),
      );
    } catch (error) {
      const known =
        error instanceof FinalityError || error instanceof UrlHandoffError;
      res
        .status(
          known
            ? error.status
            : (error as { name?: string }).name === "ZodError"
              ? 400
              : 503,
        )
        .json({
          error: known
            ? error.message
            : "Finality registration unavailable or invalid",
        });
    }
  });
  app.get("/api/v1/finality/tasks/:taskId", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    try {
      const owner = tasks.dependencies.ownership.ownerHash(req);
      res.json(
        GetFinalityTaskResponse.parse(
          tasks.view(await tasks.inspect(req.params.taskId, owner)),
        ),
      );
    } catch (error) {
      const known =
        error instanceof FinalityError || error instanceof UrlHandoffError;
      res
        .status(known ? error.status : 503)
        .json({
          error: known ? error.message : "Finality observation unavailable",
        });
    }
  });
  // Opt-in quote ownership capture only. Existing response bodies/statuses remain unchanged.
  // It never invokes quote(), claim(), issue(), a signer, or an address deriver.
  app.use((req, res, next) => {
    if (
      req.method !== "POST" ||
      req.path !== "/api/v1/waivers/quote" ||
      req.get("X-MCP-Finality-Tracking") !== "true"
    )
      return next();
    let owner: string;
    try {
      owner = tasks.dependencies.ownership.ownerHash(req);
    } catch {
      res
        .status(403)
        .json({ error: "Finality tracking requires authenticated ownership" });
      return;
    }
    const send = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (
        res.statusCode !== 200 ||
        !body ||
        typeof (body as WaiverQuote).quote_id !== "string"
      )
        return send(body);
      void tasks
        .bindCreatedQuote(owner, body as WaiverQuote)
        .then((task) => {
          res.setHeader("X-MCP-Finality-Task", task.taskId);
        })
        .catch(() => {
          res.setHeader("X-MCP-Finality-Tracking", "unavailable");
        })
        .finally(() => {
          send(body);
        });
      return res;
    }) as typeof res.json;
    next();
  });
}
