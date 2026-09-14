export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Bitcoin Stratigraphy API",
    version: "1.0.0",
    description:
      "Browsable Bitcoin stratigraphy records with a 21-satoshi L402-protected full dataset.",
  },
  servers: [{ url: "/api", description: "API base path" }],
  paths: {
    "/healthz": {
      get: {
        summary: "Health check",
        responses: {
          "200": {
            description: "API server is healthy",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthStatus" },
              },
            },
          },
        },
      },
    },
    "/v1/stratigraphy/sample": {
      get: {
        summary: "Get the free five-record sample",
        responses: {
          "200": {
            description: "Latest five stratigraphy records",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  minItems: 5,
                  maxItems: 5,
                  items: { $ref: "#/components/schemas/StratigraphyEntry" },
                },
              },
            },
          },
        },
      },
    },
    "/v1/stratigraphy": {
      get: {
        summary: "Get the complete L402-protected dataset",
        description:
          "Without a valid L402 payment proof, creates a 21-satoshi invoice and returns an L402 challenge.",
        security: [{ L402: [] }],
        responses: {
          "200": {
            description: "Complete stratigraphy dataset after payment",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/StratigraphyEntry" },
                },
              },
            },
          },
          "402": {
            description: "Lightning payment required",
            headers: {
              "WWW-Authenticate": {
                description:
                  "L402 challenge containing the payment hash and BOLT11 invoice",
                schema: { type: "string" },
              },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/L402Challenge" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      L402: {
        type: "apiKey",
        in: "header",
        name: "Authorization",
        description: "L402 <payment_hash>:<preimage>",
      },
    },
    schemas: {
      HealthStatus: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
      },
      L402Challenge: {
        type: "object",
        properties: {
          invoice: { type: "string", description: "BOLT11 invoice" },
          payment_hash: {
            type: "string",
            pattern: "^[0-9a-f]{64}$",
          },
        },
        required: ["invoice", "payment_hash"],
      },
      StratigraphyEntry: {
        type: "object",
        properties: {
          day: { type: "integer" },
          title: { type: "string" },
          video_id: { type: "string" },
          transcript_summary: { type: "string" },
        },
        required: ["day", "title", "video_id", "transcript_summary"],
      },
    },
  },
} as const;