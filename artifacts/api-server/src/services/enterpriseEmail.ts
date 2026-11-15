// Copyright (c) 2026 Charles R. Strogish. AGPL-3.0-only / Commercial.
import { BrevoClient } from "@getbrevo/brevo";

export const ENTERPRISE_SENDER = "licensing@bitcoinstratigraphy.com";
export const ENTERPRISE_SUBJECT =
  "Enterprise Access Provisioned: Bitcoin Stratigraphy L402";

export function enterpriseEmailBody(macaroon: string): string {
  return `Hello,\n\nYour $500 payment for the Bitcoin Stratigraphy Enterprise API Block has cleared. Your autonomous swarms are now cleared to route through our Zero-Knowledge architecture for drop-in EU AI Act compliance.\n\nYour L402 Macaroon / API Key: ${macaroon}\n\nPlease inject this credential into your environment variables as BITCOIN_STRATIGRAPHY_API_KEY. The Flight Recorder dashboard and your L402 Interceptor will automatically detect the key and resume swarm operations.\n\nIf you have any technical issues scaling this deployment, reply directly to this email.\n\nBest,\nCharles Strogish\nArchitect, BitcoinStratigraphy.com`;
}

export type EnterpriseMailer = (
  recipient: string,
  macaroon: string,
  deliveryId: string,
) => Promise<string>;

/** No SDK retries: a lost send response must be reconciled, not blindly resent. */
export function createEnterpriseMailer(options: {
  apiKey: string;
  fetcher?: typeof fetch;
}): EnterpriseMailer {
  if (!options.apiKey) throw new Error("Brevo configuration unavailable");
  const brevo = new BrevoClient({
    apiKey: options.apiKey,
    timeoutInSeconds: 10,
    maxRetries: 0,
    ...(options.fetcher ? { fetch: options.fetcher } : {}),
  });
  return async (recipient, macaroon, deliveryId) => {
    const response = await brevo.transactionalEmails.sendTransacEmail({
      sender: { email: ENTERPRISE_SENDER },
      replyTo: { email: ENTERPRISE_SENDER },
      to: [{ email: recipient }],
      subject: ENTERPRISE_SUBJECT,
      textContent: enterpriseEmailBody(macaroon),
      // Provider deduplication supplements, but does not replace, durable state.
      headers: { idempotencyKey: deliveryId },
    });
    if (!response.messageId) throw new Error("Brevo acceptance unconfirmed");
    return response.messageId;
  };
}
