import type { APIRoute } from "astro";

/**
 * AT Protocol handle verification for @inari.diy (HTTPS method). The
 * account lives on the Cirrus PDS at pds.inari.diy (separate Worker,
 * ~/pds.inari.diy); its PLC document lists `at://inari.diy`.
 */
const ATPROTO_DID = "did:plc:lcnkdxpf5pe34fupaupkqwnd";

export const GET: APIRoute = ({ cache }) => {
	cache.set({ maxAge: 86400 });
	return new Response(ATPROTO_DID, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
};
