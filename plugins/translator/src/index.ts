import type { PluginDescriptor } from "emdash";

/**
 * Auto-translation plugin (descriptor).
 *
 * Runs at build time in Vite (imported from astro.config.mjs), so it only
 * declares identity and the trust contract. The runtime logic lives in
 * ./sandbox-entry.ts, referenced via the package's `./sandbox` export.
 *
 * Runtime configuration (AI Gateway account/gateway/model/token) is KV-backed
 * and edited on the plugin's admin page (Admin -> Translator), which is how
 * standard-format EmDash plugins are configured.
 */
export function translatorPlugin(): PluginDescriptor {
	return {
		id: "auto-translator",
		version: "0.1.0",
		format: "standard",
		entrypoint: "emdash-plugin-translator/sandbox",
		options: {},
		capabilities: ["content:read", "content:write", "network:request"],
		allowedHosts: ["gateway.ai.cloudflare.com"],
		adminPages: [{ path: "/translator", label: "Translator", icon: "globe" }],
	};
}
