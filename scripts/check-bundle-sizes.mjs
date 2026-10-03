import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSET_DIR = fileURLToPath(new URL("../dist/client/_astro/", import.meta.url));
const PUBLIC_JS_LIMIT = 500 * 1024;
const ADMIN_REGISTRY_LIMIT = 8 * 1024 * 1024;

const failures = [];
for (const name of await readdir(ASSET_DIR)) {
	if (!name.endsWith(".js")) continue;
	const bytes = (await stat(join(ASSET_DIR, name))).size;
	const isAdminRegistry = name.startsWith("PluginRegistry.");
	const limit = isAdminRegistry ? ADMIN_REGISTRY_LIMIT : PUBLIC_JS_LIMIT;
	if (bytes > limit) failures.push(`${name}: ${bytes} bytes exceeds ${limit}`);
}

if (failures.length > 0) {
	throw new Error(`Client bundle budget exceeded:\n${failures.join("\n")}`);
}

console.log("Client bundle budgets passed (500 KiB public; 8 MiB EmDash admin registry).");
