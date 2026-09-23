---
name: Public llms.txt ownership
description: The intended owner and tradeoff for the public agent-discovery document.
---

The public `/llms.txt` should show the frontend-maintained agent-discovery document, not the API's older generated guide.

**Why:** The user explicitly chose to replace the API guide at the public URL. The API still implements its own route, but the artifact proxy previously gave that route precedence over the frontend's static file.

**How to apply:** If routing changes again, preserve the frontend document as the public response unless the user requests a different owner. Avoid implying that the MCP `proof.ground` tool directly creates anchors.