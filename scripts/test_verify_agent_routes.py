"""Offline route-checker regressions; no wallet, server, or model calls."""

import json
import unittest

import httpx

from scripts.verify_agent_routes import (
    BECH32,
    COST_TOOLS,
    EXPECTED_TOOLS,
    PROTOCOL_VERSION,
    bech32_polymod,
    run_checks,
)


def invoice_fixture():
    # Syntactically valid test invoice; deliberately not signed/payable.
    hrp = "lnbc2500n"
    data = [0] * 111
    expanded = [ord(char) >> 5 for char in hrp] + [0] + [ord(char) & 31 for char in hrp]
    checksum = bech32_polymod(expanded + data + [0] * 6) ^ 1
    check = [(checksum >> (5 * (5 - index))) & 31 for index in range(6)]
    return hrp + "1" + "".join(BECH32[value] for value in data + check)


class RouteChecks(unittest.IsolatedAsyncioTestCase):
    async def probe(self, fault=None, sse=False):
        seen = []

        def handle(request):
            if request.url.path == "/.well-known/mcp/server-card.json":
                return httpx.Response(
                    200,
                    headers={"access-control-allow-origin": "*"},
                    json={
                        "name": "broken"
                        if fault == "card"
                        else "bitcoin-stratigraphy-mcp",
                        "displayName": "Bitcoin Stratigraphy Data Engine",
                        "description": "Provides thermodynamic data, proof verification, and L402 payments.",
                        "version": "1.0.0",
                        "url": "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
                    },
                )
            seen.append(request)
            self.assertNotIn("authorization", request.headers)
            if request.url.path == "/.well-known/mcp.json":
                namespaces = ["stratigraphy", "proof", "mesh", "payment"]
                if fault == "namespace":
                    namespaces[-1] = "unknown"
                return httpx.Response(
                    200,
                    headers={
                        "access-control-allow-origin": "https://wrong.invalid"
                        if fault == "cors"
                        else "*",
                    },
                    json={
                        "mcp": {
                            "capabilities": {
                                "tools": {"count": 15, "namespaces": namespaces}
                            }
                        }
                    },
                )
            if request.url.path == "/api/v1/cost":
                self.assertEqual(request.method, "POST")
                self.assertEqual(json.loads(request.content), {"tools": COST_TOOLS})
                if fault == "cost404":
                    return httpx.Response(404, text="Cannot POST /api/v1/cost")
                prices = dict.fromkeys(COST_TOOLS, 250)
                if fault == "price":
                    prices[COST_TOOLS[0]] = True
                return httpx.Response(200, json={"perToolSats": prices})
            self.assertEqual(request.url.path, "/mcp")
            self.assertEqual(request.method, "POST")
            self.assertIn("text/event-stream", request.headers["accept"])
            self.assertEqual(request.headers["mcp-protocol-version"], PROTOCOL_VERSION)
            body = json.loads(request.content)
            method = body["method"]
            if method == "tools/call":
                self.assertEqual(
                    body["params"],
                    {"name": "stratigraphy.get", "arguments": {"days": 1}},
                )
                if fault == "timeout":
                    raise httpx.ReadTimeout(
                        "PRIVATE request error detail", request=request
                    )
                invoice = invoice_fixture()
                if fault == "invoice":
                    invoice = invoice[:-1] + ("q" if invoice[-1] != "q" else "p")
                challenge = f'L402 macaroon="AQ==", invoice="{invoice}"'
                if fault == "macaroon":
                    challenge = f'L402 macaroon="!!!", invoice="{invoice}"'
                return httpx.Response(
                    402,
                    headers={}
                    if fault == "challenge"
                    else {"www-authenticate": challenge},
                )
            if method == "tools/list":
                names = sorted(EXPECTED_TOOLS)
                if fault == "catalog":
                    names[-1] = names[0]
                result = {
                    "tools": [
                        {"name": name, "inputSchema": {"type": "object"}}
                        for name in names
                    ]
                }
            elif method == "initialize":
                self.assertEqual(body["params"]["protocolVersion"], PROTOCOL_VERSION)
                result = {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                }
            else:
                self.assertEqual(method, "ping")
                result = {}
            response = {
                "jsonrpc": "2.0",
                "id": "wrong" if fault == "rpc_id" else body["id"],
                "result": result,
            }
            if fault == "rpc_error" and method == "ping":
                response = {"jsonrpc": "2.0", "id": body["id"], "error": {"code": -1}}
            if sse:
                return httpx.Response(
                    200,
                    headers={"content-type": "text/event-stream"},
                    text=(
                        ": keepalive\r\n\r\nevent: message\r\ndata: "
                        + json.dumps(response)
                        + "\r\n\r\n"
                    ),
                )
            return httpx.Response(200, json=response)

        async with httpx.AsyncClient(
            base_url="https://test.invalid", transport=httpx.MockTransport(handle)
        ) as client:
            results = await run_checks(client)
        self.assertEqual(len(results), 5)
        return results, seen

    async def test_json_success(self):
        results, seen = await self.probe()
        self.assertTrue(all(passed for _, passed, _ in results), results)
        self.assertEqual(len(seen), 6)

    async def test_sse_success(self):
        results, _ = await self.probe(sse=True)
        self.assertTrue(all(passed for _, passed, _ in results), results)

    async def test_failed_checks_do_not_skip_other_probes(self):
        for fault, index in [
            ("cors", 0),
            ("namespace", 0),
            ("catalog", 0),
            ("cost404", 1),
            ("price", 1),
            ("challenge", 2),
            ("card", 4),
            ("macaroon", 2),
            ("invoice", 2),
            ("timeout", 2),
            ("rpc_error", 3),
        ]:
            with self.subTest(fault=fault):
                results, _ = await self.probe(fault)
                self.assertFalse(results[index][1], results)
                self.assertEqual(
                    sum(not passed for _, passed, _ in results), 1, results
                )
                self.assertNotIn("PRIVATE", str(results))
                self.assertNotIn(invoice_fixture(), str(results))

    async def test_mismatched_rpc_ids_fail(self):
        results, _ = await self.probe("rpc_id")
        self.assertFalse(results[0][1])
        self.assertFalse(results[3][1])
        self.assertTrue(results[2][1])


if __name__ == "__main__":
    unittest.main()
