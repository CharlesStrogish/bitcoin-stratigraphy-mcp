#!/bin/bash
set -euo pipefail
pnpm install --frozen-lockfile

# Do not run drizzle-kit push unattended. It can propose dropping tables that
# are owned outside the Drizzle schema, including tables with user data.
# Apply reviewed schema changes separately from automated post-merge setup.
