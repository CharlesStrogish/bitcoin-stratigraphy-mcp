---
name: Smithery badge reliability
description: Why the dashboard uses a local Smithery score badge instead of the remote badge endpoint
---

The Smithery listing page worked, but its badge endpoint returned HTTP 500 during the September 25, 2026 audit. The dashboard therefore uses a local SVG reading 100/100, as requested. This is a static label, not a live score.

**Why:** A remotely served badge with a failing image endpoint showed a broken-image icon in the public header. A local fallback keeps the header render reliable.

**How to apply:** If revisiting the badge, verify an official replacement returns an SVG image successfully before switching back to a remote URL. Do not imply the local 100/100 label updates dynamically.