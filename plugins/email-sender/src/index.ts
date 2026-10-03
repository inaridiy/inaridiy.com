import type { PluginDescriptor } from "emdash";

/**
 * Email transport plugin (descriptor).
 *
 * Implements EmDash's exclusive `email:deliver` hook by persisting each
 * message to Cloudflare Queues. The site's queue consumer performs the
 * final Cloudflare Email Sending call with retries and a dead-letter queue.
 *
 * TRUSTED-ONLY: the runtime entry reaches the `EMAIL_QUEUE` binding through
 * `import { env } from "cloudflare:workers"`. Do not move it to
 * `sandboxed: []`. Select it as the provider in Admin -> Settings ->
 * Email; the from address is configured in Admin -> Email Sender.
 */
export function emailSenderPlugin(): PluginDescriptor {
	return {
		id: "email-sender",
		version: "0.1.0",
		format: "standard",
		entrypoint: "emdash-plugin-email-sender/sandbox",
		options: {},
		capabilities: ["hooks.email-transport:register"],
		adminPages: [{ path: "/email-sender", label: "Email Sender", icon: "mail" }],
	};
}
