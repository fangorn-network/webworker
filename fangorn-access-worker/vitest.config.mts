// The scaffold's `defineWorkersConfig` from "@cloudflare/vitest-pool-workers/config"
// no longer exists (the plugin is `cloudflareTest` as of Vitest 4.1), and it pointed
// at a wrangler.jsonc this repo never had — which is why these tests had never run.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
});
