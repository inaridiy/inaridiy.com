import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContentItem, PortableTextBlock } from "emdash";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import {
	collectionFormat,
	entryPath,
	isSyncedEntry,
	parseEntry,
	pickFields,
	serializeEntry,
	type CollectionFormat,
} from "./format.mjs";
import { portableTextToMarkdown } from "./vendor/markdown.mjs";

/**
 * GitHub Sync — CMS -> git half.
 *
 * Every content change commits the entry as Markdown to
 * `<dir>/<collection>/<slug>.md` through the GitHub API (one commit per
 * change; "Export all" writes everything in a single commit). The CLI in
 * this package handles git -> CMS with the same file format.
 *
 * Only the original entry of each translation group is synced, and drafts
 * are skipped unless enabled, so unpublished text never reaches the repo.
 * Commit messages carry "[cms-sync]" so a git -> CMS workflow can skip them.
 */

const COMMIT_MARKER = "[cms-sync]";
const API = "https://api.github.com";

interface Settings {
	enabled: boolean;
	repo: string;
	branch: string;
	token: string;
	dir: string;
	collections: string[];
	includeDrafts: boolean;
}

async function readSettings(ctx: PluginContext): Promise<Settings> {
	const collections = (await ctx.settings.get<string>("collections")) ?? "";
	return {
		enabled: (await ctx.settings.get<boolean>("enabled")) ?? true,
		repo: (await ctx.settings.get<string>("repo")) ?? "",
		branch: (await ctx.settings.get<string>("branch")) || "main",
		token: (await ctx.settings.get<string>("token")) ?? "",
		dir: (await ctx.settings.get<string>("dir")) ?? "content",
		collections: collections
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
		includeDrafts: (await ctx.settings.get<boolean>("includeDrafts")) ?? false,
	};
}

function isConfigured(settings: Settings): boolean {
	return Boolean(settings.repo && settings.token);
}

/* ------------------------------------------------------------------ */
/* GitHub API (ctx.http, host-restricted to api.github.com)            */
/* ------------------------------------------------------------------ */

function encodeBase64(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decodeBase64(base64: string): string {
	const binary = atob(base64.replace(/\n/g, ""));
	return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

async function github<T>(
	ctx: PluginContext,
	settings: Settings,
	method: string,
	path: string,
	body?: unknown,
): Promise<T | null> {
	const response = await ctx.http!.fetch(`${API}/repos/${settings.repo}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${settings.token}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			"user-agent": "emdash-plugin-github-sync",
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (response.status === 404 && method === "GET") return null;
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${text.slice(0, 200)}`);
	}
	return response.status === 204 ? null : ((await response.json()) as T);
}

function contentsPath(path: string): string {
	return `/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function getFile(ctx: PluginContext, settings: Settings, path: string) {
	const file = await github<{ sha: string; content?: string }>(
		ctx,
		settings,
		"GET",
		`${contentsPath(path)}?ref=${encodeURIComponent(settings.branch)}`,
	);
	return file ? { sha: file.sha, text: file.content ? decodeBase64(file.content) : "" } : null;
}

async function putFile(
	ctx: PluginContext,
	settings: Settings,
	path: string,
	text: string,
	sha: string | undefined,
	message: string,
) {
	await github(ctx, settings, "PUT", contentsPath(path), {
		message,
		content: encodeBase64(text),
		branch: settings.branch,
		...(sha ? { sha } : {}),
	});
}

async function deleteFile(
	ctx: PluginContext,
	settings: Settings,
	path: string,
	sha: string,
	message: string,
) {
	await github(ctx, settings, "DELETE", contentsPath(path), {
		message,
		sha,
		branch: settings.branch,
	});
}

/** Write many files in one commit through the Git Data API. */
async function commitFiles(
	ctx: PluginContext,
	settings: Settings,
	files: Array<{ path: string; text: string }>,
	message: string,
): Promise<string | null> {
	const branch = encodeURIComponent(settings.branch);
	const ref = await github<{ object: { sha: string } }>(ctx, settings, "GET", `/git/ref/heads/${branch}`);
	if (!ref) throw new Error(`Branch ${settings.branch} does not exist in ${settings.repo}`);
	const parent = await github<{ tree: { sha: string } }>(
		ctx,
		settings,
		"GET",
		`/git/commits/${ref.object.sha}`,
	);
	const tree = await github<{ sha: string }>(ctx, settings, "POST", "/git/trees", {
		base_tree: parent!.tree.sha,
		tree: files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.text })),
	});
	if (tree!.sha === parent!.tree.sha) return null;
	const commit = await github<{ sha: string }>(ctx, settings, "POST", "/git/commits", {
		message,
		tree: tree!.sha,
		parents: [ref.object.sha],
	});
	await github(ctx, settings, "PATCH", `/git/refs/heads/${branch}`, { sha: commit!.sha });
	return commit!.sha;
}

/* ------------------------------------------------------------------ */
/* Entry -> file                                                       */
/* ------------------------------------------------------------------ */

async function formatFor(
	ctx: PluginContext,
	settings: Settings,
	collection: string,
): Promise<CollectionFormat | null> {
	if (settings.collections.length > 0 && !settings.collections.includes(collection)) return null;
	const schema = await ctx.schema!.getCollection(collection);
	return schema ? collectionFormat(schema.fields) : null;
}

function renderEntry(item: PluginContentItem, format: CollectionFormat): string {
	const body = format.body
		? portableTextToMarkdown((item.data[format.body] as PortableTextBlock[] | undefined) ?? [])
		: "";
	return serializeEntry(
		{
			cmsId: item.id,
			slug: item.slug!,
			status: item.status,
			fields: pickFields(item.data, format),
			body,
		},
		format,
	);
}

async function recordResult(ctx: PluginContext, result: Record<string, unknown>) {
	await ctx.kv.set("state:last", { at: new Date().toISOString(), ...result });
}

function pathKey(id: string): string {
	return `state:path:${id}`;
}

async function exportEntry(collection: string, id: string, ctx: PluginContext): Promise<void> {
	const settings = await readSettings(ctx);
	if (!settings.enabled || !isConfigured(settings)) return;
	const format = await formatFor(ctx, settings, collection);
	if (!format) return;
	const item = await ctx.content!.get(collection, id);
	if (!item?.slug || !isSyncedEntry(item)) return;

	const path = entryPath(settings.dir, collection, item.slug);
	const previousPath = await ctx.kv.get<string>(pathKey(id));
	try {
		const existing = await getFile(ctx, settings, path);
		let text: string;
		if (item.status === "published" || settings.includeDrafts) {
			text = renderEntry(item, format);
		} else if (existing) {
			// Unpublished: keep the last public text, only flip the status.
			const parsed = parseEntry(existing.text, item.slug);
			text = serializeEntry({ ...parsed, cmsId: id, status: item.status }, format);
		} else {
			return;
		}

		const renamed = Boolean(previousPath && previousPath !== path);
		if (existing?.text !== text) {
			await putFile(ctx, settings, path, text, existing?.sha, `sync: ${path} from CMS ${COMMIT_MARKER}`);
		}
		if (renamed) {
			// Write the new path first, then drop the old one.
			const previous = await getFile(ctx, settings, previousPath!);
			if (previous) {
				await deleteFile(
					ctx,
					settings,
					previousPath!,
					previous.sha,
					`sync: rename ${previousPath} to ${path} from CMS ${COMMIT_MARKER}`,
				);
			}
		}
		await ctx.kv.set(pathKey(id), path);
		if (existing?.text !== text || renamed) {
			await recordResult(ctx, { ok: true, action: renamed ? "rename" : "export", path });
			ctx.log.info(`github-sync: synced ${path}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await recordResult(ctx, { ok: false, action: "export", path, error: message });
		ctx.log.error(`github-sync: ${message}`);
	}
}

async function removeEntry(id: string, ctx: PluginContext): Promise<void> {
	const settings = await readSettings(ctx);
	if (!settings.enabled || !isConfigured(settings)) return;
	const path = await ctx.kv.get<string>(pathKey(id));
	if (!path) return;
	try {
		const existing = await getFile(ctx, settings, path);
		if (existing) {
			await deleteFile(ctx, settings, path, existing.sha, `sync: remove ${path} from CMS ${COMMIT_MARKER}`);
		}
		await ctx.kv.delete(pathKey(id));
		await recordResult(ctx, { ok: true, action: "delete", path });
		ctx.log.info(`github-sync: removed ${path}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await recordResult(ctx, { ok: false, action: "delete", path, error: message });
		ctx.log.error(`github-sync: ${message}`);
	}
}

/** Write every synced entry in one commit (first sync, or after a gap). */
async function exportAll(ctx: PluginContext): Promise<string> {
	const settings = await readSettings(ctx);
	if (!isConfigured(settings)) return "Set the repository and token first.";
	const collections =
		settings.collections.length > 0
			? settings.collections
			: (await ctx.schema!.listCollections()).map((collection) => collection.slug);

	const files: Array<{ path: string; text: string; id: string }> = [];
	for (const collection of collections) {
		const format = await formatFor(ctx, settings, collection);
		if (!format) continue;
		let cursor: string | undefined;
		do {
			const page = await ctx.content!.list(collection, { limit: 100, cursor });
			for (const item of page.items) {
				if (!item.slug || !isSyncedEntry(item)) continue;
				if (item.status !== "published" && !settings.includeDrafts) continue;
				files.push({
					id: item.id,
					path: entryPath(settings.dir, collection, item.slug),
					text: renderEntry(item, format),
				});
			}
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor);
	}
	if (files.length === 0) return "Nothing to export.";

	const sha = await commitFiles(
		ctx,
		settings,
		files,
		`sync: export ${files.length} entries from CMS ${COMMIT_MARKER}`,
	);
	for (const file of files) await ctx.kv.set(pathKey(file.id), file.path);
	await recordResult(ctx, { ok: true, action: "export-all", files: files.length, commit: sha });
	return sha
		? `Committed ${files.length} entries (${sha.slice(0, 7)}).`
		: `All ${files.length} entries were already up to date.`;
}

/* ------------------------------------------------------------------ */
/* Admin page (Block Kit)                                              */
/* ------------------------------------------------------------------ */

interface AdminInteraction {
	type: "page_load" | "block_action" | "form_submit";
	action_id?: string;
	values?: Record<string, unknown>;
}

async function adminPage(ctx: PluginContext): Promise<BlockResponse> {
	const settings = await readSettings(ctx);
	const last = await ctx.kv.get<Record<string, unknown>>("state:last");
	const notConnected: Block[] = isConfigured(settings)
		? []
		: [
				{
					type: "banner",
					title: "Not connected",
					description: "Enter the repository and a token, save, then select Export all.",
					variant: "alert",
				},
			];
	return {
		blocks: [
			{ type: "header", text: "GitHub Sync" },
			{
				type: "context",
				text: `Commits each entry to ${entryPath(settings.dir, "<collection>", "<slug>")} in ${settings.repo || "your repository"} when it changes. Use a fine-grained token with Contents read and write on that one repository.`,
			},
			...notConnected,
			{
				type: "form",
				block_id: "settings",
				fields: [
					{ type: "text_input", action_id: "repo", label: "Repository (owner/name)", initial_value: settings.repo },
					{ type: "secret_input", action_id: "token", label: "GitHub token", has_value: Boolean(settings.token) },
					{ type: "text_input", action_id: "branch", label: "Branch", initial_value: settings.branch },
					{ type: "text_input", action_id: "dir", label: "Folder", initial_value: settings.dir },
					{
						type: "text_input",
						action_id: "collections",
						label: "Collections (comma-separated, empty = all)",
						initial_value: settings.collections.join(", "),
					},
					{ type: "toggle", action_id: "includeDrafts", label: "Include drafts", initial_value: settings.includeDrafts },
					{ type: "toggle", action_id: "enabled", label: "Enabled", initial_value: settings.enabled },
				],
				submit: { label: "Save", action_id: "save" },
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						label: "Export all",
						action_id: "export_all",
						confirm: {
							title: "Export all entries?",
							text: "Writes every synced entry to the repository in one commit.",
							confirm: "Export",
							deny: "Cancel",
						},
					},
				],
			},
			{ type: "divider" },
			{
				type: "fields",
				fields: [{ label: "Last sync", value: last ? JSON.stringify(last) : "never" }],
			},
		],
	};
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>): Promise<string | null> {
	const repo = String(values.repo ?? "").trim();
	if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return "Repository must look like owner/name.";
	await ctx.settings.set("repo", repo);
	// The masked field is omitted (or empty) unless the user typed a new token.
	if (typeof values.token === "string" && values.token.trim()) {
		await ctx.settings.set("token", values.token.trim());
	}
	await ctx.settings.set("branch", String(values.branch ?? "").trim() || "main");
	await ctx.settings.set("dir", String(values.dir ?? "").trim().replace(/^\/+|\/+$/g, ""));
	await ctx.settings.set("collections", String(values.collections ?? "").trim());
	await ctx.settings.set("includeDrafts", Boolean(values.includeDrafts));
	await ctx.settings.set("enabled", values.enabled === undefined ? true : Boolean(values.enabled));
	return null;
}

function contentId(event: { content: Record<string, unknown> }): string | null {
	return typeof event.content.id === "string" ? event.content.id : null;
}

// Priority 70 runs before plugins on the default 100, so a slow hook there
// (errorPolicy "abort") cannot skip the sync.
const HOOK = { priority: 70, timeout: 60_000, errorPolicy: "continue" } as const;

const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterSave": {
			...HOOK,
			handler: async (event, ctx) => {
				const id = contentId(event);
				if (id) await exportEntry(event.collection, id, ctx);
			},
		},
		"content:afterPublish": {
			...HOOK,
			handler: async (event, ctx) => {
				const id = contentId(event);
				if (id) await exportEntry(event.collection, id, ctx);
			},
		},
		"content:afterUnpublish": {
			...HOOK,
			handler: async (event, ctx) => {
				const id = contentId(event);
				if (id) await exportEntry(event.collection, id, ctx);
			},
		},
		"content:afterRestore": {
			...HOOK,
			handler: async (event, ctx) => {
				const id = contentId(event);
				if (id) await exportEntry(event.collection, id, ctx);
			},
		},
		"content:afterDelete": {
			...HOOK,
			handler: async (event, ctx) => {
				await removeEntry(event.id, ctx);
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx, ctx) => {
				const interaction = routeCtx.input as AdminInteraction;
				if (interaction.type === "form_submit" && interaction.action_id === "save") {
					const error = await saveSettings(ctx, interaction.values ?? {});
					return {
						...(await adminPage(ctx)),
						toast: error
							? { message: error, type: "error" }
							: { message: "Settings saved", type: "success" },
					};
				}
				if (interaction.type === "block_action" && interaction.action_id === "export_all") {
					try {
						const message = await exportAll(ctx);
						return { ...(await adminPage(ctx)), toast: { message, type: "success" } };
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						await recordResult(ctx, { ok: false, action: "export-all", error: message });
						return { ...(await adminPage(ctx)), toast: { message, type: "error" } };
					}
				}
				return adminPage(ctx);
			},
		},
	},
};

export default plugin;
