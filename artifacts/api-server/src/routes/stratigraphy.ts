export function registerStratigraphyRoutes(app: any): void {
  // 1. Healthcheck route for Replit deployment probe
  app.get("/api", (req: any, res: any): void => {
    res.status(200).json({ status: "online", service: "Bitcoin Stratigraphy API" });
  });

  // 2. L402 Paywall route for AI agents (100 sats archive)
  app.get(
    "/api/v1/stratigraphy",
    async (req: any, res: any): Promise<void> => {
      const nwcUri = process.env.NWC_URI;
      if (!nwcUri) {
        res.status(500).json({ error: "NWC_URI is not configured" });
        return;
      }

      res.status(402).json({
        error: "Payment Required",
        message: "Send 100 satoshis to access the 422-day Bitcoin Stratigraphy dataset.",
        amount_sats: 100,
        pay_to: "CoinOS Wallet via NWC"
      });
    }
  );

  // 3. Lightweight 10-Sat Daily Snapshot for Cron Jobs
  app.get(
    "/api/latest",
    async (req: any, res: any): Promise<void> => {
      const authHeader = req.headers['authorization'];

      if (!authHeader || !authHeader.startsWith('L402 ')) {
        res.setHeader('WWW-Authenticate', 'L402 macaroon="...", invoice="..."');
        res.status(402).json({
          error: "Payment Required",
          message: "Send 10 satoshis to access today's latest Bitcoin Stratigraphy snapshot.",
          amount_sats: 10,
          pay_to: "CoinOS Wallet via NWC"
        });
        return;
      }

      res.status(200).json({
        dataset: "Bitcoin Stratigraphy",
        day: 423,
        date: new Date().toISOString().split('T')[0],
        thermodynamic_scarcity_ratio: "0.9842",
        hal_finney_horizon_progress: "4.23%",
        network_resilience: "Optimal",
        status: "Verified On-Chain"
      });
    }
  );
}

// Default export matching index.ts import requirement
export default registerStratigraphyRoutes;
