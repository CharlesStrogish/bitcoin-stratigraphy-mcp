// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
/**
 * Canonical public identity for discovery documents and outbound defaults.
 * Request handling stays host-agnostic so existing clients remain compatible.
 */
export const CANONICAL_ORIGIN = "https://bitcoinstratigraphy.com";
export const RELEASE_VERSION = "2.1.3";
export const PRODUCT_NAME = "Bitcoin Stratigraphy Data Engine";
export const NPM_PACKAGE = "@bitcoin-stratigraphy/mcp-server";
export const NPX_COMMAND = `npx -y ${NPM_PACKAGE}`;
export const LICENSING_EMAIL = "licensing@bitcoinstratigraphy.com";
export const COMMERCIAL_LICENSE_PRICE = "Starting at $250k/Annual";
export const CREATOR = {
  name: "Charles R. Strogish",
  role: "Creator & Principal Architect",
} as const;

/** Absolute canonical URL for a root-relative path such as "/mcp". */
export function canonicalUrl(path = "/"): string {
  return `${CANONICAL_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}
