// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
/**
 * Canonical public identity for crawler metadata. Imported relatively by the
 * SEO modules so the Vite plugin and Node tests can load it without aliases.
 */
export const SITE_ORIGIN = "https://bitcoinstratigraphy.com";
export const LICENSING_EMAIL = "licensing@bitcoinstratigraphy.com";
export const COMMERCIAL_LICENSE_PRICE = "Starting at $250k/Annual";

/** Absolute canonical URL for a root-relative path such as "/enterprise". */
export function siteUrl(path = "/"): string {
  return `${SITE_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}
