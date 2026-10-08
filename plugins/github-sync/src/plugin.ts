import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContentItem, PortableTextBlock, StorageCollection } from "emdash";
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
 * `<dir>/<collection>/<slug>.md`; "Export all" writes everything through a
 * cron job, one collection page per run. The CLI in this package handles
 * git -> CMS with the same file format.
 *
 * Budget: the Cloudflare sandbox allows 10 subrequests per invocation, and
 * every ctx.* call and GitHub request counts (numbered in the comments
 * below). Settings are read with one list(), file state is one storage
 * record per entry, and GitHub is driven through GraphQL: one query returns
 * the branch head plus the current file text, and createCommitOnBranch
 * writes (and renames) in one commit.
 */

const COMMIT_MARKER = "[cms-sync]";
const GRAPHQL = "https://api.github.com/graphql";
const EXPORT_CRON = "export-all";
const EXPORT_PAGE_SIZE = 50;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

interface Config {
	repo: string;
	branch: string;
	dir: string;
	collections: string[];
	includeDrafts: boolean;
	enabled: boolean;
}

interface Settings extends Config {
	token: string;
}

const DEFAULT_CONFIG: Config = {
	repo: "",
	branch: "main",
	dir: "content",
	collections: [],
	includeDrafts: false,
	enabled: true,
};

/** One subrequest: the editable config is one key, the token another. */
async function readSettings(ctx: PluginContext): Promise<Settings> {
	const entries = new Map((await ctx.settings.list()).map(({ key, value }) => [key, value]));
	const stored = (entries.get("config") ?? {}) as Partial<Config>;
	// Early installs stored repo/branch/enabled as separate keys.
	const legacy: Partial<Config> = {};
	const repo = entries.get("repo");
	const branch = entries.get("branch");
	const enabled = entries.get("enabled");
	if (typeof repo === "string") legacy.repo = repo;
	if (typeof branch === "string" && branch) legacy.branch = branch;
	if (typeof enabled === "boolean") legacy.enabled = enabled;
	const token = entries.get("token");
	return {
		...DEFAULT_CONFIG,
		...legacy,
		...stored,
		token: typeof token === "string" ? token : "",
	};
}

function isConfigured(settings: Settings): boolean {
	return Boolean(settings.repo && settings.token);
}

function selected(settings: Settings, collection: string): boolean {
	return settings.collections.length === 0 || settings.collections.includes(collection);
}

/* ------------------------------------------------------------------ */
/* GitHub GraphQL (ctx.http, host-restricted to api.github.com)        */
/* ------------------------------------------------------------------ */

function encodeBase64(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function graphql<T>(
	ctx: PluginContext,
	settings: Settings,
	query: string,
	variables: Record<string, unknown>,
): Promise<T> {
	const response = await ctx.http!.fetch(GRAPHQL, {
		method: "POST",
		headers: {
			authorization: `Bearer ${settings.token}`,
			"user-agent": "emdash-plugin-github-sync",
			"content-type": "application/json",
		},
		body: JSON.stringify({ query, variables }),
	});
	const body = (await response.json().catch(() => ({}))) as {
		data?: T;
		errors?: Array<{ message: string }>;
		message?: string;
	};
	if (!response.ok || body.errors?.length || !body.data) {
		const reason = body.errors?.map((error) => error.message).join("; ") || body.message;
		throw new Error(`GitHub ${response.status}: ${reason ?? "request failed"}`);
	}
	return body.data;
}

interface Snapshot {
	head: string;
	/** Current text per requested path; null when the file does not exist. */
	files: Map<string, string | null>;
}

/** One request: the branch head and the current text of the given files. */
async function snapshot(ctx: PluginContext, settings: Settings, paths: string[]): Promise<Snapshot> {
	const [owner, name] = settings.repo.split("/");
	const variables: Record<string, unknown> = { owner, name, ref: `refs/heads/${settings.branch}` };
	const declarations = paths.map((_, index) => `, $e${index}: String!`).join("");
	const selections = paths.map((path, index) => {
		variables[`e${index}`] = `${settings.branch}:${path}`;
		return `f${index}: object(expression: $e${index}) { ... on Blob { text } }`;
	});
	const data = await graphql<{
		repository: ({ ref: { target: { oid: string } } | null } & Record<string, unknown>) | null;
	}>(
		ctx,
		settings,
		`query($owner: String!, $name: String!, $ref: String!${declarations}) {
			repository(owner: $owner, name: $name) {
				ref(qualifiedName: $ref) { target { oid } }
				${selections.join("\n")}
			}
		}`,
		variables,
	);
	const head = data.repository?.ref?.target.oid;
	if (!head) throw new Error(`Branch ${settings.branch} not found in ${settings.repo}`);
	const files = new Map<string, string | null>();
	paths.forEach((path, index) => {
		const blob = data.repository![`f${index}`] as { text?: string | null } | null | undefined;
		files.set(path, blob ? (blob.text ?? "") : null);
	});
	return { head, files };
}

interface FileChange {
	additions: Array<{ path: string; text: string }>;
	deletions: string[];
}

/** One request: write and delete files in a single commit on top of `head`. */
async function commit(
	ctx: PluginContext,
	settings: Settings,
	head: string,
	change: FileChange,
	message: string,
): Promise<string> {
	const data = await graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
		ctx,
		settings,
		`mutation($input: CreateCommitOnBranchInput!) {
			createCommitOnBranch(input: $input) { commit { oid } }
		}`,
		{
			input: {
				branch: { repositoryNameWithOwner: settings.repo, branchName: settings.branch },
				expectedHeadOid: head,
				message: { headline: message },
				fileChanges: {
					additions: change.additions.map((file) => ({
						path: file.path,
						contents: encodeBase64(file.text),
					})),
					deletions: change.deletions.map((path) => ({ path })),
				},
			},
		},
	);
	return data.createCommitOnBranch.commit.oid;
}

/** createCommitOnBranch rejects a stale expectedHeadOid; re-read and retry once. */
function isStaleHead(error: unknown): boolean {
	return /expected|head|oid/i.test(errorMessage(error));
}

/* ------------------------------------------------------------------ */
/* Entry -> file                                                       */
/* ------------------------------------------------------------------ */

interface FileRecord {
	path: string;
}

function files(ctx: PluginContext): StorageCollection<FileRecord> {
	return ctx.storage.files as StorageCollection<FileRecord>;
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

async function exportEntry(collection: string, id: string, ctx: PluginContext): Promise<void> {
	const settings = await readSettings(ctx); // 1
	if (!settings.enabled || !isConfigured(settings) || !selected(settings, collection)) return;
	const item = await ctx.content!.get(collection, id); // 2
	if (!item?.slug || !isSyncedEntry(item)) return;
	const record = await files(ctx).get(id); // 3
	const publishable = item.status === "published" || settings.includeDrafts;
	// A draft that was never committed stays out of the repository.
	if (!publishable && !record) return;
	const schema = await ctx.schema!.getCollection(collection); // 4
	if (!schema) return;
	const format = collectionFormat(schema.fields);

	const path = entryPath(settings.dir, collection, item.slug);
	const previousPath = record && record.path !== path ? record.path : null;
	try {
		for (let attempt = 0; ; attempt++) {
			const current = await snapshot(ctx, settings, previousPath ? [path, previousPath] : [path]); // 5 (7)
			const existing = current.files.get(path) ?? null;
			let text: string;
			if (publishable) {
				text = renderEntry(item, format);
			} else {
				// Unpublished: keep the last public text, only flip the status.
				const last = existing ?? (previousPath ? (current.files.get(previousPath) ?? null) : null);
				if (last === null) return;
				text = serializeEntry({ ...parseEntry(last, item.slug), cmsId: id, status: item.status }, format);
			}
			const deletions = previousPath && current.files.get(previousPath) != null ? [previousPath] : [];
			if (existing === text && deletions.length === 0) break;
			try {
				await commit(
					ctx,
					settings,
					current.head,
					{ additions: existing === text ? [] : [{ path, text }], deletions },
					deletions.length > 0
						? `sync: rename ${previousPath} to ${path} from CMS ${COMMIT_MARKER}`
						: `sync: ${path} from CMS ${COMMIT_MARKER}`,
				); // 6 (8)
				await recordResult(ctx, { ok: true, action: deletions.length > 0 ? "rename" : "export", path }); // (9)
				ctx.log.info(`github-sync: synced ${path}`);
				break;
			} catch (error) {
				// Someone pushed between the read and the commit: re-read once.
				if (attempt > 0 || !isStaleHead(error)) throw error;
			}
		}
		if (record?.path !== path) await files(ctx).put(id, { path }); // (10)
	} catch (error) {
		const message = errorMessage(error);
		await recordResult(ctx, { ok: false, action: "export", path, error: message });
		ctx.log.error(`github-sync: ${message}`);
	}
}

async function removeEntry(id: string, ctx: PluginContext): Promise<void> {
	const settings = await readSettings(ctx); // 1
	if (!settings.enabled || !isConfigured(settings)) return;
	const record = await files(ctx).get(id); // 2
	if (!record) return;
	try {
		const current = await snapshot(ctx, settings, [record.path]); // 3
		if (current.files.get(record.path) != null) {
			await commit(
				ctx,
				settings,
				current.head,
				{ additions: [], deletions: [record.path] },
				`sync: remove ${record.path} from CMS ${COMMIT_MARKER}`,
			); // 4
		}
		await files(ctx).delete(id); // 5
		await recordResult(ctx, { ok: true, action: "delete", path: record.path }); // 6
		ctx.log.info(`github-sync: removed ${record.path}`);
	} catch (error) {
		const message = errorMessage(error);
		await recordResult(ctx, { ok: false, action: "delete", path: record.path, error: message });
		ctx.log.error(`github-sync: ${message}`);
	}
}

/* ------------------------------------------------------------------ */
/* Export all: a cron job, one collection page per run                 */
/* ------------------------------------------------------------------ */

interface ExportJob {
	collections: string[];
	index: number;
	cursor?: string;
	exported: number;
	committed: number;
	startedAt: string;
	done: boolean;
	error?: string;
}

async function startExport(ctx: PluginContext, settings: Settings): Promise<string> {
	if (!isConfigured(settings)) return "Set the repository and token first.";
	const collections = (await ctx.schema!.listCollections()) // 1
		.map((collection) => collection.slug)
		.filter((slug) => selected(settings, slug));
	await ctx.kv.set("state:export", {
		collections,
		index: 0,
		exported: 0,
		committed: 0,
		startedAt: new Date().toISOString(),
		done: collections.length === 0,
	} satisfies ExportJob); // 2
	await ctx.cron!.schedule(EXPORT_CRON, { schedule: "* * * * *" }); // 3
	return "Export started: one batch per minute. Reload this page to see the progress.";
}

async function runExportStep(ctx: PluginContext): Promise<void> {
	const job = await ctx.kv.get<ExportJob>("state:export"); // 1
	if (!job || job.done) {
		await ctx.cron!.cancel(EXPORT_CRON);
		return;
	}
	const settings = await readSettings(ctx); // 2
	const collection = job.collections[job.index];
	try {
		const schema = await ctx.schema!.getCollection(collection); // 3
		const page = await ctx.content!.list(collection, { limit: EXPORT_PAGE_SIZE, cursor: job.cursor }); // 4
		const additions: Array<{ id: string; path: string; text: string }> = [];
		if (schema) {
			const format = collectionFormat(schema.fields);
			for (const item of page.items) {
				if (!item.slug || !isSyncedEntry(item)) continue;
				if (item.status !== "published" && !settings.includeDrafts) continue;
				additions.push({
					id: item.id,
					path: entryPath(settings.dir, collection, item.slug),
					text: renderEntry(item, format),
				});
			}
		}
		if (additions.length > 0) {
			const current = await snapshot(ctx, settings, additions.map((file) => file.path)); // 5
			const changed = additions.filter((file) => current.files.get(file.path) !== file.text);
			if (changed.length > 0) {
				await commit(
					ctx,
					settings,
					current.head,
					{ additions: changed, deletions: [] },
					`sync: export ${changed.length} ${collection} entries from CMS ${COMMIT_MARKER}`,
				); // 6
			}
			await files(ctx).putMany(additions.map((file) => ({ id: file.id, data: { path: file.path } }))); // 7
			job.exported += additions.length;
			job.committed += changed.length;
		}
		if (page.hasMore && page.cursor) {
			job.cursor = page.cursor;
		} else {
			job.cursor = undefined;
			job.index += 1;
		}
		job.done = job.index >= job.collections.length;
	} catch (error) {
		job.error = errorMessage(error);
		job.done = true;
	}
	await ctx.kv.set("state:export", job); // 8
	if (job.done) {
		await ctx.cron!.cancel(EXPORT_CRON); // 9
		await recordResult(ctx, {
			ok: !job.error,
			action: "export-all",
			exported: job.exported,
			committed: job.committed,
			...(job.error ? { error: job.error } : {}),
		}); // 10
	}
}

/* ------------------------------------------------------------------ */
/* Admin page (Block Kit)                                              */
/* ------------------------------------------------------------------ */

interface AdminInteraction {
	type: "page_load" | "block_action" | "form_submit";
	action_id?: string;
	values?: Record<string, unknown>;
}

function describeExport(job: ExportJob | null): string {
	if (!job) return "never";
	const progress = `${job.exported} entries checked, ${job.committed} committed`;
	if (job.error) return `failed after ${progress}: ${job.error}`;
	return job.done ? `done (${progress})` : `running: ${job.collections[job.index] ?? ""} (${progress})`;
}

async function adminPage(ctx: PluginContext, settings?: Settings): Promise<BlockResponse> {
	const current = settings ?? (await readSettings(ctx)); // 1
	const last = await ctx.kv.get<Record<string, unknown>>("state:last"); // 2
	const job = await ctx.kv.get<ExportJob>("state:export"); // 3
	const notConnected: Block[] = isConfigured(current)
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
				text: `Commits each entry to ${entryPath(current.dir, "<collection>", "<slug>")} in ${current.repo || "your repository"} when it changes. Use a fine-grained token with Contents read and write on that one repository.`,
			},
			...notConnected,
			{
				type: "form",
				block_id: "settings",
				fields: [
					{ type: "text_input", action_id: "repo", label: "Repository (owner/name)", initial_value: current.repo },
					{ type: "secret_input", action_id: "token", label: "GitHub token", has_value: Boolean(current.token) },
					{ type: "text_input", action_id: "branch", label: "Branch", initial_value: current.branch },
					{ type: "text_input", action_id: "dir", label: "Folder", initial_value: current.dir },
					{
						type: "text_input",
						action_id: "collections",
						label: "Collections (comma-separated, empty = all)",
						initial_value: current.collections.join(", "),
					},
					{ type: "toggle", action_id: "includeDrafts", label: "Include drafts", initial_value: current.includeDrafts },
					{ type: "toggle", action_id: "enabled", label: "Enabled", initial_value: current.enabled },
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
							text: "Writes every synced entry to the repository, one commit per batch.",
							confirm: "Export",
							deny: "Cancel",
						},
					},
				],
			},
			{ type: "divider" },
			{
				type: "fields",
				fields: [
					{ label: "Export all", value: describeExport(job) },
					{ label: "Last sync", value: last ? JSON.stringify(last) : "never" },
				],
			},
		],
	};
}

/** Validates and saves the form; returns the new settings or an error message. */
async function saveSettings(
	ctx: PluginContext,
	values: Record<string, unknown>,
): Promise<Settings | string> {
	const repo = String(values.repo ?? "").trim();
	if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return "Repository must look like owner/name.";
	const config: Config = {
		repo,
		branch: String(values.branch ?? "").trim() || "main",
		dir: String(values.dir ?? "").trim().replace(/^\/+|\/+$/g, ""),
		collections: String(values.collections ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
		includeDrafts: Boolean(values.includeDrafts),
		enabled: values.enabled === undefined ? true : Boolean(values.enabled),
	};
	const previous = await readSettings(ctx); // 1
	await ctx.settings.set("config", config); // 2
	// The masked field is omitted (or empty) unless the user typed a new token.
	const token = typeof values.token === "string" ? values.token.trim() : "";
	if (token) await ctx.settings.set("token", token); // 3
	return { ...config, token: token || previous.token };
}

function contentId(event: { content: Record<string, unknown> }): string | null {
	return typeof event.content.id === "string" ? event.content.id : null;
}

// Priority 70 runs before plugins on the default 100 when hooks share an
// in-process pipeline.
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
		cron: {
			handler: async (event, ctx) => {
				if (event.name === EXPORT_CRON) await runExportStep(ctx);
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx, ctx) => {
				const interaction = routeCtx.input as AdminInteraction;
				if (interaction.type === "form_submit" && interaction.action_id === "save") {
					const saved = await saveSettings(ctx, interaction.values ?? {});
					if (typeof saved === "string") {
						return { ...(await adminPage(ctx)), toast: { message: saved, type: "error" } };
					}
					return {
						...(await adminPage(ctx, saved)),
						toast: { message: "Settings saved", type: "success" },
					};
				}
				if (interaction.type === "block_action" && interaction.action_id === "export_all") {
					const settings = await readSettings(ctx);
					const message = await startExport(ctx, settings);
					return { ...(await adminPage(ctx, settings)), toast: { message, type: "info" } };
				}
				return adminPage(ctx);
			},
		},
	},
};

export default plugin;
