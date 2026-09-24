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

type StoreOptions = {
  url?: string | null;
  production?: boolean;
  localFile?: string;
};

async function createLocalStateStore(file: string): Promise<StateStore> {
  // Preflight local storage before the first invoice is paid. An absent file
  // is valid uninitialized state; an unreadable/corrupt one fails before pay.
  try {
    await writeFile(file, "null", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const store: StateStore = {
    async load() {
      return JSON.parse(await readFile(file, "utf8")) as Checkpoint | null;
    },
    async save(value) {
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, file);
    },
    async close() {},
  };
  await store.load();
  return store;
}

export async function createStateStore(options: StoreOptions = {}): Promise<StateStore> {
  const url = options.url === undefined
    ? process.env.DATABASE_URL?.trim() || process.env.REPLIT_DB?.trim()
    : options.url?.trim();
  const production = options.production ?? process.env.NODE_ENV === "production";
  if (url) {
    if (!/^postgres(?:ql)?:\/\//.test(url)) {
      if (production) throw new Error("DATABASE_URL or REPLIT_DB must be a PostgreSQL connection URL");
      console.warn("PostgreSQL URL is not configured; using local development checkpoint file");
      return createLocalStateStore(resolve(options.localFile ?? ".autonomous-agent-state.json"));
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
      if (production) throw error;
      console.warn("PostgreSQL is not initialized; using local development checkpoint file");
      return createLocalStateStore(resolve(options.localFile ?? ".autonomous-agent-state.json"));
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
  if (production) {
    throw new Error("Production requires a Replit PostgreSQL DATABASE_URL before auto-pay");
  }
  return createLocalStateStore(resolve(options.localFile ?? ".autonomous-agent-state.json"));
}