# GitHub Sync for EmDash

Keep your EmDash content in a GitHub repository as plain Markdown.

- **Instant:** every save, publish, unpublish and delete is committed the moment it happens.
- **Readable:** one `.md` file per entry, with frontmatter and a Markdown body.
- **Two-way (optional):** edit the files, push, and a GitHub Action writes them back to EmDash.

```
content/
  posts/
    hello-world.md
  pages/
    about.md
```

```md
---
cms_id: "01J9Z6Q7..."
slug: "hello-world"
status: "published"
title: "Hello, world"
excerpt: "My first post"
---

The body is your **rich text**, as Markdown.
```

## Set up (CMS → GitHub)

1. **Install** GitHub Sync from **Plugins → Registry** in the EmDash admin.
2. **Create a token** on GitHub: a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with access to one repository and **Contents: Read and write**.
3. **Connect** in **GitHub Sync** (admin sidebar): enter the repository (`owner/name`) and the token, then **Save**.
4. Select **Export all** to write your existing content. It runs in the background, one commit per batch each minute; the page shows the progress.

From now on, every change is committed to `content/<collection>/<slug>.md`.

## Set up (GitHub → CMS, optional)

Edit or add files under `content/`, push, and they are created, updated and published in EmDash.

1. In the EmDash admin, create an **API token** with `content:read`, `content:write` and `schema:read`.
2. Add it to the repository as the Actions secret `EMDASH_TOKEN`.
3. Add `.github/workflows/content-to-emdash.yml`:

```yaml
name: Content to EmDash
on:
  push:
    branches: [main]
    paths: ["content/**"]
permissions:
  contents: write
jobs:
  push:
    # Commits made by the plugin carry [cms-sync] and are already in EmDash.
    if: ${{ !contains(github.event.head_commit.message, '[cms-sync]') }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx -y emdash-plugin-github-sync push
        env:
          EMDASH_URL: https://your-site.example
          EMDASH_TOKEN: ${{ secrets.EMDASH_TOKEN }}
      # New files get a cms_id; commit it so the next push updates, not duplicates.
      - run: |
          git add content
          git diff --cached --quiet && exit 0
          git -c user.name=github-sync -c user.email=github-sync@users.noreply.github.com \
            commit -m "sync: link new entries [cms-sync]"
          git push
```

The file name is the slug. A new file goes live with `status: "published"`. Run `npx emdash-plugin-github-sync pull` locally to download everything once.

## What is synced

- Text, number, boolean, date and select fields go to the frontmatter; the first rich text field is the body. Images and other fields stay in EmDash untouched.
- Drafts are not committed unless **Include drafts** is on. Unpublishing keeps the file and sets `status: "draft"`.
- On multilingual sites, the original entry of each translation is synced.
- Renaming a slug moves the file; deleting an entry deletes it. `cms_id` keeps the link stable.

## Settings

| Setting | Default |
| --- | --- |
| Repository, GitHub token | required |
| Branch | `main` |
| Folder | `content` |
| Collections | all (comma-separated to limit) |
| Include drafts | off |

The token is stored encrypted (`EMDASH_ENCRYPTION_KEY`). The plugin can only reach `api.github.com`.

## License

MIT
