---
slug: "hello-inaridiy-com"
status: "published"
title: "inaridiy.com を作り直した"
excerpt: "EmDash + Cloudflare Workers でブログを作り直した。D1・AI Search・AI Gateway 経由の自動英訳つき。"
---

個人サイトを EmDash で作り直した。構成は次の通り。

## 構成

CMS は EmDash。Astro ベースで、Cloudflare Workers にそのままデプロイできる。コンテンツは D1 (SQLite)、画像などのメディアは R2 に入る。管理画面もセルフホストされる。

記事を公開すると、プラグインが AI Gateway 経由で LLM を呼び出して英訳を生成する。使うモデルは AI Gateway の設定で切り替えられる。検索は Cloudflare AI Search (旧 AutoRAG) で、記事の公開と同時にインデックスへ登録される。記事の実体は GitHub リポジトリの Markdown と

# asdf

見た目は HackerNews 風に、テキスト主体の簡素なリストにした。装飾より本文。
