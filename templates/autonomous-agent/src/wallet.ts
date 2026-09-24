import { NWCClient } from "@getalby/sdk";
import {
  NwcWalletAdapter,
  type NwcPaymentClient,
  type L402WalletAdapter,
} from "@bitcoin-stratigraphy/sdk";
import type { WalletHandler, WalletPayment } from "@bitcoin-stratigraphy/sdk/mcp";

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export type AgentWallet = L402WalletAdapter & {
  /** The MCP client accepts a callback; REST accepts the wallet object. */
  payMcpInvoice: WalletHandler;
  close(): void;
};

function requirePreimage(value: WalletPayment): string {
  const preimage = typeof value === "string"
    ? value
    : "preimage" in value ? value.preimage : value.payment_preimage;
  if (typeof preimage !== "string" || !/^[0-9a-fA-F]{64}$/.test(preimage)) {
    throw new Error("Wallet must return a real 32-byte hex Lightning preimage");
  }
  return preimage.toLowerCase();
}

/** An NWC pairing URI is a secret; only pass it to the wallet client. */
export function createNwcWallet(
  pairingSecret: string,
  onPayment?: (invoice: string) => void,
  clientOverride?: NwcPaymentClient,
): AgentWallet {
  if (!pairingSecret.startsWith("nostr+walletconnect://")) {
    throw new Error("NWC_PAIRING_SECRET must be a nostr+walletconnect:// pairing URI");
  }
  const client = clientOverride ?? new NWCClient({
    nostrWalletConnectUrl: pairingSecret,
    logger: silentLogger,
  });
  const adapter = new NwcWalletAdapter(client);
  const payInvoice = async (invoice: string): Promise<string> => {
    const preimage = requirePreimage(await adapter.payInvoice(invoice));
    onPayment?.(invoice);
    return preimage;
  };
  return {
    payInvoice,
    payMcpInvoice: payInvoice,
    close: () => adapter.close(),
  };
}

/**
 * For a wallet SDK that supports paying BOLT11 invoices through LNURL flows.
 * A bare LNURL-pay address cannot settle someone else's invoice.
 */
export function createLnurlCapableWallet(
  payBolt11: (invoice: string) => Promise<WalletPayment>,
): AgentWallet {
  const payInvoice = async (invoice: string) =>
    requirePreimage(await payBolt11(invoice));
  return { payInvoice, payMcpInvoice: payInvoice, close() {} };
}