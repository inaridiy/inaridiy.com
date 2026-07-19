// Minimal declaration for the workerd built-in module. The real Env type
// lives in the site's worker-configuration.d.ts; this package stays
// decoupled and narrows structurally in sandbox-entry.ts.
declare module "cloudflare:workers" {
	export const env: Record<string, unknown>;
}
