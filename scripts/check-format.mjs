import { execFileSync, spawnSync } from "node:child_process";

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((file) => /\.(?:[cm]?js|jsx|ts|tsx|css)$/.test(file));
const mode = process.argv.includes("--write") ? "--write" : "--check";
const prettier = spawnSync("pnpm", ["exec", "prettier", mode, ...files], {
  stdio: "inherit",
});
const python = spawnSync(
  "uv",
  [
    "run",
    "--no-sync",
    "ruff",
    "format",
    ...(mode === "--check" ? ["--check"] : []),
    ".",
  ],
  { stdio: "inherit" },
);
process.exitCode = prettier.status || python.status || 0;
