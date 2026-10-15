// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
/**
 * Canonical public identity for crawler metadata. Imported relatively by the
 * SEO modules so the Vite plugin and Node tests can load it without aliases.
 */
export const SITE_ORIGIN = "https://bitcoinstratigraphy.com";
export const LICENSING_EMAIL = "licensing@bitcoinstratigraphy.com";
export const COMMERCIAL_LICENSE_PRICE = "Starting at $250k/Annual";

/** Absolute URL for a root-relative path such as "/llms.txt". */
export function siteUrl(path = "/"): string {
  return `${SITE_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Canonical URL of a dedicated page such as "/enterprise". Each one is a
 * static directory index, so the canonical form ends with a slash; the bare
 * path answers with a redirect to it.
 */
export function pageUrl(path: string): string {
  return siteUrl(`${path.replace(/\/+$/, "")}/`);
}
