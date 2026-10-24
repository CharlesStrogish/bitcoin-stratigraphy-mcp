# Historical engine manifest

This directory preserves the historical `ENGINE_MASTER_MANIFEST.json` and its
original checksum and OpenTimestamps receipt without changing their bytes.
They are archival artifacts, not the current production MCP catalog.

The application does not load these files. The canonical API contract remains
in `lib/api-spec/openapi.yaml` at the repository root.

Keep the JSON, `.sha256`, and `.json.ots` files together. To inspect the historical
checksum, run `sha256sum --check ENGINE_MASTER_MANIFEST.sha256` from this directory.
The result describes only whether these archived bytes match that historical
checksum; it is not proof of current API state or Bitcoin confirmation.
