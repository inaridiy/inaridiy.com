import { EmDashClient } from "emdash/client";
import { readFileSync } from "node:fs";
const base = "https://inaridiy.com";
const cred = JSON.parse(readFileSync(process.env.HOME + "/.config/emdash/auth.json", "utf8"))[base];
const client = new EmDashClient({ baseUrl: base, token: cred.accessToken, refreshToken: cred.refreshToken });
async function call(route, body) {
	const res = await client.transport.fetch(new Request(`${base}/_emdash/api/plugins/ai-search/${route}`, {
		method: body ? "POST" : "GET",
		headers: { "content-type": "application/json", "X-EmDash-Request": "1" },
		body: body ? JSON.stringify(body) : undefined,
	}));
	const text = await res.text();
	console.log(route, res.status, text.slice(0, 500));
}
const op = process.argv[2];
if (op === "status") { await call("status"); await call("config"); }
if (op === "sync") { await call("config", { collections: ["posts", "pages", "activities"] }); await call("reindex", { collections: ["posts", "pages", "activities"] }); }
if (op === "progress") await call("reindex");
