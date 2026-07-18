import type { PluginDescriptor } from "emdash";

/**
 * GitHub export plugin (descriptor).
 *
 * Event-driven CMS -> git sync: the moment a post is saved, published,
 * unpublished, or deleted, its Markdown mirror (content/posts/<slug>.md)
 * is committed to the GitHub repo via the Contents API. This replaces any
 * scheduled pull — the repo follows the CMS in near-real-time, and the
 * reverse direction (git -> CMS) is handled by the content-sync workflow.
 *
 * Configure in Admin -> GitHub Export: repo (owner/name), branch, and a
 * fine-grained PAT with Contents read/write on that one repo.
 */
export function githubExportPlugin(): PluginDescriptor {
	return {
		id: "github-export",
		version: "0.1.0",
		format: "standard",
		entrypoint: "emdash-plugin-github-export/sandbox",
		options: {},
		capabilities: ["content:read", "network:request"],
		allowedHosts: ["api.github.com"],
		adminPages: [{ path: "/github-export", label: "GitHub Export", icon: "git-branch" }],
	};
}
