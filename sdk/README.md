# Bitcoin Stratigraphy MCP client SDK

Small, zero-required-dependency MCP clients with generic tool calls and typed
convenience methods. The live server currently publishes 14 canonical tools;
discover them with `listTools`/`list_tools` rather than treating this guide as
the catalog. TypeScript uses built-in `fetch` and Web Crypto APIs (Node 18+).
Python uses the standard library, or `urllib3` automatically if already
installed. Free discovery needs no wallet. The L402 examples below use a
Lightning wallet callback that **pays the challenged BOLT11 invoice and returns
its real 32-byte hex preimage**. For an ordinary Lightning preimage, the clients
check the challenge hash and do not pay again after a rejected retry.

The default endpoint is
`https://bitcoin-stratigraphy-dashboard.replit.app/mcp`. To use a different
node, pass its full `/mcp` URL to the constructor. The TypeScript package entry
is `@bitcoin-stratigraphy/sdk/mcp` (the existing REST SDK remains at the package
root); Python can import `sdk.python.client` from the repository root. Results
below are the tools' typed `structuredContent`, not the JSON-RPC wrapper.

## Engine capabilities and interface boundaries

The MCP tools provide indexed-history retrieval and digest/diff analytics,
supplied-proof verification, signed context grounding, and configured Nostr
peer broadcast/quorum signals. `proof.verify` accepts supported supplied
Groth16 telemetry or drift proofs and supplied OpenTimestamps (OTS) receipts;
it does not imply proof generation. `proof.ground` returns an off-chain,
Schnorr-signed Bitcoin-tip receipt, not an on-chain proof. Peer quorum is
cross-validation, not source truth, and analytics over indexed history is not
live block provenance. `proof.attenuate` can narrow an existing parent
macaroon using supported caveats; attenuation does not pay an invoice.

Payment support differs by interface. The REST payment router supports
`btc-lightning`, `l-btc`, and `taproot-assets` subject to configuration
reported by `/api/v1/cost`. MCP uses Lightning L402 and conditional Base USDC
x402 only when configured. The snippets here use the L402 MCP clients; the
Python MCP client is L402-only, while the TypeScript MCP package has a separate
opt-in x402 client with a required spending cap. These examples do not
automatically enable all rails or wallet spending. REST
`/api/v1/stratigraphy/stream` is a paid SSE feed refreshed every 30 seconds,
not an MCP transport; no Base x402 support is promised for that SSE route.

## TypeScript

Query telemetry:

```ts
import { BitcoinStratigraphyClient } from "@bitcoin-stratigraphy/sdk/mcp";
const client = new BitcoinStratigraphyClient(undefined, async invoice =>
  (await wallet.payInvoice({ invoice })).preimage);
const { records } = await client.getTelemetry({ date: "2026-09-09" });
console.log(records[0]?.quantitative_alpha);
```

Verify a zk-SNARK proof (provide `proofPayload` and `snapshot` from your agent):

```ts
import { BitcoinStratigraphyClient } from "@bitcoin-stratigraphy/sdk/mcp";
const client = new BitcoinStratigraphyClient(undefined, payInvoice);
const verified = await client.verifyProof({
  proof: proofPayload.proof, publicInputs: proofPayload.publicInputs,
  verificationKeyId: proofPayload.verificationKeyId, data: snapshot,
});
console.log(verified.valid);
```

Broadcast a canonical telemetry snapshot to trusted mesh peers:

```ts
import { BitcoinStratigraphyClient } from "@bitcoin-stratigraphy/sdk/mcp";
const client = new BitcoinStratigraphyClient(undefined, payInvoice);
const receipt = await client.broadcastMeshSignal("2026-09-09");
console.log(receipt.peerAttestations, receipt.snapshotDigest);
```

`payInvoice` above is a function `(invoice: string) => Promise<preimage>`; for
NWC, wrap its `payInvoice({ invoice })` call as in the first example. Broadcasts
require a peer configured on the server and at least one remote acknowledgment.

## Python

Query telemetry:

```py
from sdk.python.client import BitcoinStratigraphyClient

client = BitcoinStratigraphyClient(wallet=lambda invoice: wallet.pay_invoice(invoice))
records = client.get_telemetry(date="2026-09-09")["records"]
print(records[0]["quantitative_alpha"] if records else None)
```

Verify a zk-SNARK proof (`proof_payload` and `snapshot` come from your agent):

```py
from sdk.python.client import BitcoinStratigraphyClient

client = BitcoinStratigraphyClient(wallet=pay_invoice)
verified = client.verify_proof(
    proof_payload["proof"],
    proof_payload["publicInputs"],
    proof_payload["verificationKeyId"],
    snapshot,
)
print(verified["valid"])
```

Broadcast a telemetry snapshot:

```py
from sdk.python.client import BitcoinStratigraphyClient

client = BitcoinStratigraphyClient(wallet=pay_invoice)
receipt = client.broadcast_mesh_signal("2026-09-09")
print(receipt["peerAttestations"], receipt["snapshotDigest"])
```

Other methods cover `stratigraphy.list`, `proof.get_status`, `proof.list`,
`proof.submit`, `proof.ground`, `proof.issue_receipt`, and `mesh.get_status`.
`getProofStatus` / `get_proof_status` accepts exactly one of `proofHash`,
`snapshotDigest`, or `receiptHash`.
The old names `proof.status`, `proof.epistemic_receipt`, and `mesh.status` are
legacy server aliases; use the canonical names in new calls. Advanced callers can use
`callTool(name, args)` / `call_tool(name, args)` directly. The clients do not
generate proofs or fund wallets; supply an existing proof and a funded wallet
integration. Do not pass a wallet's transaction ID or a self-payment UUID in
place of a Lightning preimage.