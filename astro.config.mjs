import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, kvCache, r2, sandbox } from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import webhookNotifier from "@emdash-cms/plugin-webhook-notifier";
import { cachePurgePlugin } from "emdash-plugin-cache-purge";
import { emailSenderPlugin } from "emdash-plugin-email-sender";
import { githubExportPlugin } from "emdash-plugin-github-export";
import { newsletterPlugin } from "emdash-plugin-newsletter";
import { searchSyncPlugin } from "emdash-plugin-search-sync";
import { translatorPlugin } from "emdash-plugin-translator";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";

// Canonical origin. The Worker is also reachable on *.workers.dev; without
// this, EmDash derives auth/email/redirect URLs from the request origin.
// Dev keeps localhost (passkeys/device flow would break otherwise).
const SITE_URL = "https://inaridiy.com";
const isDev = process.argv.includes("dev");

// Edge TTL for public HTML (CDN-Cache-Control; browsers get max-age=0 via
// src/middleware.ts). Short maxAge is only the fallback: plugins/cache-purge
// purges by Cache-Tag on every content change, so publishes appear instantly.
const PAGE_CACHE = { maxAge: 300, swr: 86400 };

export default defineConfig({
	output: "server",
	site: SITE_URL,
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			// KV-backed query cache: serves content/settings reads without hitting
			// D1 on every request. EmDash invalidates entries on edits itself.
			objectCache: kvCache({ binding: "CACHE" }),
			siteUrl: isDev ? undefined : SITE_URL,
			// searchSync / emailSender are trusted-only (import cloudflare:workers env)
			plugins: [
				formsPlugin(),
				translatorPlugin(),
				searchSyncPlugin(),
				githubExportPlugin(),
				emailSenderPlugin(),
				newsletterPlugin(),
				cachePurgePlugin(),
			],
			sandboxed: [webhookNotifier],
			sandboxRunner: sandbox(),
			marketplace: "https://marketplace.emdashcms.com",
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	// Route caching for the Workers Cache sitting in front of this Worker
	// (wrangler.jsonc "cache"). The provider only exists to activate header
	// emission and wire Astro.cache.invalidate() to cache.purge() — it must
	// NOT gain an onRequest (Astro would then strip Cache-Tag/CDN-Cache-Control
	// from responses and the edge cache would stop working).
	cache: {
		provider: {
			name: "workers-cache",
			entrypoint: new URL("./src/lib/workers-cache-provider.ts", import.meta.url),
		},
	},
	// Central edge TTLs for public HTML. Pages add Cache-Tags themselves via
	// Astro.cache.set(cacheHint); rss.xml/og set their own longer maxAge
	// in-route. No catch-all on purpose: a pattern overlapping /_emdash would
	// edge-cache admin responses. /search opts out (private, no-store).
	routeRules: {
		"/": PAGE_CACHE,
		"/posts": PAGE_CACHE,
		"/posts/[slug]": PAGE_CACHE,
		"/activities": PAGE_CACHE,
		"/about": PAGE_CACHE,
		"/pages/[slug]": PAGE_CACHE,
		"/category/[slug]": PAGE_CACHE,
		"/tag/[slug]": PAGE_CACHE,
		"/en": PAGE_CACHE,
		"/en/posts/[slug]": PAGE_CACHE,
		"/en/activities": PAGE_CACHE,
		"/en/about": PAGE_CACHE,
		"/newsletter/confirm": PAGE_CACHE,
		"/newsletter/unsubscribe": PAGE_CACHE,
	},
	devToolbar: { enabled: false },
	// EmDash's lazy admin plugin registry is intentionally a separate ~7 MB
	// bundle. Suppress Vite's global 500 kB warning here; the stricter
	// scripts/check-bundle-sizes.mjs gate exempts only that named admin chunk
	// and keeps a 500 KiB budget for every other client JS asset.
	vite: { build: { chunkSizeWarningLimit: 8 * 1024 } },
});
