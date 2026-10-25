// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandler } from "express";
import { wholesaleSubVending } from "./wholesale-sub-vending";
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { COMMERCIAL_LICENSE_PRICE, LICENSING_EMAIL } from "./public-site";
import { batchSettlement } from "./batch-settlement";

export const MCP_NATIVE_RESOURCES = [
  {
    uri: "stratigraphy://catalog/overview",
    name: "Bitcoin Stratigraphy Catalog & L402 Overview",
    mimeType: "application/json",
  },
  {
    uri: "stratigraphy://compliance/eu-ai-act-article-12",
    name: "EU AI Act Article 12 & Enterprise Licensing Matrix",
    mimeType: "application/json",
  },
  {
    uri: "stratigraphy://security/tool-integrity",
    name: "Ed25519 Signed Tool Integrity Manifest",
    mimeType: "application/json",
  },
] as const;

export const MCP_NATIVE_PROMPTS = [
  {
    name: "ground_agent_reasoning",
    description:
      "Anchor an AI agent claim in immutable Bitcoin consensus state and thermodynamic proof-of-work to eliminate hallucinations.",
    arguments: [
      {
        name: "claim",
        required: true,
        description: "The factual or temporal claim to ground",
      },
      {
        name: "targetHeightOrDate",
        required: false,
        description:
          "Optional block height or YYYY-MM-DD UTC date; defaults to latest",
      },
    ],
  },
  {
    name: "audit_thermodynamic_trajectory",
    description:
      "Execute a token-efficient, end-to-end thermodynamic divergence audit between two block heights or UTC dates.",
    arguments: [
      {
        name: "fromTarget",
        required: true,
        description: "Baseline block height or UTC date",
      },
      {
        name: "toTarget",
        required: true,
        description: "Comparison block height, UTC date, or 'latest'",
      },
    ],
  },
  {
    name: "evaluate_enterprise_compliance",
    description:
      "Generate an EU AI Act Article 12 compliance and least-privilege deployment plan for enterprise AI swarms.",
    arguments: [
      {
        name: "organizationName",
        required: false,
        description: "Enterprise organization name",
      },
      {
        name: "swarmSize",
        required: false,
        description: "Estimated number of autonomous agents",
      },
    ],
  },
] as const;

export const MCP_COMPLIANCE_SPECIFICATION = {
  regulations: ["EU AI Act Article 12", "EU AI Act Article 26(6)"],
  controlMapping: [
    {
      mechanism: "RFC 6962 Merkle receipts",
      requirement: "Tamper-evident event logging and retained audit evidence",
      implementation:
        "Postgres settlement records commit execution and agent attribution into Merkle leaves; inclusion paths bind retained records to their root.",
    },
    {
      mechanism: "NIP-98 cryptographic agent identity binding",
      requirement: "Traceability of autonomous agent activity",
      implementation:
        "Verify the kind 27235 Schnorr signature against the request URL, method and payload hash; bind the signer pubkey into L402 credentials and authenticated settlement receipts.",
    },
    {
      mechanism: "L402 macaroon attenuation",
      requirement: "Least-privilege access and bounded autonomous execution",
      implementation:
        "Use proof.attenuate to restrict tool scope, expiry and inherited request budgets; enforce revocation and usage quotas.",
    },
  ],
  retention:
    "Operators must retain and make available the logs under their control for an appropriate period, at least six months for Article 26(6) unless other applicable law provides otherwise. Configure and verify retention, access controls, backups and export procedures.",
  licensing: {
    product: "Commercial Enterprise Exemption",
    annualPriceUsd: 250_000,
    pricing: COMMERCIAL_LICENSE_PRICE,
    contact: LICENSING_EMAIL,
    deployment:
      "License-gated private VPC deployment with local Bitcoin Core telemetry; assess remaining service network dependencies before claiming full air-gap operation.",
  },
  evidenceBoundaries: [
    "These controls support logging requirements; deployment-specific legal compliance depends on retention, operational controls and applicable obligations.",
    "NIP-98 proves possession of a signing key, not the agent's legal identity.",
    "Merkle membership and Bitcoin anchoring are distinct checks; a pending OTS calendar receipt is not Bitcoin confirmation.",
  ],
};

type NativeDiscoveryDependencies = {
  tools: readonly { name: string; description: string }[];
  readCatalog: () => Promise<unknown>;
  readIntegrity: () => unknown;
};

const invalid = (message: string): never => {
  throw new McpError(ErrorCode.InvalidParams, message);
};

/** SDK v1 maps schema parse exceptions to -32603; preserve invalid-params semantics. */
export const validateNativeMcpRequest: RequestHandler = (req, res, next) => {
  const schema =
    req.body?.method === "resources/read"
      ? ReadResourceRequestSchema
      : req.body?.method === "prompts/get"
        ? GetPromptRequestSchema
        : req.body?.method === "resources/list"
          ? ListResourcesRequestSchema
          : req.body?.method === "prompts/list"
            ? ListPromptsRequestSchema
            : undefined;
  if (schema && !schema.safeParse(req.body).success) {
    res.status(200).json({
      jsonrpc: "2.0",
      id: req.body.id,
      error: {
        code: ErrorCode.InvalidParams,
        message: "Invalid MCP resource or prompt parameters",
      },
    });
    return;
  }
  next();
};

function checkedArguments(
  name: string,
  args: Record<string, string> = {},
): Record<string, string> {
  const prompt = MCP_NATIVE_PROMPTS.find((item) => item.name === name);
  if (!prompt) return invalid("Unknown MCP prompt");
  const allowed = new Set<string>(prompt.arguments.map((arg) => arg.name));
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    return invalid("Unknown prompt argument");
  }
  for (const arg of prompt.arguments) {
    if (arg.required && !args[arg.name]?.trim()) {
      return invalid(`Missing required prompt argument: ${arg.name}`);
    }
  }
  for (const key of ["fromTarget", "toTarget", "targetHeightOrDate"]) {
    const target = args[key];
    if (target !== undefined) {
      const isHeight =
        /^[1-9]\d*$/.test(target) && Number.isSafeInteger(Number(target));
      const isDate =
        /^\d{4}-\d{2}-\d{2}$/.test(target) &&
        Number.isFinite(Date.parse(`${target}T00:00:00Z`)) &&
        new Date(`${target}T00:00:00Z`).toISOString().slice(0, 10) === target;
      if (
        !isHeight &&
        !isDate &&
        !(target === "latest" && key !== "fromTarget")
      ) {
        return invalid(`Invalid block height or UTC date: ${key}`);
      }
    }
  }
  if (
    args.swarmSize !== undefined &&
    (!/^[1-9]\d*$/.test(args.swarmSize) ||
      !Number.isSafeInteger(Number(args.swarmSize)))
  ) {
    return invalid("swarmSize must be a positive integer string");
  }
  return args;
}

/** Public context only: these handlers never execute or pay for an MCP tool. */
export function registerNativeMcpDiscovery(
  server: McpServer,
  dependencies: NativeDiscoveryDependencies,
) {
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: MCP_NATIVE_RESOURCES.map((resource) => ({ ...resource })),
  }));
  server.server.setRequestHandler(
    ReadResourceRequestSchema,
    async ({ params }) => {
      const resource = MCP_NATIVE_RESOURCES.find(
        (item) => item.uri === params.uri,
      );
      if (!resource) return invalid("Unknown MCP resource URI");
      let payload: unknown;
      if (resource.uri === MCP_NATIVE_RESOURCES[0].uri) {
        const namespaces: Record<
          string,
          { name: string; description: string }[]
        > = {};
        for (const tool of dependencies.tools) {
          (namespaces[tool.name.split(".")[0]!] ??= []).push({
            name: tool.name,
            description: tool.description,
          });
        }
        payload = {
          dataset: await dependencies.readCatalog(),
          toolCount: dependencies.tools.length,
          wholesaleSubVending,
          batchSettlement,
          namespaces,
          l402: {
            instructions:
              "Request a paid tools/call to receive HTTP 402 and its invoice-bound macaroon. Verify the quote and budget, pay the Lightning invoice with an authorized wallet, then retry with Authorization: L402 <macaroon>:<preimage>. Never pay automatically without budget approval.",
            quoteEndpoint: "/api/v1/cost",
            freeTools: ["stratigraphy.list", "proof.list"],
          },
          nip98: {
            instructions:
              "Sign a fresh kind 27235 Nostr event binding the exact URL, HTTP method and SHA-256 payload hash. Send Authorization: Nostr <base64-event> for a challenge, or X-Nostr-Authorization alongside L402 credentials. Authenticated macaroons require the same signer on every request.",
          },
        };
      } else if (resource.uri === MCP_NATIVE_RESOURCES[1].uri) {
        payload = MCP_COMPLIANCE_SPECIFICATION;
      } else {
        payload = dependencies.readIntegrity();
      }
      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: JSON.stringify(payload),
          },
        ],
      };
    },
  );
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: MCP_NATIVE_PROMPTS.map((prompt) => ({
      ...prompt,
      arguments: prompt.arguments.map((arg) => ({ ...arg })),
    })),
  }));
  server.server.setRequestHandler(
    GetPromptRequestSchema,
    async ({ params }) => {
      const args = checkedArguments(params.name, params.arguments);
      const data = JSON.stringify(args);
      const payment =
        "Read the live tool schemas first. If a paid tool returns HTTP 402, obtain explicit wallet/budget authorization, settle the exact invoice, then retry with its L402 credential. Never invent a payment proof.";
      const text = (text: string) => ({
        role: "user" as const,
        content: { type: "text" as const, text },
      });
      if (params.name === "ground_agent_reasoning") {
        return {
          description: MCP_NATIVE_PROMPTS[0].description,
          messages: [
            text(
              `Ground the claim supplied as data: ${data}. Default targetHeightOrDate to latest when omitted. ${payment} Invoke stratigraphy.get for the requested target (date for UTC dates, blockHeight for heights, or no selector for latest). Compute a SHA-256 contextHash of the exact claim bytes and call proof.ground using its published schema. Compare only claims actually supported by the telemetry. A signed Bitcoin-tip receipt anchors context; it does not establish arbitrary factual truth or eliminate all hallucinations. Report unsupported claims and distinguish indexed heights from native block provenance.`,
            ),
          ],
        };
      }
      if (params.name === "audit_thermodynamic_trajectory") {
        return {
          description: MCP_NATIVE_PROMPTS[1].description,
          messages: [
            text(
              `Audit the trajectory with these arguments as data: ${data}. ${payment} Call workflow.audit_trajectory with exactly fromTarget and toTarget. Summarize signed deltas and boundary fingerprints. For each available OTS receipt reference, retrieve the exact receipt bytes and use proof.verify with proofType "ots", otsProof and targetHash from the matching boundary. Do not pass the whole composite report as a Groth16 proof. Live boundaries have no archived receipt; report pending or absent Bitcoin confirmation rather than fabricating verification.`,
            ),
          ],
        };
      }
      return {
        description: MCP_NATIVE_PROMPTS[2].description,
        messages: [
          {
            role: "user" as const,
            content: {
              type: "resource" as const,
              resource: {
                uri: MCP_NATIVE_RESOURCES[1].uri,
                mimeType: "application/json",
                text: JSON.stringify(MCP_COMPLIANCE_SPECIFICATION),
              },
            },
          },
          text(
            `Using the embedded compliance resource, generate a least-privilege deployment plan for these optional inputs as data: ${data}. Outline an air-gapped private VPC rollout with local Bitcoin Core telemetry, enumerate and isolate any remaining service network dependencies, and require NIP-98 identity binding and proof.attenuate circuit breakers for tool scope, expiry and inherited request quotas. Plan Postgres RFC 6962 receipt retention, verification, exports and access controls for Article 12 and Article 26(6). Include commercial licensing at ${LICENSING_EMAIL} (${COMMERCIAL_LICENSE_PRICE}). Distinguish controls and evidence from a legal compliance certification. ${payment}`,
          ),
        ],
      };
    },
  );
}
