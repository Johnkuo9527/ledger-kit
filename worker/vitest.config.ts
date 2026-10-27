/// The worker's tests run on Node, like the rest of the ledger's, against the
/// same in-memory SQLite harness (../test/helpers/sqlite-db.ts) with every real
/// migration applied.
///
/// One wrinkle: @cloudflare/workers-oauth-provider imports `cloudflare:workers`,
/// a module only the Workers runtime has. It is aliased to a stub so the REAL
/// OAuth library runs in these tests — register, authorize, token, and the
/// bearer check on /mcp — rather than a mock of it. The library is inlined so
/// the alias reaches its import.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"cloudflare:workers": fileURLToPath(new URL("./test/helpers/cloudflare-workers-stub.ts", import.meta.url)),
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["../test/helpers/home-default.ts"],
		server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
	},
});
