// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import {pool} from "../src/index";
import {applyLedgerIndexes, LedgerIndexError} from "../src/ledger-indexes";

let failed = false;
try {
  const client = await pool.connect();
  try {
    const report = await applyLedgerIndexes(client);
    console.log(JSON.stringify(report, null, 2));
    if (report.deferred.length) {
      console.error("Some tables or columns are not initialized. Start the normal application schema, then rerun db:indexes.");
      failed = true;
    }
  } finally { client.release(); }
} catch (error) {
  console.error(error instanceof LedgerIndexError ? error.message :
    "Online index migration failed; inspect PostgreSQL diagnostics securely before retrying.");
  failed = true;
} finally { await pool.end(); }
if (failed) process.exitCode = 1;
