import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { getStratigraphyData } from "./stratigraphy";

const quantitativeAlphaSchema = z.object({
  target_multiplier: z.number(),
  difficulty_epoch_progress: z.string(),
  thermodynamic_signal: z.string(),
});

const entrySchema = z.object({
  day: z.number().int(),
  title: z.string(),
  video_id: z.string(),
  transcript_summary: z.string(),
  quantitative_alpha: quantitativeAlphaSchema,
});

function createBitcoinStratigraphyMcpServer() {
  const server = new McpServer(
    {
      name: "bitcoin-stratigraphy",
      version: "1.0.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: {},
      },
    },
  );

  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [],
  }));

  server.registerTool(
    "get_bitcoin_stratigraphy",
    {
      title: "Get Bitcoin Stratigraphy",
      description:
        "Return validated Bitcoin Stratigraphy day entries. Use days for the most recent N entries or date for one exact YYYY-MM-DD entry.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnly: true,
        audience: ["assistant"],
        priority: 1,
      },
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(422)
          .optional()
          .describe("Number of most recent day entries to return"),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Exact dataset date in YYYY-MM-DD format"),
      },
      outputSchema: {
        records: z.array(entrySchema),
      },
    },
    async ({ days, date }) => {
      if (days !== undefined && date !== undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Provide either days or date, not both.",
            },
          ],
        };
      }

      try {
        const records = await getStratigraphyData({ days, date });
        const structuredContent = { records };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredContent),
            },
          ],
          structuredContent,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unable to retrieve stratigraphy data",
            },
          ],
        };
      }
    },
  );

  return server;
}

async function handleMcpRequest(
  req: Request,
  res: Response,
): Promise<void> {
  const server = createBitcoinStratigraphyMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    req.log.error({ err: error }, "MCP request failed");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  } finally {
    if (!res.headersSent || req.method !== "GET") {
      await transport.close();
      await server.close();
    } else {
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  }
}

export function registerMcpRoute(app: Express): void {
  app.all("/mcp", handleMcpRequest);
}