import { NWCClient } from "@getalby/sdk";
import { GetPaidStratigraphyResponse } from "@workspace/api-zod";
import {
  type Express,
  type Request,
  type Response,
} from "express";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../openapi";

const ACCESS_PRICE_MSATS = 21_000;
const INVOICE_DESCRIPTION = "Bitcoin Stratigraphy 422-day dataset access";
const datasetPath = fileURLToPath(
  new URL("../data/stratigraphy.json", import.meta.url),
);
const silentNwcLogger = { debug: (..._args: unknown[]) => undefined };

async function readDataset() {
  const raw = await readFile(datasetPath, "utf8");
  return GetPaidStratigraphyResponse.parse(JSON.parse(raw));
}

type NwcClient = Pick<NWCClient, "lookupInvoice" | "makeInvoice" | "close">;
type NwcClientFactory = (nwcUri: string) => NwcClient;

const createNwcClient: NwcClientFactory = (nwcUri) => {
  return new NWCClient({
    nostrWalletConnectUrl: nwcUri,
    logger: silentNwcLogger,
  });
};

function parseL402Authorization(value: string | undefined) {
  if (!value) return null;

  const match = /^L402\s+([0-9a-fA-F]{64}):([0-9a-fA-F]{64})$/.exec(
    value.trim(),
  );
  if (!match) return null;

  return {
    paymentHash: match[1].toLowerCase(),
    preimage: match[2].toLowerCase(),
  };
}

async function verifyPayment(
  nwcUri: string,
  paymentHash: string,
  preimage: string,
  clientFactory: NwcClientFactory,
) {
  const computedHash = createHash("sha256")
    .update(Buffer.from(preimage, "hex"))
    .digest("hex");
  if (computedHash !== paymentHash) return false;

  const client = clientFactory(nwcUri);
  try {
    const transaction = await client.lookupInvoice({
      payment_hash: paymentHash,
    });
    return (
      transaction.type === "incoming" &&
      transaction.state === "settled" &&
      transaction.amount >= ACCESS_PRICE_MSATS &&
      transaction.description === INVOICE_DESCRIPTION &&
      transaction.payment_hash.toLowerCase() === paymentHash &&
      (!transaction.preimage ||
        transaction.preimage.toLowerCase() === preimage)
    );
  } catch {
    return false;
  } finally {
    client.close();
  }
}

async function createInvoice(
  nwcUri: string,
  clientFactory: NwcClientFactory,
) {
  const client = clientFactory(nwcUri);
  try {
    const transaction = await client.makeInvoice({
      amount: ACCESS_PRICE_MSATS,
      description: INVOICE_DESCRIPTION,
      expiry: 3600,
    });

    if (
      !transaction.invoice.startsWith("ln") ||
      !/^[0-9a-fA-F]{64}$/.test(transaction.payment_hash)
    ) {
      throw new Error("CoinOS returned an incomplete NWC invoice");
    }

    return {
      invoice: transaction.invoice,
      paymentHash: transaction.payment_hash.toLowerCase(),
    };
  } finally {
    client.close();
  }
}

async function sendPaymentChallenge(
  req: Request,
  res: Response,
  nwcUri: string,
  clientFactory: NwcClientFactory,
) {
  try {
    const challenge = await createInvoice(nwcUri, clientFactory);
    res.setHeader(
      "WWW-Authenticate",
      `L402 macaroon="${challenge.paymentHash}", invoice="${challenge.invoice}"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(402).json({
      invoice: challenge.invoice,
      payment_hash: challenge.paymentHash,
    });
  } catch (error) {
    req.log.error({ err: error }, "CoinOS NWC invoice creation failed");
    res.status(502).json({ error: "Unable to create payment invoice" });
  }
}

export function registerStratigraphyRoutes(
  app: Express,
  clientFactory: NwcClientFactory = createNwcClient,
): void {
  app.get("/api", (_req, res): void => {
    res.status(200).json({
      status: "online",
      service: "Bitcoin Stratigraphy API",
    });
  });

  app.get("/api/v1/stratigraphy/sample", async (_req, res): Promise<void> => {
    const data = await readDataset();
    res.status(200).json(data.slice(-5));
  });

  app.get(
    "/api/v1/stratigraphy",
    async (req: Request, res: Response): Promise<void> => {
      const nwcUri = process.env.NWC_URI;
      if (!nwcUri) {
        res.status(500).json({ error: "NWC_URI is not configured" });
        return;
      }

      const authorization = parseL402Authorization(
        req.header("Authorization"),
      );
      if (
        authorization &&
        (await verifyPayment(
          nwcUri,
          authorization.paymentHash,
          authorization.preimage,
           clientFactory,
        ))
      ) {
        const data = await readDataset();
        res.status(200).json(data);
        return;
      }

      await sendPaymentChallenge(req, res, nwcUri, clientFactory);
    },
  );

  app.get("/openapi.json", (_req, res): void => {
    res.status(200).json(openApiDocument);
  });

  app.get("/llms.txt", (_req, res): void => {
    res.type("text/plain").send(`# Bitcoin Stratigraphy API

Machine-readable OpenAPI: GET /openapi.json
Free sample: GET /api/v1/stratigraphy/sample
Paid dataset: GET /api/v1/stratigraphy

The full 422-record dataset costs 21 satoshis. An unauthenticated request returns
HTTP 402 with a BOLT11 invoice and a WWW-Authenticate L402 challenge. After
payment, retry with:

Authorization: L402 <payment_hash>:<preimage>
`);
  });
}
