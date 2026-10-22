# MCP Tasks and W3C Trace Context

The server advertises `extensions: {"io.modelcontextprotocol/tasks": {}}`
in `server/discover` capabilities and handshake-era `initialize` capabilities.
Tasks requests use the stateless MCP `2026-07-28` transport. Include on **every**
request:

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {
      "extensions": { "io.modelcontextprotocol/tasks": {} }
    }
  }
}
```

Put that object in `params`, alongside the method's arguments. Set matching
`MCP-Protocol-Version` and `Mcp-Method` HTTP headers. `Mcp-Name` is the tool name
for `tools/call`, or `params.taskId` for `tasks/get`, `tasks/update`, and
`tasks/cancel`.

## Polling and correction

Tasks-capable `stratigraphy.get_range` and `proof.submit` calls return HTTP 200
with `resultType: "task"`, an unguessable `taskId`, `status: "working"`, and
`pollIntervalMs`. Payment is still required before work begins. Durable admission
is checked before consuming payment. Clients without Tasks retain synchronous
execution. An explicit `webhook_url` takes priority: that path retains its
existing HTTP 202 acknowledgement and `v1a` Ed25519 push callback.

Call `tasks/get` with `params.taskId`. Its result has `resultType: "complete"`
and the detailed task fields. A successful task has `status: "completed"` and
`result`, containing the original signed tool result; verify its
`_meta.responseSignature` against the independently pinned tool-integrity key.
Failures use `status: "failed"` and `error`; cancellation uses `"cancelled"`.

Invalid arguments produce `status: "input_required"`. Each uniquely keyed
`inputRequests` entry is an `elicitation/create` form request explaining the
expected format. Resume with:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tasks/update",
  "params": {
    "taskId": "<taskId>",
    "inputResponses": {
      "<inputRequestKey>": {
        "action": "accept",
        "content": {
          "arguments": "{\"startTarget\":\"919712\"}"
        }
      }
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": { "io.modelcontextprotocol/tasks": {} }
      }
    }
  }
}
```

Corrections pass schema, scope, target, revocation, quota and settlement checks
again. An invalid initial call does not issue an invoice; the corrected update
can first return a 402 challenge. Retry that update with its L402 proof (and a
fresh NIP-98 signature over the exact update request if required by the
credential). Credentials are never stored with task records. Repeated responses
to consumed input requests do not execute twice.

`tasks/cancel` persists cancellation and signals an active worker to abort.
Cancellation is best effort: it does not undo an already committed side effect
or refund settlement. Terminal results cannot resurrect a cancelled task.
Tasks expire after one hour. Work is bounded to three minutes; interrupted
charged work is never automatically replayed after restart.

Task IDs are bearer capabilities: keep them private. Every lookup requires the
exact 256-bit handle and enforces expiry. There is no `tasks/list` or other
enumeration endpoint. Task responses are not cacheable.

## Trace-aware Article 12 receipts

The server extracts a valid W3C `traceparent` from the HTTP header, or from
`params._meta.traceparent` when no HTTP header is supplied. Invalid values are
ignored at HTTP ingress; the escrow worker independently rejects invalid
internal context. Incoming bodies are not rewritten, preserving NIP-98 payload
signatures.

Settlement includes the exact validated string in `article_12_receipt` **before**
the RFC 6962 execution leaf is hashed. A trace-aware leaf is:

```
task_hash || SHA256(execution_trace) || SHA256(result_payload)
  || SHA256(canonical_attribution_JSON) || SHA256({"traceparent":"..."})
```

The last JSON value is canonical compact JSON; unattributed trace-aware leaves
use SHA256 of `{}` for the attribution segment. New leaves are 160 bytes.
Legacy 96-byte unattributed and 128-byte attributed leaves and their proofs
are unchanged. The SQLite constraint migration preserves existing leaf and
receipt bytes. Receipt lookup rejects added, removed, or changed context that
does not match the committed leaf.

Trace context is caller-supplied correlation metadata, not authenticated identity,
task correctness, payment proof, or Bitcoin confirmation.
