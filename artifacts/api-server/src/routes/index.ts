import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stratigraphyRouter from "./stratigraphy";
import fs from "fs";
import path from "path";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stratigraphyRouter);

// Express L402 / Stratigraphy API routes
export function registerStratigraphyRoutes(app: any) {
  const datasetPath = path.join(process.cwd(), 'stratigraphy.json');

  const getDataset = () => {
    try {
      const raw = fs.readFileSync(datasetPath, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      return [];
    }
  };

  // 1. FREE SAMPLE ENDPOINT
  app.get('/api/v1/stratigraphy/sample', (_req: any, res: any) => {
    const data = getDataset();
    const sample = data.slice(-5);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      status: "success",
      total_records: data.length,
      sample_records: sample.length,
      data: sample
    });
  });

  // 2. L402 PAYWALLED ENDPOINT
  app.get('/api/v1/stratigraphy', async (req: any, res: any) => {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('L402 ')) {
      const token = authHeader.replace('L402 ', '').trim();
      const [paymentHash, preimage] = token.split(':');

      if (paymentHash && preimage) {
        try {
          const verifyRes = await fetch(`https://api.getalby.com/invoices/${paymentHash}`, {
            headers: { 'Authorization': `Bearer ${process.env.ALBY_API_TOKEN}` }
          });
          const verifyData: any = await verifyRes.json();

          if (verifyData.settled || verifyData.state === 'SETTLED') {
            const data = getDataset();
            return res.status(200).json({ status: "success", total_records: data.length, data });
          }
        } catch (err) {
          console.error("L402 verification error:", err);
        }
      }
    }

    try {
      const albyRes = await fetch('https://api.getalby.com/invoices', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.ALBY_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          amount: 21,
          memo: "Bitcoin Stratigraphy 422-Day Dataset Access"
        })
      });

      const invoiceData: any = await albyRes.json();

      return res.status(402).json({
        error: "Payment Required",
        message: "21 Satoshis required to access full 422-day dataset.",
        protocol: "L402",
        payment_request: invoiceData.payment_request,
        payment_hash: invoiceData.payment_hash,
        expires_at: invoiceData.expires_at
      });
    } catch (err) {
      return res.status(500).json({ error: "Failed to generate Lightning invoice" });
    }
  });

  // 3. MACHINE MANIFEST
  app.get('/llms.txt', (_req: any, res: any) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(
`# Bitcoin Stratigraphy API
> 422-Day time-series archive of Bitcoin market signals.

## Endpoints
- GET /api/v1/stratigraphy/sample : Free public preview (Latest 5 days)
- GET /api/v1/stratigraphy : Full dataset (21 Sats via L402)`
    );
  });
}

export default router;
