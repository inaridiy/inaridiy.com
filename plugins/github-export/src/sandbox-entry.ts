import { portableTextToMarkdown } from "emdash/client";
import type { PortableTextBlock } from "emdash";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import { serializeEntry, FRONT_FIELDS } from "./format.mjs";

/**
 * GitHub export plugin (runtime). See ./index.ts for the overview.
 *
 * Runs at priority 300 — after the auto-translator (100) and search-sync
 * (200) — and re-reads the entry via ctx.content.get, so the committed
 * Markdown reflects the final saved state. Uses the exact same file
 * format as scripts/content-sync.mjs (shared ./format module), so the
 * reverse git -> CMS push sees no phantom diffs.
 *
 * Commit messages carry the "[cms-sync]" marker; the content-sync GitHub
 * workflow skips those commits, closing the loop without extra CI runs.
 */

const COLLECTION = "posts";

interface Settings {
	enabled: boolean;
	repo: string;
	branch: string;
	pathPrefix: string;
	token: string;
}

async function readSettings(ctx: PluginContext): Promise<Settings> {
	return {
		enabled: (await ctx.kv.get<boolean>("settings:enabled")) ?? true,
		repo: (await ctx.kv.get<string>("settings:repo")) ?? "",
		branch: (await ctx.kv.get<string>("settings:branch")) || "main",
		pathPrefix: (await ctx.kv.get<string>("settings:pathPrefix")) || "content/posts",
		token: (await ctx.kv.get<string>("settings:token")) ?? "",
	};
}

/* ------------------------------------------------------------------ */
/* GitHub Contents API (via ctx.http, host-restricted to api.github.com) */
/* ------------------------------------------------------------------ */

function githubHeaders(token: string): Record<string, string> {
	return {
		authorization: `Bearer ${token}`,
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"user-agent": "emdash-plugin-github-export",
		"content-type": "application/json",
	};
}

function encodeBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decodeBase64(base64: string): string {
	const binary = atob(base64.replace(/\n/g, ""));
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

async function getFile(ctx: PluginContext, settings: Settings, path: string) {
	const url = `https://api.github.com/repos/${settings.repo}/contents/${path}?ref=${settings.branch}`;
	const response = await ctx.http!.fetch(url, { headers: githubHeaders(settings.token) });
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new Error(`GitHub GET ${path} failed: ${response.status}`);
	}
	const data = (await response.json()) as { sha: string; content?: string };
	return { sha: data.sha, text: data.content ? decodeBase64(data.content) : "" };
}

async function putFile(
	ctx: PluginContext,
	settings: Settings,
	path: string,
	text: string,
	sha: string | undefined,
	message: string,
) {
	const url = `https://api.github.com/repos/${settings.repo}/contents/${path}`;
	const response = await ctx.http!.fetch(url, {
		method: "PUT",
		headers: githubHeaders(settings.token),
		body: JSON.stringify({
			message,
			content: encodeBase64(text),
			branch: settings.branch,
			...(sha ? { sha } : {}),
		}),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`GitHub PUT ${path} failed: ${response.status} ${body.slice(0, 200)}`);
	}
}

async function deleteFile(
	ctx: PluginContext,
	settings: Settings,
	path: string,
	sha: string,
	message: string,
) {
	const url = `https://api.github.com/repos/${settings.repo}/contents/${path}`;
	const response = await ctx.http!.fetch(url, {
		method: "DELETE",
		headers: githubHeaders(settings.token),
		body: JSON.stringify({ message, sha, branch: settings.branch }),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`GitHub DELETE ${path} failed: ${response.status} ${body.slice(0, 200)}`);
	}
}

/* ------------------------------------------------------------------ */
/* Export logic                                                        */
/* ------------------------------------------------------------------ */

async function recordResult(ctx: PluginContext, result: Record<string, unknown>) {
	await ctx.kv.set("state:last", { at: new Date().toISOString(), ...result });
}

async function exportEntry(collection: string, id: string, ctx: PluginContext): Promise<void> {
	if (collection !== COLLECTION) return;
	const settings = await readSettings(ctx);
	if (!settings.enabled) return;
	if (!settings.repo || !settings.token) {
		ctx.log.info("github-export: not configured (set repo/token in Admin -> GitHub Export)");
		return;
	}

	const item = await ctx.content!.get(collection, id);
	if (!item || !item.slug) return;

	const fields: Record<string, string> = {};
	for (const field of FRONT_FIELDS) {
		if (typeof item.data[field] === "string") fields[field] = item.data[field] as string;
	}
	const body = portableTextToMarkdown((item.data.content as PortableTextBlock[]) ?? []);
	const text = serializeEntry({ slug: item.slug, status: item.status, fields, body });
	const path = `${settings.pathPrefix}/${item.slug}.md`;

	try {
		const existing = await getFile(ctx, settings, path);
		if (existing?.text === text) return;
		await putFile(
			ctx,
			settings,
			path,
			text,
			existing?.sha,
			`sync: ${path} from CMS [cms-sync]`,
		);
		await ctx.kv.set(`state:path:${id}`, path);
		await recordResult(ctx, { ok: true, action: "export", path });
		ctx.log.info(`github-export: committed ${path}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await recordResult(ctx, { ok: false, action: "export", path, error: message });
		ctx.log.error(`github-export: ${message}`);
	}
}

async function removeEntry(collection: string, id: string, ctx: PluginContext): Promise<void> {
	if (collection !== COLLECTION) return;
	const settings = await readSettings(ctx);
	if (!settings.enabled || !settings.repo || !settings.token) return;

	const path = await ctx.kv.get<string>(`state:path:${id}`);
	if (!path) return;
	try {
		const existing = await getFile(ctx, settings, path);
		if (existing) {
			await deleteFile(ctx, settings, path, existing.sha, `sync: remove ${path} from CMS [cms-sync]`);
		}
		await ctx.kv.delete(`state:path:${id}`);
		await recordResult(ctx, { ok: true, action: "delete", path });
		ctx.log.info(`github-export: removed ${path}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await recordResult(ctx, { ok: false, action: "delete", path, error: message });
		ctx.log.error(`github-export: ${message}`);
	}
}

/* ------------------------------------------------------------------ */
/* Block Kit admin page                                                */
/* ------------------------------------------------------------------ */

interface AdminInteraction {
	type: "page_load" | "block_action" | "form_submit";
	action_id?: string;
	values?: Record<string, unknown>;
}

async function settingsBlocks(ctx: PluginContext) {
	const settings = await readSettings(ctx);
	const last = await ctx.kv.get<Record<string, unknown>>("state:last");
	const configured = Boolean(settings.repo && settings.token);
	return {
		blocks: [
			{ type: "header", text: "GitHub Export" },
			{
				type: "context",
				text: "Commits posts to the repo as content/posts/<slug>.md the moment they change. Token: fine-grained PAT with Contents read/write on this one repository.",
			},
			...(configured
				? []
				: [
						{
							type: "banner",
							title: "Not configured",
							description: "Set the repository and a GitHub token to enable export.",
							variant: "alert",
						},
					]),
			{
				type: "form",
				block_id: "settings",
				fields: [
					{ type: "toggle", action_id: "enabled", label: "Enabled", initial_value: settings.enabled },
					{
						type: "text_input",
						action_id: "repo",
						label: "Repository (owner/name)",
						initial_value: settings.repo,
					},
					{ type: "text_input", action_id: "branch", label: "Branch", initial_value: settings.branch },
					{
						type: "text_input",
						action_id: "pathPrefix",
						label: "Path prefix",
						initial_value: settings.pathPrefix,
					},
					{ type: "secret_input", action_id: "token", label: "GitHub token (fine-grained PAT)" },
				],
				submit: { label: "Save", action_id: "save_settings" },
			},
			{ type: "divider" },
			{
				type: "fields",
				fields: [{ label: "Last run", value: last ? JSON.stringify(last) : "never" }],
			},
		],
	};
}

export default {
	hooks: {
		"content:afterSave": {
			priority: 300,
			timeout: 60000,
			errorPolicy: "continue",
			handler: async (
				event: { content: Record<string, unknown>; collection: string },
				ctx: PluginContext,
			) => {
				const id = typeof event.content.id === "string" ? event.content.id : null;
				if (id) await exportEntry(event.collection, id, ctx);
			},
		},
		"content:afterPublish": {
			priority: 300,
			timeout: 60000,
			errorPolicy: "continue",
			handler: async (
				event: { content: Record<string, unknown>; collection: string },
				ctx: PluginContext,
			) => {
				const id = typeof event.content.id === "string" ? event.content.id : null;
				if (id) await exportEntry(event.collection, id, ctx);
			},
		},
		"content:afterUnpublish": {
			priority: 300,
			timeout: 60000,
			errorPolicy: "continue",
			handler: async (
				event: { content: Record<string, unknown>; collection: string },
				ctx: PluginContext,
			) => {
				// Unpublish keeps the file, flipping frontmatter status to draft
				const id = typeof event.content.id === "string" ? event.content.id : null;
				if (id) await exportEntry(event.collection, id, ctx);
			},
		},
		"content:afterDelete": {
			timeout: 60000,
			errorPolicy: "continue",
			handler: async (event: { id: string; collection: string }, ctx: PluginContext) => {
				await removeEntry(event.collection, event.id, ctx);
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const interaction = routeCtx.input as AdminInteraction;
				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					const values = interaction.values ?? {};
					await ctx.kv.set("settings:enabled", Boolean(values.enabled));
					await ctx.kv.set("settings:repo", String(values.repo ?? "").trim());
					await ctx.kv.set("settings:branch", String(values.branch ?? "").trim() || "main");
					await ctx.kv.set(
						"settings:pathPrefix",
						String(values.pathPrefix ?? "").trim().replace(/\/+$/, "") || "content/posts",
					);
					const token = String(values.token ?? "").trim();
					// Empty secret input means "keep the stored token"
					if (token !== "") await ctx.kv.set("settings:token", token);
					return {
						...(await settingsBlocks(ctx)),
						toast: { message: "Settings saved", type: "success" },
					};
				}
				return settingsBlocks(ctx);
			},
		},
	},
} satisfies SandboxedPlugin;
