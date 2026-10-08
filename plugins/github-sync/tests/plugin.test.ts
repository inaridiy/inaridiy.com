import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

// The runtime host uses the production Cloudflare sandbox wrapper, so these
// tests also run under its per-invocation limits (10 subrequests).

const GRAPHQL = "https://api.github.com/graphql";

let host: PluginRuntimeTestHost | undefined;

beforeAll(() => {
	process.env.EMDASH_ENCRYPTION_KEY ??= `emdash_enc_v1_${"A".repeat(43)}`;
});

afterEach(async () => {
	if (host) await settle(host);
	await host?.dispose();
	host = undefined;
});

async function setup(settings: Record<string, unknown> = {}) {
	host = await createPluginRuntimeTestHost();
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "content", label: "Content", type: "portableText" },
			{ slug: "excerpt", label: "Excerpt", type: "text" },
		],
	});
	await host.fixtures.plugin.setting("config", { repo: "acme/site", ...settings });
	await host.fixtures.plugin.setting("token", "test-token");
	return host;
}

/**
 * Queue GraphQL answers. Content hooks run concurrently and the mock answers
 * one URL in FIFO order, so each answer serves both a lookup (branch head +
 * file texts) and a commit.
 */
async function respondGitHub(host: PluginRuntimeTestHost, files: Array<string | null> = [null], times = 1) {
	const repository: Record<string, unknown> = { ref: { target: { oid: "head-1" } } };
	files.forEach((text, index) => {
		repository[`f${index}`] = text === null ? null : { text };
	});
	for (let i = 0; i < times; i++) {
		await host.http.respond(
			GRAPHQL,
			Response.json({ data: { repository, createCommitOnBranch: { commit: { oid: "commit-1" } } } }),
		);
	}
}

/** Let deferred hooks finish before the host (and its database) goes away. */
async function settle(host: PluginRuntimeTestHost) {
	let count = -1;
	while (count !== host.http.requests().length) {
		count = host.http.requests().length;
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
}

function bodies(host: PluginRuntimeTestHost): Array<{ query: string; variables: Record<string, any> }> {
	return host.http.requests().map((request) =>
		JSON.parse(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body as Uint8Array)),
	);
}

function commits(host: PluginRuntimeTestHost) {
	return bodies(host)
		.filter((body) => body.query.includes("createCommitOnBranch"))
		.map((body) => body.variables.input);
}

function decode(base64: string): string {
	return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
}

const paragraph = (text: string) => [
	{ _type: "block", _key: "a", style: "normal", markDefs: [], children: [{ _type: "span", _key: "b", text, marks: [] }] },
];

describe("admin page", () => {
	it("saves settings and encrypts the token", async () => {
		host = await createPluginRuntimeTestHost();
		const page = await host.admin.submit("/settings", "save", {
			repo: "acme/site",
			token: "ghp_secret",
			branch: "main",
			dir: "content",
			collections: "posts, pages",
			includeDrafts: false,
			enabled: true,
		});
		expect(page.toast).toEqual({ message: "Settings saved", type: "success" });
		expect(await host.inspect.setting("config")).toMatchObject({
			repo: "acme/site",
			collections: ["posts", "pages"],
		});
		expect(JSON.stringify(await host.inspect.settings.raw("token"))).not.toContain("ghp_secret");
	});

	it("rejects a malformed repository", async () => {
		host = await createPluginRuntimeTestHost();
		const page = await host.admin.submit("/settings", "save", { repo: "not a repo" });
		expect(page.toast?.type).toBe("error");
	});
});

describe("CMS -> git", () => {
	it("commits a published entry as Markdown", async () => {
		const host = await setup();
		// Every content hook re-reads the branch; the mock always says "no file".
		await respondGitHub(host, [null], 6);

		const created = await host.actions.content.create("posts", {
			slug: "hello",
			data: { title: "Hello", excerpt: "Short", content: paragraph("Body") },
		});
		if (!created.success) throw new Error("create failed");
		const id = created.data.item.id;
		await host.actions.content.publish("posts", id);
		await settle(host);

		const [first] = commits(host);
		expect(first, JSON.stringify(bodies(host))).toBeDefined();
		expect(first.branch).toEqual({ repositoryNameWithOwner: "acme/site", branchName: "main" });
		expect(first.expectedHeadOid).toBe("head-1");
		expect(first.message.headline).toBe("sync: content/posts/hello.md from CMS [cms-sync]");
		expect(first.fileChanges.additions).toHaveLength(1);
		expect(first.fileChanges.additions[0].path).toBe("content/posts/hello.md");
		expect(decode(first.fileChanges.additions[0].contents)).toBe(
			`---\ncms_id: "${id}"\nslug: "hello"\nstatus: "published"\ntitle: "Hello"\nexcerpt: "Short"\n---\n\nBody\n`,
		);
		expect(host.http.requests()[0].headers.authorization).toBe("Bearer test-token");
		expect(await host.inspect.storage.get("files", id)).toEqual({ path: "content/posts/hello.md" });
	});

	it("skips the commit when the file is already up to date", async () => {
		const host = await setup();
		const created = await host.fixtures.content("posts", {
			slug: "same",
			status: "published",
			data: { title: "Same", content: paragraph("Body") },
		});
		const text = `---\ncms_id: "${created.id}"\nslug: "same"\nstatus: "published"\ntitle: "Same"\n---\n\nBody\n`;
		await respondGitHub(host, [text], 3);
		await host.actions.content.update("posts", created.id, { data: { title: "Same" } });
		await settle(host);
		expect(commits(host)).toEqual([]);
	});

	it("never commits drafts by default", async () => {
		const host = await setup();
		await host.actions.content.create("posts", { slug: "hello", data: { title: "Draft" } });
		await settle(host);
		expect(host.http.requests()).toEqual([]);
	});
});

describe("export all", () => {
	it("runs as a cron job and commits every published entry in one batch", async () => {
		const host = await setup();
		for (const slug of ["one", "two"]) {
			await host.fixtures.content("posts", {
				slug,
				status: "published",
				data: { title: slug, content: paragraph(slug) },
			});
		}
		await host.fixtures.content("posts", { slug: "draft", status: "draft", data: { title: "draft" } });

		const page = await host.admin.act("/settings", "export_all");
		expect(page.toast?.message).toMatch(/Export started/);

		await respondGitHub(host, [null, null], 2);
		host.scheduled.setTime(new Date(Date.now() + 120_000));
		await host.scheduled.run();
		await settle(host);

		const [batch] = commits(host);
		expect(batch.fileChanges.additions.map((file: { path: string }) => file.path).sort()).toEqual([
			"content/posts/one.md",
			"content/posts/two.md",
		]);
		expect(await host.inspect.kv.get("state:export")).toMatchObject({ done: true, exported: 2, committed: 2 });
	});
});
