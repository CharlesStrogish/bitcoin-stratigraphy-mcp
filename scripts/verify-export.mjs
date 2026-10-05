import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = message => failures.push(message);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    ["node_modules", "dist", "__pycache__", ".git"].includes(entry.name) ? [] :
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
function localTarget(file, specifier, allowTypeScript = false) {
  const target = resolve(dirname(file), specifier.split("#")[0]);
  if (relative(root, target).startsWith("..")) return false;
  return existsSync(target) || (allowTypeScript &&
    (existsSync(target.replace(/\.js$/, ".ts")) || existsSync(`${target}.ts`)));
}
for (const file of files(root)) {
  const name = relative(root, file);
  const text = readFileSync(file, "utf8");
  if (name.endsWith(".json")) {
    try { JSON.parse(text); } catch { fail(`${name}: invalid JSON`); }
    if (name.endsWith("package.json") && /"(?:workspace:|catalog:|link:)/.test(text)) {
      fail(`${name}: workspace-only dependency`);
    }
  }
  if (/\.(?:ts|mjs|js)$/.test(name)) {
    for (const match of text.matchAll(/(?:from\s+|import\s*\()(["'])(\.[^"']+)\1/g)) {
      if (!localTarget(file, match[2], true)) fail(`${name}: missing import ${match[2]}`);
    }
  }
  if (name.endsWith(".md")) {
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (!/^(?:https?:|#|mailto:)/.test(target) && !localTarget(file, target)) {
        fail(`${name}: missing Markdown target ${target}`);
      }
    }
  }
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (pkg.mcpName !== "crstrogish/bitcoin-stratigraphy") fail("Missing canonical MCP identity");
const spec = JSON.parse(readFileSync(join(root, "openapi.json"), "utf8"));
function references(value) {
  if (!value || typeof value !== "object") return;
  if (value.$ref) {
    if (!value.$ref.startsWith("#/")) fail(`External OpenAPI reference: ${value.$ref}`);
    else {
      const target = value.$ref.slice(2).split("/").reduce(
        (parent, key) => parent?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
      if (target === undefined) fail(`Missing OpenAPI reference: ${value.$ref}`);
    }
  }
  for (const child of Object.values(value)) references(child);
}
references(spec);
for (const path of [
  "smithery.yaml", "openapi.yaml", "openapi.json", "mcp.json", "LICENSE",
  "cookbooks/langchain_agent.py", "cookbooks/llamaindex_agent.py",
  "sdk/typescript/client.ts", "sdk/python/client.py",
  "examples/free-sandbox.mjs", "scripts/verify-export.mjs", "test/free-sandbox.test.mjs",
]) {
  if (!existsSync(join(root, path))) fail(`Missing ${path}`);
}
for (const file of ["sdk/typescript/tsconfig.json", "sdk/typescript/tsconfig.mcp.json"]) {
  const config = JSON.parse(readFileSync(join(root, file), "utf8"));
  if (config.extends && !localTarget(join(root, file), config.extends)) fail(`${file}: broken extends`);
}
const requirement = readFileSync(join(root, "cookbooks/requirements-llamaindex.txt"), "utf8");
if (requirement.split("\n").some(line => line.trim() && !line.trim().startsWith("#"))) {
  fail("LlamaIndex requirements must preserve the security hold");
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Export checks passed: portable manifests, local imports, paths, and security hold.");
}