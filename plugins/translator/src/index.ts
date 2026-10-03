import type { PluginDescriptor } from "emdash";

/**
 * Auto-translation plugin (descriptor).
 *
 * Runs at build time in Vite (imported from astro.config.mjs), so it only
 * declares identity and the trust contract. The runtime logic lives in
 * ./sandbox-entry.ts, referenced via the package's `./sandbox` export.
 *
 * Runtime configuration (model / gateway) is KV-backed and edited on the
 * plugin's admin page (Admin -> Translator). Default model runs on the
 * Workers AI binding with zero configuration.
 *
 * TRUSTED-ONLY: the runtime entry reaches the AI binding through
 * `import { env } from "cloudflare:workers"`. Do not move to `sandboxed: []`.
 */
export function translatorPlugin(): PluginDescriptor {
	return {
		id: "auto-translator",
		version: "0.1.0",
		format: "standard",
		entrypoint: "emdash-plugin-translator/sandbox",
		options: {},
		capabilities: ["content:read", "content:write", "content:publish", "content:restore"],
		adminPages: [{ path: "/translator", label: "Translator", icon: "globe" }],
	};
}
