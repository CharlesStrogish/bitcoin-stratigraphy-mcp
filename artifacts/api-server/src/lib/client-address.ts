import { BlockList, isIP } from "node:net";
import type { Request, RequestHandler } from "express";

/**
 * Production traffic reaches Replit's router through Google's external load
 * balancer, which appends "<client>, <load balancer>" to X-Forwarded-For. The
 * router then appends the Google front end that connected to it, so the chain
 * reads "[caller-supplied…], client, load balancer, front end". Entries left of
 * the client are caller-controlled and never select a budget.
 */
const googleFrontEnds = new BlockList();
googleFrontEnds.addSubnet("35.191.0.0", 16, "ipv4");
googleFrontEnds.addSubnet("130.211.0.0", 22, "ipv4");

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

export type ClientAddressSource =
  /** Client entry ahead of Google's load balancer and front-end hops. */
  | "load-balancer"
  /** Rightmost entry appended by the trusted proxy (Express trust proxy). */
  | "forwarded"
  /** Socket peer: no forwarding headers, or headers from an untrusted peer. */
  | "direct"
  /** Loopback peer without forwarding headers, e.g. Replit platform probes. */
  | "loopback";

export type ResolvedClientAddress = {
  address: string;
  source: ClientAddressSource;
};

function stripDecorations(value: string): string {
  let address = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(":"));
  }
  // URL parsers reject IPv6 scope identifiers even though socket addresses
  // and net.isIP accept them. Interface names must not split a subnet budget.
  return address.includes(":") ? address.split("%")[0]! : address;
}

/** Canonical address with IPv4-mapped IPv6 folded to IPv4; undefined if not an IP. */
export function canonicalAddress(value: string): string | undefined {
  const address = stripDecorations(value);
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return undefined;
  const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const [left, right] = normalized.split("::");
  const leading = left ? left.split(":") : [];
  const trailing = right ? right.split(":") : [];
  const groups =
    right === undefined
      ? leading
      : [
          ...leading,
          ...Array(8 - leading.length - trailing.length).fill("0"),
          ...trailing,
        ];
  if (
    groups.slice(0, 5).every((group) => parseInt(group, 16) === 0) &&
    parseInt(groups[5]!, 16) === 0xffff
  ) {
    const high = parseInt(groups[6]!, 16);
    const low = parseInt(groups[7]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return groups.map((group) => parseInt(group, 16).toString(16)).join(":");
}

/** Budget key: IPv4 as-is; native IPv6 by /64, within which devices rotate. */
export function addressKey(address: string): string {
  const canonical = canonicalAddress(address);
  if (canonical === undefined) return address;
  if (isIP(canonical) === 4) return canonical;
  return `${canonical.split(":").slice(0, 4).join(":")}::/64`;
}

function forwardedEntries(req: Request): string[] {
  const header = req.headers?.["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  return raw
    ? raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

/**
 * True when Express already accepted the rightmost entry from a trusted peer
 * and that entry is a Google front end. Untrusted peers cannot reach this
 * path, because Express then reports the socket address instead.
 */
function endsAtGoogleFrontEnd(req: Request, entries: string[]): boolean {
  const last = entries.at(-1);
  if (last === undefined || req.ip === undefined) return false;
  const frontEnd = canonicalAddress(last);
  return (
    frontEnd !== undefined &&
    isIP(frontEnd) === 4 &&
    googleFrontEnds.check(frontEnd, "ipv4") &&
    canonicalAddress(req.ip) === frontEnd
  );
}

export function resolveClientAddress(req: Request): ResolvedClientAddress {
  const entries = forwardedEntries(req);
  if (entries.length >= 3 && endsAtGoogleFrontEnd(req, entries)) {
    const client = canonicalAddress(entries.at(-3)!);
    if (client !== undefined)
      return { address: client, source: "load-balancer" };
  }
  const peer = req.socket?.remoteAddress;
  const raw = req.ip || peer || "unknown";
  const address = canonicalAddress(raw) ?? raw;
  const canonicalPeer = peer === undefined ? undefined : canonicalAddress(peer);
  if (entries.length === 0) {
    const isLoopback =
      canonicalPeer !== undefined &&
      loopback.check(
        canonicalPeer,
        isIP(canonicalPeer) === 4 ? "ipv4" : "ipv6",
      );
    return { address, source: isLoopback ? "loopback" : "direct" };
  }
  return {
    address,
    source: canonicalPeer === address ? "direct" : "forwarded",
  };
}

/** Stable per-client key for budgets, challenge binding, and ledger identifiers. */
export function clientKey(req: Request): string {
  return addressKey(resolveClientAddress(req).address);
}

export type ClientChainSummary = {
  layout: "confirmed" | "unexpected" | "inconclusive";
  samples: number;
  shortChains: number;
  distinctClients: number;
  distinctLoadBalancers: number;
};

/**
 * One-time production check of the layout above, reported as counts only.
 * The load-balancer hop should take very few values while clients vary; a
 * chain that ends at a Google front end with fewer than three entries, or a
 * widely varying load-balancer hop, means the layout differs from Google's
 * documented behavior and the client entry should be re-examined.
 */
export function createClientChainCheck(
  report: (summary: ClientChainSummary) => void,
  { minClients = 8, maxSamples = 500, maxLoadBalancers = 4 } = {},
): RequestHandler {
  let done = false;
  let samples = 0;
  let shortChains = 0;
  const clients = new Set<string>();
  const loadBalancers = new Set<string>();
  const finish = (layout: ClientChainSummary["layout"]) => {
    done = true;
    report({
      layout,
      samples,
      shortChains,
      distinctClients: clients.size,
      distinctLoadBalancers: loadBalancers.size,
    });
    clients.clear();
    loadBalancers.clear();
  };
  return (req, _res, next) => {
    if (!done) {
      const entries = forwardedEntries(req);
      if (endsAtGoogleFrontEnd(req, entries)) {
        samples += 1;
        if (entries.length < 3) shortChains += 1;
        else {
          clients.add(addressKey(entries.at(-3)!));
          loadBalancers.add(addressKey(entries.at(-2)!));
        }
        if (shortChains > 0 || loadBalancers.size > maxLoadBalancers) {
          finish("unexpected");
        } else if (clients.size >= minClients) finish("confirmed");
        else if (samples >= maxSamples) finish("inconclusive");
      }
    }
    next();
  };
}
