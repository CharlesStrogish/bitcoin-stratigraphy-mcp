# Bitcoin Stratigraphy TypeScript SDK

```ts
import { BitcoinStratigraphyClient, NwcWalletAdapter } from "@bitcoin-stratigraphy/sdk";

const client = new BitcoinStratigraphyClient({
  baseUrl: "https://your-node.example",
  wallet: new NwcWalletAdapter(yourNwcClient),
});

const latest = await client.getLatest();
```

The SDK discovers current prices, pays the selected subscription invoice through
the supplied wallet, caches the returned macaroon and preimage until expiry, and
reuses them for dataset and SSE requests.

## Distribution

From the source repository, run `pnpm --dir sdk/typescript pack`. The package
builds before packing and includes only the runtime JavaScript, declarations,
and this README. Both the REST entry point (`@bitcoin-stratigraphy/sdk`) and
the MCP entry point (`@bitcoin-stratigraphy/sdk/mcp`) are exported. Check the
tarball contents before publishing; to publish publicly from the SDK directory,
run `pnpm publish` after setting the intended version and npm access.
Publishing is a separate maintainer action and has not been performed here.

If the full source repository is hosted on GitHub, pnpm can resolve the SDK
from its monorepo subdirectory without publishing it first:

```json
{
  "dependencies": {
    "@bitcoin-stratigraphy/sdk": "https://github.com/OWNER/REPOSITORY.git#path:/sdk/typescript"
  }
}
```

Replace `OWNER/REPOSITORY` with the real public repository URL, preferably
pinning a released commit/tag. This package has its own TypeScript configuration
and build dependencies, plus a `prepare` script for Git dependency installation.
pnpm 10 requires the consuming project's `pnpm-workspace.yaml` to authorize the
trusted Git package's build scripts with
`onlyBuiltDependencies: ["@bitcoin-stratigraphy/sdk"]`; otherwise it rejects
the Git dependency preparation. The Git source repository must include its
workspace manifest so pnpm can install the SDK's build dependencies there.
The autonomous-agent template instead ships a prebuilt versioned SDK archive,
so a standalone fork does not depend on a GitHub repository being available.