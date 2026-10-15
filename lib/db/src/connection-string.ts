/**
 * pg 8 already treats sslmode=prefer, require and verify-ca as verify-full,
 * and warns that pg 9 will switch them to weaker libpq semantics. Spelling out
 * verify-full keeps today's certificate checks under either version and stops
 * the warning. Other modes (disable, no-verify, verify-full) and URLs that opt
 * into libpq compatibility are returned unchanged.
 *
 * Only the query string is rewritten, so credentials keep their exact
 * encoding. DATABASE_URL itself is left alone: libpq clients read verify-full
 * as requiring a local root certificate file.
 */
export function pinVerifiedSslMode(connectionString: string): string {
  const queryStart = connectionString.indexOf("?");
  if (queryStart === -1) return connectionString;
  const fragmentStart = connectionString.indexOf("#");
  if (fragmentStart !== -1 && fragmentStart < queryStart) {
    return connectionString;
  }
  const queryEnd =
    fragmentStart === -1 ? connectionString.length : fragmentStart;
  const parameters = connectionString
    .slice(queryStart + 1, queryEnd)
    .split("&");
  if (parameters.includes("uselibpqcompat=true")) return connectionString;
  let changed = false;
  const pinned = parameters.map((parameter) => {
    if (!/^sslmode=(?:prefer|require|verify-ca)$/.test(parameter)) {
      return parameter;
    }
    changed = true;
    return "sslmode=verify-full";
  });
  if (!changed) return connectionString;
  return `${connectionString.slice(0, queryStart + 1)}${pinned.join("&")}${connectionString.slice(queryEnd)}`;
}
