# Bitcoin Stratigraphy MCP client SDK

Small, zero-required-dependency clients for the nine MCP tools. TypeScript uses
the built-in `fetch` and Web Crypto APIs (Node 18+). Python uses the standard
library, or `urllib3` automatically if it is already installed. No wallet is
needed for `listTools`/`list_tools` or `mesh.status`; the other tools require a
Lightning wallet callback that **pays the BOLT11 invoice and returns its real
32-byte hex preimage**. Adapt NWC or LNURL wallet APIs to that callback. A
payment hash mismatch is rejected, and the client never retries a second 402
with another payment. Tokens are single-use and are not cached or shared
between tools.

The default endpoint is
`https://bitcoin-stratigraphy-dashboard.replit.app/mcp`. To use a different
node, pass its full `/mcp` URL to the constructor. The TypeScript package entry
is `@bitcoin-stratigraphy/sdk/mcp` (the existing REST SDK remains at the package
root); Python can import `sdk.python.client` from the repository root. Results
below are the tools' typed `structuredContent`, not the JSON-RPC wrapper.

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
verified = client.verify_proof(proof_payload["proof"],
    proof_payload["publicInputs"], proof_payload["verificationKeyId"], snapshot)
print(verified["valid"])
```

Broadcast a telemetry snapshot:

```py
from sdk.python.client import BitcoinStratigraphyClient
client = BitcoinStratigraphyClient(wallet=pay_invoice)
receipt = client.broadcast_mesh_signal("2026-09-09")
print(receipt["peerAttestations"], receipt["snapshotDigest"])
```

Other methods cover `stratigraphy.list`, `proof.status`, `proof.list`,
`proof.submit`, `proof.ground`, and `mesh.status`. Advanced callers can use
`callTool(name, args)` / `call_tool(name, args)` directly. The clients do not
generate proofs or fund wallets; supply an existing proof and a funded wallet
integration. Do not pass a wallet's transaction ID or a self-payment UUID in
place of a Lightning preimage.