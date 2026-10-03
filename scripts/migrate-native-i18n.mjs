/**
 * One-off migration from `*_en` shadow fields to EmDash native i18n
 * (2026-10). See docs/specs/2026-10-03-native-i18n.md for the runbook.
 *
 *   node scripts/migrate-native-i18n.mjs locales --local|--remote
 *       Before deploying the i18n build: re-tag every existing row
 *       (content, menus, taxonomies, bylines, …) from EmDash's implicit
 *       `en` default to `ja`, and mark shared fields translatable=0.
 *       Refuses to run once any content row is already `ja`.
 *
 *   node scripts/migrate-native-i18n.mjs translations --local|--remote
 *       After deploying: create the English translation entry of every
 *       Japanese entry from its `*_en` fields (same slug), publish it with
 *       its source, then copy the source's published_at onto it.
 *       Idempotent: entries that already have an English translation are
 *       skipped. Uses EMDASH_URL + stored `emdash login` credentials.
 *
 *   node scripts/migrate-native-i18n.mjs drop-legacy-fields
 *       Remove the `*_en` fields from the schema once /en is verified.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EmDashClient } from "emdash/client";

const DATABASE = "inaridiy-com";
const CONTENT_TABLES = ["ec_posts", "ec_pages", "ec_activities"];
const LOCALE_TABLES = [
	...CONTENT_TABLES,
	"_emdash_menus",
	"_emdash_menu_items",
	"_emdash_taxonomy_defs",
	"taxonomies",
	"_emdash_bylines",
	"_emdash_relations",
	"_emdash_media_usage_sources",
];
const SHARED_FIELDS = { posts: ["featured_image"], activities: ["date", "kind", "url"] };
const LEGACY_FIELDS = {
	posts: { title_en: "title", excerpt_en: "excerpt", content_en: "content" },
	pages: { title_en: "title", content_en: "content" },
	activities: { title_en: "title", description_en: "description" },
};

function d1(target, sql) {
	const output = execFileSync(
		"pnpm",
		["exec", "wrangler", "d1", "execute", DATABASE, target, "--json", "--command", sql],
		{ encoding: "utf8", env: { ...process.env, WRANGLER_HIDE_BANNER: "true" } },
	);
	return JSON.parse(output.slice(output.indexOf("["))).map((result) => result.results ?? []);
}

function targetFlag() {
	const flag = process.argv.find((arg) => arg === "--local" || arg === "--remote");
	if (!flag) throw new Error("pass --local or --remote");
	return flag;
}

function migrateLocales() {
	const target = targetFlag();
	const counts = d1(
		target,
		CONTENT_TABLES.map(
			(table) => `SELECT '${table}' AS t, locale, COUNT(*) AS n FROM ${table} GROUP BY locale`,
		).join(";\n"),
	).flat();
	console.table(counts);
	if (counts.some((row) => row.locale === "ja")) {
		throw new Error("content already has ja rows — locales were migrated before; refusing");
	}
	// Only tables that exist with a locale column (schemas differ by EmDash version).
	const localeTables = d1(
		target,
		`SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = 'table' AND c.name = 'locale' AND m.name IN (${LOCALE_TABLES.map((t) => `'${t}'`).join(", ")})`,
	)[0].map((row) => row.name);
	const statements = [
		...localeTables.map((table) => `UPDATE ${table} SET locale = 'ja' WHERE locale = 'en'`),
		...Object.entries(SHARED_FIELDS).map(
			([collection, fields]) =>
				`UPDATE _emdash_fields SET translatable = 0 WHERE collection_id = (SELECT id FROM _emdash_collections WHERE slug = '${collection}') AND slug IN (${fields.map((f) => `'${f}'`).join(", ")})`,
		),
	];
	d1(target, statements.join(";\n"));
	console.table(
		d1(
			target,
			localeTables
				.map((table) => `SELECT '${table}' AS t, locale, COUNT(*) AS n FROM ${table} GROUP BY locale`)
				.join(";\n"),
		).flat(),
	);
	console.log("locales migrated. Flush the KV object cache, then deploy the i18n build.");
}

function storedCredentials(baseUrl) {
	try {
		const auth = JSON.parse(readFileSync(join(homedir(), ".config", "emdash", "auth.json"), "utf8"));
		return auth[baseUrl] ?? null;
	} catch {
		return null;
	}
}

function createClient() {
	const baseUrl = process.env.EMDASH_URL || "http://localhost:4321";
	const cred = storedCredentials(baseUrl);
	const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
	return new EmDashClient({
		baseUrl,
		token: process.env.EMDASH_TOKEN || cred?.accessToken || undefined,
		refreshToken: process.env.EMDASH_REFRESH_TOKEN || cred?.refreshToken || undefined,
		devBypass: isLocal && !cred && !process.env.EMDASH_TOKEN,
	});
}

function hasValue(value) {
	if (typeof value === "string") return value.trim() !== "";
	return Array.isArray(value) && value.length > 0;
}

async function migrateTranslations() {
	const target = targetFlag();
	const client = createClient();
	for (const [collection, fieldMap] of Object.entries(LEGACY_FIELDS)) {
		for await (const listed of client.listAll(collection, { locale: "ja" })) {
			const { translations } = await client.translations(collection, listed.id);
			if (translations.some((translation) => translation.locale === "en")) {
				console.log(`skip    ${collection}/${listed.slug} (English entry exists)`);
				continue;
			}
			const source = await client.get(collection, listed.id, { raw: true });
			const data = {};
			for (const [legacy, field] of Object.entries(fieldMap)) {
				if (hasValue(source.data[legacy])) data[field] = source.data[legacy];
			}
			if (!hasValue(data.title)) {
				console.log(`skip    ${collection}/${listed.slug} (no legacy translation)`);
				continue;
			}
			const created = await client.create(collection, {
				data,
				slug: source.slug,
				locale: "en",
				translationOf: source.id,
			});
			if (source.status === "published") await client.publish(collection, created.id);
			console.log(`created ${collection}/${source.slug} -> en ${created.id} (${source.status})`);
		}
	}
	// Publication dates follow the Japanese original (EmDash stamps "now" on
	// first publish; plugin and client publish calls take no override).
	d1(
		target,
		CONTENT_TABLES.map(
			(table) =>
				`UPDATE ${table} SET published_at = (SELECT source.published_at FROM ${table} AS source WHERE source.translation_group = ${table}.translation_group AND source.locale = 'ja' AND source.deleted_at IS NULL) WHERE locale = 'en' AND published_at IS NOT NULL AND EXISTS (SELECT 1 FROM ${table} AS source WHERE source.translation_group = ${table}.translation_group AND source.locale = 'ja' AND source.published_at IS NOT NULL AND source.deleted_at IS NULL)`,
		).join(";\n"),
	);
	console.log("translations migrated; published_at aligned. Flush the KV object cache.");
}

async function dropLegacyFields() {
	const client = createClient();
	for (const [collection, fieldMap] of Object.entries(LEGACY_FIELDS)) {
		for (const field of Object.keys(fieldMap)) {
			try {
				await client.deleteField(collection, field);
				console.log(`removed ${collection}.${field}`);
			} catch (error) {
				console.log(`skip    ${collection}.${field}: ${error instanceof Error ? error.message : error}`);
			}
		}
	}
}

const command = process.argv[2];
if (command === "locales") migrateLocales();
else if (command === "translations") await migrateTranslations();
else if (command === "drop-legacy-fields") await dropLegacyFields();
else {
	console.error("usage: node scripts/migrate-native-i18n.mjs <locales|translations|drop-legacy-fields> [--local|--remote]");
	process.exit(1);
}
