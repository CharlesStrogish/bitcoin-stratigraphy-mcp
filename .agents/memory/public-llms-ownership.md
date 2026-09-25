---
name: Public llms.txt ownership
description: The intended owner and tradeoff for the public agent-discovery document.
---

The public `/llms.txt` should show the frontend-maintained agent-discovery document, not the API's older generated guide.

**Why:** The user explicitly chose to replace the API guide at the public URL. The API still implements its own route, but the artifact proxy previously gave that route precedence over the frontend's static file.

**How to apply:** If routing changes again, preserve the frontend document as the public response unless the user requests a different owner. Check the current `proof.ground` implementation before describing its result; the tool contract has changed since this note was first written. Keep the declared CC BY license distinct from "Open/L402," which describes access and payment, not a copyright license.