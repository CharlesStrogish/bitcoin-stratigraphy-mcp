import {
  createNwcSettlementProvider,
  type NwcClientFactory,
} from "./nwc-provider";

export function createCoinosSettlementProvider(
  clientFactory?: NwcClientFactory,
) {
  return createNwcSettlementProvider({
    name: "coinos",
    uri: () => process.env.NWC_URI,
    payerUri: () => process.env.NWC_PAIRING_SECRET,
    clientFactory,
  });
}