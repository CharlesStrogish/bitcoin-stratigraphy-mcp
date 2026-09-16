# Bitcoin Stratigraphy TypeScript SDK

```ts
import { BitcoinStratigraphyClient, NwcWalletAdapter } from "@bitcoin-stratigraphy/sdk";

const client = new BitcoinStratigraphyClient({
  baseUrl: "https://your-node.example",
  wallet: new NwcWalletAdapter(yourNwcClient),
});

const latest = await client.getLatest();
```

The SDK discovers current prices, pays the selected subscription invoice through
the supplied wallet, caches the returned macaroon and preimage until expiry, and
reuses them for dataset and SSE requests.