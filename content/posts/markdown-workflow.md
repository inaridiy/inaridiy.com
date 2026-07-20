---
cms_id: "01KXWYWAA0BSMAM9RT0GBZJW65"
slug: "markdown-workflow"
status: "published"
title: "記事は Markdown で書いて git で管理する"
excerpt: "content/posts/*.md を編集して push すると CMS に反映される。逆方向も毎晩同期。"
---

このブログの記事は `content/posts/*.md` にある。**Markdown で書いて push** すると GitHub Actions が CMS に反映する。！！！

- 管理画面で直した内容は毎晩リポジトリへ pull される
- 変換は EmDash 公式の Portable Text ⇄ Markdown で往復可能

```bash
pnpm content:pull   # CMS → Markdown
pnpm content:push   # Markdown → CMS
```

> 実体は git、配信と検索は CMS。
