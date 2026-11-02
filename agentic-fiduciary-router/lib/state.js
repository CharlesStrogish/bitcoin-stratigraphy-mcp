import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** Local durable state. One directory must be shared by all workers of a wallet. */
export class FileState {
  constructor(directory) { this.directory = resolve(directory); }

  async transaction(update) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, "state.lock");
    let lock;
    // Short bounded contention retry; never discard a stale/unknown lock.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { lock = await open(lockPath, "wx", 0o600); break; }
      catch (error) {
        if (error.code !== "EEXIST") throw new Error("STATE_UNAVAILABLE");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    if (!lock) throw new Error("STATE_LOCKED");
    let temporary;
    try {
      let state;
      try { state = JSON.parse(await readFile(join(this.directory, "state.json"), "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw new Error("STATE_CORRUPT");
        state = { reservedMsats: "0", blocked: false, invoices: {} };
      }
      if (!state || !/^\d+$/.test(state.reservedMsats) ||
          typeof state.blocked !== "boolean" || !state.invoices ||
          typeof state.invoices !== "object" || Array.isArray(state.invoices)) throw new Error("STATE_CORRUPT");
      const result = update(state);
      temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(this.directory, "state.json"));
      temporary = undefined;
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return result;
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await lock.close();
      await unlink(lockPath);
    }
  }
}
