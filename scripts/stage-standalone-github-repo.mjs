import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = process.argv[2]
  ? resolve(process.argv[2])
  : join(root, "dist/standalone-github-repo");
if (existsSync(destination)) {
  throw new Error(
    "Bundle already exists. Preserve or move it before staging a fresh bundle.",
  );
}
mkdirSync(destination, { recursive: true });
function copy(source, target = source) {
  const output = join(destination, target);
  mkdirSync(dirname(output), { recursive: true });
  cpSync(join(root, source), output, { recursive: true });
}
function json(target, value) {
  writeFileSync(
    join(destination, target),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
for (const name of [
  "langchain_agent.py",
  "llamaindex_agent.py",
  "requirements-langchain.txt",
  "requirements-llamaindex.txt",
  "README.md",
  "test_agents.py",
])
  copy(`cookbooks/frameworks/${name}`, `cookbooks/${name}`);
const cookbookReadme = join(destination, "cookbooks/README.md");
writeFileSync(
  cookbookReadme,
  readFileSync(cookbookReadme, "utf8").replace(
    "Download the matching script and requirements from `/cookbooks/frameworks/`.",
    "Run the commands below from this `cookbooks/` directory; matching scripts and requirements are bundled beside this guide.",
  ),
);
copy("smithery.yaml");
copy("lib/api-spec/openapi.yaml", "openapi.yaml");
const require = createRequire(join(root, "artifacts/api-server/package.json"));
const { parse } = require("yaml");
json(
  "openapi.json",
  parse(readFileSync(join(root, "lib/api-spec/openapi.yaml"), "utf8")),
);
copy("sdk/typescript/LICENSE", "LICENSE");
copy("LICENSE.md");
copy("SECURITY.md");
for (const name of [
  "src",
  "client.ts",
  "client.test.ts",
  "tsconfig.json",
  "tsconfig.mcp.json",
  "LICENSE",
  "LICENSE.md",
])
  copy(`sdk/typescript/${name}`);
for (const name of ["client.py", "bitcoin_stratigraphy.py", "test_client.py"]) {
  copy(`sdk/python/${name}`);
}
const sdkPackage = JSON.parse(
  readFileSync(join(root, "sdk/typescript/package.json"), "utf8"),
);
sdkPackage.scripts.prepare = "npm run build";
sdkPackage.scripts.prepack = "npm run build";
sdkPackage.scripts.test = "tsx --test client.test.ts";
json("sdk/typescript/package.json", sdkPackage);
writeFileSync(
  join(destination, "sdk/typescript/README.md"),
  "# TypeScript REST and MCP clients\n\nSee [the distribution guide](../../README.md#typescript-sdk).\n\n" +
    "Run `npm install`, `npm test`, and `npm run build` in this directory. " +
    "The MCP entrypoint is `client.ts`; the REST entrypoint is `src/index.ts`. " +
    "Package exports resolve to the generated `dist/` files after building.\n",
);
copy("distribution/examples", "examples");
copy("distribution/test", "test");
copy("distribution/scripts", "scripts");
copy("distribution/README.standalone.md", "README.md");
const canonical = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = readFileSync(join(root, "smithery.yaml"), "utf8");
const version = manifest.match(/^version: "([^"]+)"$/m)?.[1];
if (!version) throw new Error("Canonical registry manifest has no version");
json("package.json", {
  name: "bitcoin-stratigraphy-mcp",
  mcpName: canonical.mcpName,
  version,
  description:
    "Standalone remote MCP distribution and native framework toolkits",
  license: canonical.license,
  type: "module",
  private: false,
  engines: { node: ">=22" },
  scripts: {
    sandbox: "node examples/free-sandbox.mjs",
    verify: "node scripts/verify-export.mjs",
    test: "node --test test/*.test.mjs",
  },
  keywords: [
    "mcp",
    "l402",
    "opentimestamps",
    "langchain",
    "llamaindex",
    "bitcoin",
  ],
});
json("mcp.json", {
  mcpServers: {
    "bitcoin-stratigraphy": {
      url: "https://bitcoinstratigraphy.com/mcp",
    },
  },
});
writeFileSync(
  join(destination, ".gitignore"),
  "node_modules/\ndist/\n__pycache__/\n*.pyc\n*.tsbuildinfo\n.env\n.env.*\n",
);
console.log(`Staged ${destination}`);
