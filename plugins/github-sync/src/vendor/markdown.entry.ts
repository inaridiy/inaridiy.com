// Bundled into src/vendor/markdown.mjs at build time. The plugin build
// externalizes every `emdash/*` import (the sandbox has none), so the
// Portable Text -> Markdown converter is inlined from the installed emdash —
// the same function the CLI uses through emdash/client.
export { portableTextToMarkdown } from "emdash/client";
