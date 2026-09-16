import {
  createNwcSettlementProvider,
  type NwcClientFactory,
} from "./nwc-provider";

export function createAlbySettlementProvider(
  clientFactory?: NwcClientFactory,
) {
  return createNwcSettlementProvider({
    name: "alby",
    uri: () => process.env.ALBY_NWC_URI ?? process.env.NWC_FALLBACK_URI,
    clientFactory,
  });
}