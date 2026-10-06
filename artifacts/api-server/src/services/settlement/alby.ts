import {
  createNwcSettlementProvider,
  type NwcClientFactory,
} from "./nwc-provider";

export type AlbySettlementMode = "live" | "standby";

export function albySettlementUri() {
  return (
    process.env.ALBY_NWC_URI?.trim() ||
    process.env.NWC_FALLBACK_URI?.trim() ||
    undefined
  );
}

export function albySettlementMode(): AlbySettlementMode {
  return albySettlementUri() ? "live" : "standby";
}

export function createAlbySettlementProvider(clientFactory?: NwcClientFactory) {
  return createNwcSettlementProvider({
    name: "alby",
    uri: albySettlementUri,
    clientFactory,
  });
}
