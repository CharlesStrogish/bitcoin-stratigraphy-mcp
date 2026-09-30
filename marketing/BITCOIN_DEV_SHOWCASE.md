# Bitcoin developer showcase

## Publication title

Bitcoin Stratigraphy Data Engine: L402-metered MCP tools, Groth16 verification, and signed Bitcoin-tip receipts for agents

## Publication body

I'm sharing a project I maintain: the **Bitcoin Stratigraphy Data Engine**, a
remote MCP service for agents that need indexed Bitcoin telemetry, verifiable
proof material, and an explicit payment boundary.

The public endpoint is:

**https://bitcoin-stratigraphy-dashboard.replit.app/mcp**

It exposes 14 tools over Streamable HTTP, supports MCP `2025-11-25`, and uses
L402 Lightning payments for paid execution. The catalog has a Glama
tool-definition quality rating of **A, 4.4/5.0**, checked September 30, 2026.
That rating measures tool-definition quality; it is not a cryptographic
security audit or a guarantee about every individual tool.

The engineering question behind the project is straightforward: how can an
agent retrieve useful data, pay for access under a controlled budget, and
retain evidence that can be checked independently of its generated answer?

The answer is a set of distinct layers—not a claim that cryptography makes
every source value true or every model interpretation correct.

### 1. The MCP execution surface

The 14 canonical tools are grouped into four namespaces:

| Namespace | Tools | Purpose |
| --- | --- | --- |
| `stratigraphy.*` | `stratigraphy.list`, `stratigraphy.get`, `stratigraphy.get_digest`, `stratigraphy.get_diff`, `stratigraphy.get_range` | Discover coverage and retrieve indexed records, compact summaries, comparisons, or bounded ranges. |
| `proof.*` | `proof.attenuate`, `proof.verify`, `proof.get_by_hash`, `proof.list`, `proof.submit`, `proof.ground` | Restrict credentials, verify/register proofs, retrieve retained evidence, and issue signed state receipts. |
| `mesh.*` | `mesh.get_status`, `mesh.broadcast` | Inspect peer/quorum health or sign and distribute a stored telemetry snapshot. |
| `payment.*` | `payment.get_info` | Discover current prices or use an authenticated payment-verification/settlement mode. |

The server does not advertise a `proof.generate` MCP tool. Generation is an
internal capability behind supported proof-producing paths. It also does not
advertise dataset mutation, peer administration, or arbitrary inbound mesh
subscription tools.

Agents should discover the live `tools/list` schemas instead of inferring
arguments from these names. Side-effecting operations such as `proof.submit`
and `mesh.broadcast` need application-level authorization, not just an LLM
prompt that says to behave carefully.

### 2. L402 authentication: an invoice-bound access credential

For a paid `tools/call` without a valid credential, the server returns
**HTTP 402 Payment Required** before protected tool execution. The response
includes:

```http
WWW-Authenticate: L402 macaroon="<invoice-bound-macaroon>", invoice="<BOLT11-invoice>"
```

The challenge body carries the matching macaroon and invoice, plus the
payment hash and amount in sats. These placeholders describe the wire shape;
they are not usable credentials.

The macaroon is issued **with the unpaid challenge**, not in a second
post-payment exchange. The wallet supplies the missing payment proof:

1. The agent sends the intended MCP tool call.
2. The service creates a fixed-amount invoice and issues its scoped macaroon.
3. The agent validates header/body agreement, the decoded BOLT11 amount,
   network, payment hash, expiry, allowed operation, and fee-inclusive budget.
4. The agent's own wallet pays that exact invoice.
5. The wallet returns a genuine 32-byte payment preimage.
6. The agent checks `SHA256(raw_preimage_bytes) == payment_hash`.
7. The agent retries the same JSON-RPC call once using:

   ```http
   Authorization: L402 <macaroon>:<preimage>
   ```

8. The service validates the credential and its caveats, consumes the scoped
   use budget, and executes the authorized operation.

Neither an arbitrary payment hash nor a wallet transaction ID proves payment
for this challenge. A CoinOS internal-payment UUID is not a preimage; it must
not be hashed or reinterpreted to bypass the payment-proof requirement.

The agent's outgoing wallet and the service's incoming invoice provider are
separate trust domains. An agent can use Nostr Wallet Connect or another
Lightning payer adapter, but should never receive the service operator's
wallet credentials. Ordinary MCP clients do not automatically handle L402.

For unattended operation, spending limits, durable atomic reservations,
per-invoice deduplication, and timeout reconciliation belong in trusted agent
application code. An ambiguous wallet timeout is not proof that payment failed.
A second 402 after the paid retry is a reason to stop and reconcile, not to pay
another invoice blindly. Credentials for paid MCP calls are not reusable
subscriptions or permissions for a different tool.

### 3. Micropayment economics without misleading units

Free discovery includes `stratigraphy.list`, `mesh.get_status`, and the query
mode of `payment.get_info`. `proof.attenuate` has no invoice fee but requires
a valid parent credential.

The live pricing query checked September 30, 2026 lists **250 sats for most
paid calls** and **10 sats for `proof.list`**. Use `payment.get_info` for
authoritative current terms before spending.

Lightning uses millisatoshi-denominated accounting where supported, but that
does not make this service's published tool prices sub-satoshi. This launch is
about Lightning-metered execution, not a claim of below-one-sat API charges.
Payment amounts and routing fees are separate budget items.

### 4. Groth16 verification: bind the exact statement and snapshot

The telemetry proof path uses **Groth16/Poseidon over BN254**. Its public
statement includes:

- `blockHeight`
- `thermodynamicHash`
- `timestamp`
- `valuationSat`
- `snapshotDigest`

The prover commits the relevant telemetry statement, produces a circuit
witness and Groth16 proof, and self-verifies the generated proof.

A client then calls `proof.verify` with the supported proof representation,
matching public inputs, verification-key identifier, and associated telemetry
payload. Verification must check both the cryptographic proof and its binding
to the exact submitted snapshot. A valid proof copied onto a different record
is not valid evidence for that record.

At a high level:

```text
Indexed Bitcoin stratum signals
    -> canonical telemetry statement and Poseidon commitments
    -> circuit witness and Groth16 proof generation
    -> proof.verify for the exact proof, inputs, key and payload
    -> verification result retained alongside the original evidence
```

This allows a client to reject invalid or mismatched proof-bearing material
rather than accept a model's claim that verification occurred. The protection
works only when the application actually enforces verification and associates
the result with the answer's cited data.

It does **not** establish that upstream measurements are economically
meaningful, that every source is independently trustworthy, or that an LLM
will interpret a valid record correctly. Nor does the telemetry circuit
constitute a proof of Bitcoin consensus or proof-of-work validity.

The verification key, circuit constraints, trusted-setup provenance, and
issuer/key policy remain part of the trust model. For independent checking,
retain the original proof and public inputs and verify against the expected
trusted verification key. A server response saying `verified: true` or a
cached lifecycle status is not a substitute for retaining and checking the
evidence.

`proof.verify` also has a separate OpenTimestamps receipt-verification mode.
That mode requires a real receipt and target hash; it should not be confused
with generating a new timestamp or broadcasting a Bitcoin transaction.

### 5. Stratum notary: state grounding is not an on-chain transaction

After verification, an agent may independently choose to invoke
`proof.ground`. This is another authorized operation, not an automatic side
effect of `proof.verify`.

Grounding binds a supported execution context or dataset CID/hash and dataset
provenance to an observed Bitcoin height and block hash. The notary signs the
receipt and self-verifies its signature.

The result is an **off-chain signed Bitcoin-tip receipt**. It is not a Groth16
proof, a proof-of-work validity proof, or a transaction committed to Bitcoin.
If an application needs an on-chain commitment and confirmation workflow,
that is a separate integration.

Likewise, a signed metadata field that names a proof does not automatically
mean the notary verified that proof. The application must explicitly bind and
check the evidence relationships it needs.

Historical stratum heights use a documented deterministic daily block index.
They should not be presented as native per-record block provenance or confused
with the live chain tip observed during grounding.

### 6. Why these separate verification layers matter for agents

There are three different claims a client should keep separate:

1. **Access/payment:** the credential permits this operation under its caveats.
2. **Proof/payload binding:** the submitted evidence verifies for the specified
   circuit, public statement, and associated payload.
3. **State attestation:** a trusted issuer signed a context/provenance receipt
   referring to observed Bitcoin chain state.

None of these claims alone means "the model cannot hallucinate." Together,
with source validation and a client that refuses to present unverified claims
as verified facts, they make fabricated verification and mismatched evidence
detectable at the integration boundary.

This is the intended use: agent outputs that carry checkable references rather
than answers whose credibility depends entirely on generated prose.

### 7. Try free discovery first

In a Node.js agent project, install the standard MCP SDK:

```sh
npm install @modelcontextprotocol/sdk
```

This example makes no wallet payment and only queries the catalog and prices:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from
  "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "bitcoin-dev-discovery", version: "1.0.0" });

try {
  await client.connect(new StreamableHTTPClientTransport(
    new URL("https://bitcoin-stratigraphy-dashboard.replit.app/mcp"),
  ));
  const catalog = await client.listTools();
  console.log(catalog.tools.map((tool) => tool.name));

  const prices = await client.callTool({
    name: "payment.get_info",
    arguments: { action: "query" },
  });
  if (prices.isError) throw new Error("Payment discovery returned a tool error");
  console.log(prices);
} finally {
  await client.close();
}
```

Using a wallet callback is a separate, explicit decision. Do not place NWC
URIs, macaroons, preimages, or payment Authorization headers in prompts,
checked-in examples, or logs.

Public references:

- [MCP endpoint](https://bitcoin-stratigraphy-dashboard.replit.app/mcp)
  — use an MCP client; this is not a conventional HTML landing page.
- [Server card](https://bitcoin-stratigraphy-dashboard.replit.app/.well-known/mcp/server-card.json)
- [Agent discovery guide](https://bitcoin-stratigraphy-dashboard.replit.app/llms.txt)
- [Glama tool catalog and current rating](https://glama.ai/mcp/connectors/app.replit.bitcoin-stratigraphy-dashboard--charlesstrogish/bitcoin-stratigraphy)

I'd welcome technical feedback on the payment/proof trust boundaries:
**what evidence would you require an autonomous client to retain before
accepting a metered telemetry result as verified input?**

---

## Publisher notes — do not include in the forum body

- The body above is ready for a Markdown-capable developer forum such as
  Delving Bitcoin or for adaptation into a technical newsletter. Check the
  destination's current showcase/commercial-posting rules before submitting;
  no community endorsement or moderator approval is implied.
- On Bitcointalk, convert headings to `[b]…[/b]`, code fences to
  `[code]…[/code]`, links to `[url=…]…[/url]`, and the namespace table to
  a bullet list. The technical claims should remain unchanged.
- For a shorter newsletter placement, use the opening plus sections 2, 4, 5,
  and the free-discovery CTA. Keep the proof and state-anchor limitations.
- Recheck the live endpoint, `payment.get_info`, and Glama rating immediately
  before posting. Scores and prices are dated snapshots, not future promises.
- Do not add "first," "zero hallucinations," "every tool A-rated," or
  "sub-satoshi tool pricing" without independently verifiable support.