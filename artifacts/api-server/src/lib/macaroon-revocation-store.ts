export type MacaroonRevocation = {
  signatureId: string;
  revokedAt: Date;
  reason?: string;
};

export interface MacaroonRevocationStore {
  isRevoked(signatureId: string): Promise<boolean>;
  revoke(signatureId: string, reason?: string): Promise<MacaroonRevocation>;
}

export function createMemoryMacaroonRevocationStore(): MacaroonRevocationStore {
  const revoked = new Map<string, MacaroonRevocation>();
  return {
    async isRevoked(signatureId) {
      return revoked.has(signatureId);
    },
    async revoke(signatureId, reason) {
      const existing = revoked.get(signatureId);
      if (existing) return existing;
      const entry = {
        signatureId,
        revokedAt: new Date(),
        ...(reason ? { reason } : {}),
      };
      revoked.set(signatureId, entry);
      return entry;
    },
  };
}