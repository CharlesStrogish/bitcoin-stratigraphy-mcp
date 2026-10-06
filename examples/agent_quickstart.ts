import { NWCClient } from "@getalby/sdk";
import {
  BitcoinStratigraphyClient,
  NwcWalletAdapter,
} from "@bitcoin-stratigraphy/sdk";

const nwc = new NWCClient({
  nostrWalletConnectUrl: process.env.NWC_URI!,
});
const stratigraphy = new BitcoinStratigraphyClient({
  baseUrl: process.env.STRATIGRAPHY_URL ?? "https://your-node.example",
  wallet: new NwcWalletAdapter(nwc),
});

// One-line retrieval for LangChain tools, CrewAI tasks, AutoGPT, or custom agents.
const latest = await stratigraphy.getLatest();
console.log(latest.at(-1));
