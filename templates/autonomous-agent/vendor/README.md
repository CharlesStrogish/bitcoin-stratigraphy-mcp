The versioned SDK package archive in this directory makes the agent template
installable without the parent monorepo or an npm publication. It is generated
from `sdk/typescript` with:

    pnpm --dir sdk/typescript pack --pack-destination ../../templates/autonomous-agent/vendor

When updating the SDK, bump its version, regenerate the archive, update the
template's dependency path, and verify a clean isolated template installation.