import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  return config;
};

const clientTransformer: InputTransformerFn = (config) => {
  config = titleTransformer(config);
  // The existing canonical ledger hook already requests /api/yield-proofs.json.
  // Avoid a duplicate hook: the client's fixed /api base would prefix it twice.
  // This only filters client generation, never the published full contract.
  delete config.paths?.["/api/yield-proofs.json"];
  // Some origin-level paths already include /api. Orval prepends the fixed
  // client base unconditionally, so strip that prefix in its input copy only.
  // Rebuild in insertion order to keep generated operations stable.
  if (config.paths) {
    const paths: typeof config.paths = {};
    for (const [route, item] of Object.entries(config.paths)) {
      const clientRoute = route.startsWith("/api/") ? route.slice(4) : route;
      if (Object.hasOwn(paths, clientRoute)) {
        throw new Error(`Conflicting generated client route: ${clientRoute}`);
      }
      paths[clientRoute] = item;
    }
    config.paths = paths;
  }
  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: clientTransformer,
      },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      schemas: { path: "generated/types", type: "typescript" },
      mode: "split",
      clean: true,
      prettier: true,
      override: {
        zod: {
          // Keep generated validators on the patched catalog's Zod major.
          version: 4,
          coerce: {
            query: ["boolean", "number", "string"],
            param: ["boolean", "number", "string"],
            body: ["bigint", "date"],
            response: ["bigint", "date"],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
