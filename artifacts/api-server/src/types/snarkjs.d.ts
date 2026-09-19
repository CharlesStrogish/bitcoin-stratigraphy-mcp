declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, string>,
      wasm: string,
      zkey: string,
      logger?: unknown,
      witnessOptions?: unknown,
      proverOptions?: { singleThread?: boolean },
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: unknown,
    ): Promise<boolean>;
  };
}