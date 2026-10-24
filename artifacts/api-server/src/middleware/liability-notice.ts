// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).

/** Signed notice of proposed terms, not proof of legal assent or enforceability. */
export const LIABILITY_CAVEAT =
  'liability = "charles_r_strogish_held_harmless"';

export const LIMITATION_OF_LIABILITY =
  "The Bitcoin Stratigraphy Data Engine and its architect, Charles R. Strogish, assume strictly zero liability for any downstream financial execution, hallucination, or logic failures by the client system. Use constitutes acceptance of these terms.";

/** Do not remint a changed, quota-bearing root against a cached pre-notice invoice. */
export function liabilityChallengeScope(scope: string): string {
  return `${scope}:liability:hold-harmless-v1`;
}
