import { Router, type Express, type IRouter, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GetStratigraphyResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const dataPath = fileURLToPath(
  new URL("../data/stratigraphy.json", import.meta.url),
);

async function readDataset() {
  const raw = await readFile(dataPath, "utf8");
  return GetStratigraphyResponse.parse(JSON.parse(raw));
}

router.get("/stratigraphy", async (_req, res): Promise<void> => {
  const data = await readDataset();
  res.json(data);
});

function parseL402Header(value: string | undefined) {
  if (!value) return null;

  const match = /^L402\s+([^:]+):([^\s]+)$/.exec(value.trim());
  if (!match) return null;

  return {
    paymentHash: match[1].toLowerCase(),
    preimage: match[2].toLowerCase(),
  };
}

function isSettledInvoice(invoice: Record<string, unknown>) {
  const state = invoice.state ?? invoice.status;
  return (
    invoice.settled === true ||
    (typeof state === "string" && state.toUpperCase() === "SETTLED")
  );
}

async function hasValidPayment(
  paymentHash: string,
  preimage: string,
  albyToken: string,
) {
  if (!/^[0-9a-f]{64}$/.test(paymentHash) || !/^[0-9a-f]{64}$/.test(preimage)) {
    return false;
  }

  const computedHash = createHash("sha256")
    .update(Buffer.from(preimage, "hex"))
    .digest("hex");
  if (computedHash !== paymentHash) return false;

  const response = await fetch(
    `https://api.getalby.com/invoices/${encodeURIComponent(paymentHash)}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${albyToken}`,
      },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) return false;

  const invoice = (await response.json()) as Record<string, unknown>;
  const returnedHash = invoice.payment_hash ?? invoice.paymentHash;
  const returnedPreimage =
    invoice.payment_preimage ?? invoice.paymentPreimage ?? invoice.preimage;

  return (
    isSettledInvoice(invoice) &&
    (typeof returnedHash !== "string" ||
      returnedHash.toLowerCase() === paymentHash) &&
    (typeof returnedPreimage !== "string" ||
      returnedPreimage.toLowerCase() === preimage)
  );
}

async function createInvoice(albyToken: string) {
  const response = await fetch("https://api.getalby.com/invoices", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${albyToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: 21,
      description: "Bitcoin Stratigraphy 422-day dataset access",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    throw new Error(
      `Get Alby invoice request failed with HTTP ${response.status}: ${details}`,
    );
  }

  const invoice = (await response.json()) as Record<string, unknown>;
  const paymentRequest =
    invoice.payment_request ?? invoice.paymentRequest ?? invoice.invoice;
  const paymentHash = invoice.payment_hash ?? invoice.paymentHash;

  if (typeof paymentRequest !== "string" || typeof paymentHash !== "string") {
    throw new Error("Get Alby returned an incomplete invoice");
  }

  return { invoice: paymentRequest, payment_hash: paymentHash };
}

export function registerStratigraphyRoutes(app: Express): void {
  app.get("/api/v1/stratigraphy/sample", async (_req, res): Promise<void> => {
    const data = await readDataset();
    res.status(200).json(data.slice(-5));
  });

  app.get(
    "/api/v1/stratigraphy",
    async (req: Request, res: Response): Promise<void> => {
      const albyToken = process.env.NWC_URI
      if (!albyToken) {
        res.status(500).json({ error: "NWC_URI is not configured" });
        return;
      }

      const l402 = parseL402Header(req.header("Authorization"));
      if (
        l402 &&
        (await hasValidPayment(l402.paymentHash, l402.preimage, albyToken))
      ) {
        const data = await readDataset();
        res.status(200).json(data);
        return;
      }

      try {
        const invoice = await createInvoice(albyToken);
        res.status(402).json(invoice);
      } catch (error) {
        req.log.error({ err: error }, "Get Alby invoice creation failed");
        res.status(502).json({ error: "Unable to create payment invoice" });
      }
    },
  );

  app.get("/llms.txt", (_req, res): void => {
    res.type("text/plain").send(`# Bitcoin Stratigraphy API

An AI-friendly API for a 422-day Bitcoin market-signal video archive.

## Free sample

GET /api/v1/stratigraphy/sample

Returns the latest five stratigraphy records as a JSON array with HTTP 200.

## Paid dataset

GET /api/v1/stratigraphy

The full 422-record dataset requires a 21-satoshi Lightning payment. Requests
without a valid payment use HTTP 402 and return:

{"invoice":"lnbc...","payment_hash":"..."}

After payment, send the L402 header in this format:

Authorization: L402 <payment_hash>:<preimage>

The payment is verified with Get Alby before the complete dataset is returned.
`);
  });
}

export default router;