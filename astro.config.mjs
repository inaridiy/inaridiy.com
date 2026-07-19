import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2, sandbox } from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import webhookNotifier from "@emdash-cms/plugin-webhook-notifier";
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
			siteUrl: isDev ? undefined : SITE_URL,
			// searchSync / emailSender are trusted-only (import cloudflare:workers env)
			plugins: [
				formsPlugin(),
				translatorPlugin(),
				searchSyncPlugin(),
				githubExportPlugin(),
				emailSenderPlugin(),
				newsletterPlugin(),
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
	devToolbar: { enabled: false },
});
