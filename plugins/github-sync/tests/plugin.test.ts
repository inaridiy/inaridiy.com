import { afterEach, describe, expect, it } from "vitest";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const REPO = "https://api.github.com/repos/acme/site";
const FILE = `${REPO}/contents/content/posts/hello.md`;

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	if (host) await settle(host);
	await host?.dispose();
	host = undefined;
});

async function setup() {
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
	await host.fixtures.plugin.setting("repo", "acme/site");
	await host.fixtures.plugin.setting("token", "test-token");
	return host;
}

/** Content hooks run after the action responds; wait for the plugin's requests. */
async function waitForRequests(host: PluginRuntimeTestHost, count: number) {
	for (let i = 0; i < 50 && host.http.requests().length < count; i++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return host.http.requests();
}

/** Let deferred hooks finish before the host (and its database) goes away. */
async function settle(host: PluginRuntimeTestHost) {
	let count = -1;
	while (count !== host.http.requests().length) {
		count = host.http.requests().length;
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
}

function decodePut(body: unknown): { message: string; text: string; branch: string } {
	const payload = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array));
	return {
		message: payload.message,
		branch: payload.branch,
		text: new TextDecoder().decode(Uint8Array.from(atob(payload.content), (c) => c.charCodeAt(0))),
	};
}

describe("CMS -> git", () => {
	it("commits a published entry as Markdown", async () => {
		const host = await setup();
		// Each content hook looks the file up first: the draft save, then the publish.
		// The mock always answers "no file yet", so a later hook writes again.
		for (let i = 0; i < 3; i++) {
			await host.http.respond(`${FILE}?ref=main`, new Response("{}", { status: 404 }));
			await host.http.respond(FILE, Response.json({ content: { sha: "new" } }, { status: 201 }));
		}

		const created = await host.actions.content.create("posts", {
			slug: "hello",
			data: {
				title: "Hello",
				excerpt: "Short",
				content: [
					{ _type: "block", _key: "a", style: "normal", markDefs: [], children: [{ _type: "span", _key: "b", text: "Body", marks: [] }] },
				],
			},
		});
		if (!created.success) throw new Error("create failed");
		const id = created.data.item.id;
		await host.actions.content.publish("posts", id);

		const requests = await waitForRequests(host, 2);
		const put = requests.find((request) => request.method === "PUT");
		expect(put, JSON.stringify(requests)).toBeDefined();
		const { message, text, branch } = decodePut(put!.body);
		expect(branch).toBe("main");
		expect(message).toBe("sync: content/posts/hello.md from CMS [cms-sync]");
		expect(text).toBe(
			`---\ncms_id: "${id}"\nslug: "hello"\nstatus: "published"\ntitle: "Hello"\nexcerpt: "Short"\n---\n\nBody\n`,
		);
		expect(put!.headers.authorization).toBe("Bearer test-token");
	});

	it("never commits drafts by default", async () => {
		const host = await setup();
		// Creating a draft fires the save hook more than once; each looks the file up.
		for (let i = 0; i < 3; i++) {
			await host.http.respond(`${FILE}?ref=main`, new Response("{}", { status: 404 }));
		}
		await host.actions.content.create("posts", { slug: "hello", data: { title: "Draft" } });
		// The plugin looks up the file (GET), then stops because the entry is a draft.
		await waitForRequests(host, 1);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const requests = host.http.requests();
		expect(requests.filter((request) => request.method === "PUT")).toEqual([]);
	});
});
