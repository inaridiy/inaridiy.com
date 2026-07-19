import type { PluginDescriptor } from "emdash";

/**
 * Newsletter plugin (descriptor).
 *
 * Readers subscribe with an email address (double opt-in); when a post is
 * published for the first time, every confirmed subscriber gets a plain
 * text notification. Emails go through EmDash's email pipeline, i.e. the
 * email-sender transport (Cloudflare Email Sending) — no extra keys.
 *
 * Public routes: subscribe / confirm / unsubscribe. The site pages under
 * /newsletter/* provide the human-facing confirm/unsubscribe UX.
 */
export function newsletterPlugin(): PluginDescriptor {
	return {
		id: "newsletter",
		version: "0.1.0",
		format: "standard",
		entrypoint: "emdash-plugin-newsletter/sandbox",
		options: {},
		capabilities: ["content:read", "email:send"],
		storage: {
			subscribers: {
				indexes: ["email", "status", "token", "createdAt"],
			},
		},
		adminPages: [{ path: "/newsletter", label: "Newsletter", icon: "mail" }],
	};
}
