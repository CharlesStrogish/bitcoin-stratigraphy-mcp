import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

export type Checkpoint = {
  snapshotKey: string;
  verified: boolean;
  broadcastDate?: string;
};

export type StateStore = {
  load(): Promise<Checkpoint | null>;
  save(checkpoint: Checkpoint): Promise<void>;
  close(): Promise<void>;
};

export async function createStateStore(): Promise<StateStore> {
  const url = process.env.DATABASE_URL?.trim() || process.env.REPLIT_DB?.trim();
  if (url) {
    if (!/^postgres(?:ql)?:\/\//.test(url)) {
      throw new Error("DATABASE_URL or REPLIT_DB must be a PostgreSQL connection URL");
    }
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stratigraphy_agent_checkpoint (
          id text PRIMARY KEY,
          value jsonb NOT NULL
        )
      `);
    } catch (error) {
      await pool.end();
      throw error;
    }
    return {
      async load() {
        const { rows } = await pool.query<{ value: Checkpoint }>(
          "SELECT value FROM stratigraphy_agent_checkpoint WHERE id = $1",
          ["main"],
        );
        return rows[0]?.value ?? null;
      },
      async save(value) {
        await pool.query(
          `INSERT INTO stratigraphy_agent_checkpoint (id, value)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
          ["main", JSON.stringify(value)],
        );
      },
      close: () => pool.end(),
    };
  }

  // Avoid double payment after a Reserved VM restart: production needs durable DB.
  if (process.env.NODE_ENV === "production") {
    throw new Error("Production requires a Replit PostgreSQL DATABASE_URL before auto-pay");
  }
  const file = resolve(".autonomous-agent-state.json");
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, "utf8")) as Checkpoint;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async save(value) {
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, file);
    },
    async close() {},
  };
}