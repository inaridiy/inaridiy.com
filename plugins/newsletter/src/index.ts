import type { PluginDescriptor } from "emdash";

/**
 * Newsletter plugin (descriptor).
 *
 * Readers subscribe with an email address (double opt-in); when a post is
 * published for the first time, a resumable campaign creates one delivery
 * record per confirmed subscriber and sends it through EmDash's email
 * pipeline, retrying failed sends from that outbox.
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
				indexes: ["status", "token", "createdAt", "confirmedAt"],
				uniqueIndexes: ["email"],
			},
			campaigns: {
				indexes: ["status", "createdAt", "updatedAt"],
			},
			deliveries: {
				indexes: ["campaignId", "subscriberId", "status", "nextAttemptAt"],
			},
		},
		adminPages: [{ path: "/newsletter", label: "Newsletter", icon: "mail" }],
	};
}
