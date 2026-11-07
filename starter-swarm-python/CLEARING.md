# Native A2A clearing tools

The starter exposes two additional canonical registry entries:

- `clearing.create_contract(worker_pubkey, task_hash, amount_sats) -> str`
- `clearing.settle_contract(escrow_id, execution_trace) -> str`

They live in `clearing.py`, independently of the pinned public Python SDK. The
SDK's 16 data-tool contracts and `payment.get_escrow` are unchanged. This does
not publish another PyPI version.

```python
from clearing import ClearingTools
from nwc_wallet import NwcWallet

# client is your existing configured YieldStakingClient with a NIP-98 signer,
# independently pinned server public key, and explicit payment/session limits.
clearing_wallet = NwcWallet(your_agent_owned_nwc_uri)
clearing = ClearingTools(client, clearing_wallet)

escrow_id = clearing.registry["clearing.create_contract"](
    worker_pubkey=worker_pubkey,
    task_hash=task_hash,
    amount_sats=100,
)
```

On successful funding, creation returns only the escrow UUID to the agent.
On failure it returns a fixed, credential-free diagnostic rather than an
unhandled provider exception. Do not treat a diagnostic string as an escrow ID.
There are no interactive payment prompts or payment/preimage prints.

## Funding remains real while production settlement is disabled

**Creation now automatically pays the returned invoice using NWC, as requested.
Production cannot settle these contracts or return a production ZK-Indemnity
Receipt. Money may remain unavailable indefinitely.** The opt-in local
development flow described in [the circuit guide](../circuits/README.md)
records preimage-proof settlement and a signed development receipt, not a
payout or arbitrary task-execution proof. This extension does not
override the server's warning, implement refunds/payouts, or claim that its
pending database row is verified Lightning custody.

Use a dedicated, low-balance, agent-owned NWC connection—not the server's
merchant connection. Configure a **wallet-side spending budget and routing-fee
policy**. NIP-47 does not provide a universally enforced per-request routing-fee
ceiling. The SDK reserves its configured fee allowance and records actual fees
when supplied; excessive reported fees block future spending. Wallet-enforced
limits are necessary to prevent fees exceeding the client-side allowance.

`nostr-sdk==0.45.1` provides the native NIP-47 encryption, signature verification,
request/response correlation, and relay client. The adapter accepts only secure
`wss` relay configuration, bounds the payment request, closes the relay client,
and never automatically resubmits an uncertain wallet operation.

## Main agent registration

Run `pip install -r requirements.txt`. Keep the existing LND settings for data
queries and yield withdrawals. Add `NWC_URI` to your private environment for the
clearing payer, and set the existing agent-owned NIP-98 signing key.

When a signing identity is configured, `main.py` adds both clearing tools to the
agent. Without NWC, settlement remains usable but creation returns a clear
configuration message without paying.

OpenAI-compatible function names cannot contain dots. LangChain therefore uses
`clearing_create_contract` and `clearing_settle_contract`, with the exact dotted
canonical names retained in tool metadata and every MCP POST.

The default digest task is unchanged; it does not create or fund a contract.
The clearing payer never replaces the LND wallet used by the data tools.

## Authenticated payment and retries

Both functions sign the exact MCP POST URL and bytes using fresh NIP-98
authentication. Creation verifies the independently pinned Ed25519 response
signature, BOLT11 signature/network, exact amount, payment hash, and invoice
expiry before funding. The SDK verifies the returned payment preimage.

Clearing uses the **same session circuit and durable payment ledger** as the
data client. It does not claim 21% yield or debit staked balances. Never delete
`.agent-yield-state` to reset spending or retry an uncertain payment.

The clearing journal preserves the JSON-RPC request ID and exact body.
Repeating the same buyer/endpoint/worker/task/amount resumes one contract;
concurrent callers cannot buy the same invoice twice. Use a genuinely new task
hash for a distinct job. A confirmed local payment can be recovered without
repayment even if the post-payment HTTP response was lost. Unknown outcomes
remain reserved for manual reconciliation.

## Production fail-closed settlement and local development receipts

Settlement needs no NWC wallet, cannot spend, and works at zero remaining
payment budget. For a matching JSON-RPC response with HTTP 503 and exact error
message `CLEARING_EXECUTION_VERIFIER_UNAVAILABLE`, it returns:

> The ZK execution verifier is pending deployment. This contract has not been
> settled and no ZK-Indemnity Receipt was issued.

Other errors are sanitized. An arbitrary successful HTTP response or
`verified: true` flag is not promoted to verified settlement.

With an explicitly enabled local development server, `execution_trace` must be
the JSON Groth16 envelope generated by the circuit guide's worker helper. Never
send the private preimage to the server. The server checks worker authentication,
the exact task and escrow public signals, and merchant-confirmed funding before
atomically saving settlement and a signed receipt. Production cannot enable
this local verifier.

On success the starter returns a JSON-serialized portable receipt, after
verifying both the HTTP-byte signature and the receipt signature against the
configured payload-key pin. It checks the worker, escrow, task and proof digest
and rejects overstated guarantees. This is a **development-only proof of
preimage knowledge**, not arbitrary task execution, legal indemnity, a payout,
or fully trustless custody. No NWC payment is made during settlement.

## Offline tests

```bash
python -m unittest -v test_clearing.py test_starter.py test_staking.py
```

For clearing-only verification without running protected data-tool tests, use
`python -m unittest -v test_clearing.py test_clearing_receipts.py` instead.

Tests use synthetic signed invoices, real local NIP-98/Ed25519 verification, a
mocked MCP transport, and exclusively mocked NWC payments and relay clients.
They never spend mainnet funds.
