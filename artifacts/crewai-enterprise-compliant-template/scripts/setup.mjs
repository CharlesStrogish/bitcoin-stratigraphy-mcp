import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error || result.status !== 0) {
    console.error("Setup failed. Confirm Python 3.11–3.13, pip, Node 22.16+ and pnpm 10.26.1.");
    process.exit(result.status || 1);
  }
}
const python = process.env.PYTHON || "python";
run(python, ["-c", "import sys; assert (3, 11) <= sys.version_info[:2] < (3, 14), 'Python 3.11–3.13 required'"]);
run(python, ["-m", "pip", "install", "-r", "requirements.lock"]);
run("pnpm", ["--dir", "dashboard", "--ignore-workspace", "install", "--frozen-lockfile"]);
run("pnpm", ["--dir", "dashboard", "--ignore-workspace", "run", "build"]);
console.log("Setup complete. Run npm start for the safe local demo.");
