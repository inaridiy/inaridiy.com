import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import react from "@astrojs/react";
import { d1, kvCache, r2, sandbox } from "@emdash-cms/cloudflare";
import { cloudflareEmail } from "@emdash-cms/cloudflare/plugins";
import { cachePurgePlugin } from "emdash-plugin-cache-purge";
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

// Edge TTL for public HTML (Cloudflare-CDN-Cache-Control; browsers get
// max-age=0 via src/middleware.ts). Short maxAge is only the fallback: EmDash
// admin writes and plugins/cache-purge purge by Cache-Tag on every content
// change, so publishes appear instantly.
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
			// Workspace plugins are trusted-only (they import cloudflare:workers env)
			plugins: [
				translatorPlugin(),
				searchSyncPlugin(),
				githubExportPlugin(),
				newsletterPlugin(),
				cachePurgePlugin(),
				// Email Sending through the `EMAIL` send_email binding. Retries for
				// newsletter mail live in the newsletter outbox.
				cloudflareEmail({ from: { email: "noreply@inaridiy.com", name: "inaridiy.com" } }),
			],
			// Runner for marketplace-installed (sandboxed) plugins
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
	// Route caching for the Workers Cache in front of this Worker: the
	// adapter's provider emits Cloudflare-CDN-Cache-Control + Cache-Tag and
	// wires Astro.cache.invalidate() (called by EmDash admin writes) to
	// cache.purge().
	cache: {
		provider: cacheCloudflare(),
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
