import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSET_DIR = fileURLToPath(new URL("../dist/client/_astro/", import.meta.url));
const PUBLIC_JS_LIMIT = 500 * 1024;
const ADMIN_REGISTRY_LIMIT = 9 * 1024 * 1024;
const ADMIN_CHUNK_LIMIT = 1024 * 1024;

// Entry chunks only an authenticated editor loads: the admin SPA and the
// visual-editing island. Chunks reachable solely from these are admin-only;
// anything reachable from another entry ships to public visitors.
const ADMIN_ENTRY = /^(PluginRegistry|InlinePortableTextEditor)\./;
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'`]\.\/([^"'`]+\.js)["'`]/g;

const names = (await readdir(ASSET_DIR)).filter((name) => name.endsWith(".js"));
const imports = new Map();
for (const name of names) {
	const source = await readFile(join(ASSET_DIR, name), "utf8");
	imports.set(
		name,
		[...source.matchAll(IMPORT_RE)].map((m) => m[1]).filter((dep) => names.includes(dep)),
	);
}

const imported = new Set([...imports.values()].flat());
const publicChunks = new Set();
const stack = names.filter((name) => !imported.has(name) && !ADMIN_ENTRY.test(name));
while (stack.length > 0) {
	const name = stack.pop();
	if (publicChunks.has(name)) continue;
	publicChunks.add(name);
	stack.push(...imports.get(name));
}

const failures = [];
for (const name of names) {
	const bytes = (await stat(join(ASSET_DIR, name))).size;
	const limit = publicChunks.has(name)
		? PUBLIC_JS_LIMIT
		: name.startsWith("PluginRegistry.")
			? ADMIN_REGISTRY_LIMIT
			: ADMIN_CHUNK_LIMIT;
	if (bytes > limit) failures.push(`${name}: ${bytes} bytes exceeds ${limit}`);
}

if (failures.length > 0) {
	throw new Error(`Client bundle budget exceeded:\n${failures.join("\n")}`);
}

console.log(
	`Client bundle budgets passed (${publicChunks.size} public chunks <= 500 KiB; admin-only chunks <= 1 MiB; EmDash admin registry <= 9 MiB).`,
);
