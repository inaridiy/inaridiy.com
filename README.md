# inaridiy.com

[EmDash](https://emdashcms.com) と Astro で構築した、HackerNews風のテキスト中心ブログ。Cloudflare Workers上でSSRし、D1、R2、Workers AI、AI Search、Queues、Email SendingをBinding経由で利用する。日本語が原文で、`/en/` は自動英訳フィールドを日本語fallback付きで表示する。

## 概要

| 要素 | 実装 |
| --- | --- |
| CMS / Web | EmDash 0.28 + Astro 7 (`output: "server"`) |
| Runtime | Cloudflare Workers |
| Content / Media | D1 (`DB`) / R2 (`MEDIA`) |
| キャッシュ | Workers Cache (edge HTML, tag purge) + KV object cache (`CACHE`) |
| 検索 | AI Search (`SEARCH`) + EmDash FTS fallback |
| 翻訳 | Workers AI (`AI`)、任意でAI Gateway経由 |
| メール | Cloudflare Queue (`EMAIL_QUEUE`) → Email Sending (`EMAIL`) |
| Rate limit | Cloudflare Rate Limiting bindings (`AI_RATE_LIMITER`, `NEWSLETTER_RATE_LIMITER`) |
| Styling | shadcn/ui互換CSS変数、Inter + JetBrains Mono |

主なページは `/`、`/posts`、`/posts/[slug]`、`/activities`、`/about`、`/search`、`/en/...`、`/rss.xml`。管理画面は `/_emdash/admin`。

## セットアップ

Node.js 24とpnpm 11を使用する。

```bash
pnpm install
npx emdash dev
```

- サイト: `http://localhost:4321`
- 管理画面: `http://localhost:4321/_emdash/admin`
- 開発ログイン: `http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`

`emdash dev` はmigration、seed、EmDash型生成を行う。Worker Binding型を更新するときは `pnpm exec wrangler types` を実行する。実環境の作成、Secret、初回deployは [docs/operations.md](docs/operations.md) を参照。

## コマンド

```bash
pnpm dev                  # Astro dev server
pnpm typecheck            # Astro diagnostics
pnpm typecheck:workspaces # 共有契約 + 全自作pluginのtsc
pnpm test                 # Node 24 unit tests
pnpm build                # production build
pnpm check                # 上記の検査 + build
pnpm content:pull         # CMS → content/**/*.md
pnpm content:push         # content/**/*.md → CMS
pnpm deploy               # build + wrangler deploy
```

## 手動確認

変更後はまず `pnpm check` を通し、`npx emdash dev` で次を確認する。

1. `/`、`/posts`、記事詳細、`/activities`、`/about` が表示される。
2. 対応する `/en/` ページで英訳が使われ、未翻訳時は現在の日本語へfallbackする。
3. `/search?q=test` がローカルではFTSへ安全にfallbackし、内部例外を表示しない。
4. Footerの購読フォームが中立な成功・失敗メッセージを返す。
5. AdminのGitHub Exportにtoken入力欄がなく、`GITHUB_EXPORT_TOKEN` Secretの案内だけが出る。

本番Bindingを含む非破壊の構成確認:

```bash
pnpm exec wrangler types --check
pnpm check:deploy
```

## コンテンツ契約

`seed/seed.json` のコレクション:

- `posts`: `title`, `excerpt`, `content`, `featured_image` + `title_en`, `excerpt_en`, `content_en`
- `pages`: `title`, `content` + `title_en`, `content_en`
- `activities`: `title`, `date`, `kind`, `url`, `description` + `title_en`, `description_en`

翻訳map、AI Search projection、D1照合列は `packages/content-contract` に集約している。translator、イベント駆動search-sync、毎時のD1 reconciliationが同じ契約を読む。英語のpostだけでなくpageとactivityも検索対象になる。

すべてのCMSクエリページは返された `cacheHint` を `Astro.cache.set()` へ渡す。Activity一覧はcursorを最後まで追い、各ページのcache tagを合成する。

## Markdown / CMS同期

`content/posts`、`content/pages`、`content/activities` はCMSのMarkdownミラー。frontmatterの共通identityは次の通り。

```yaml
---
cms_id: "01..." # CMS ULID。stable identity
slug: "example"
status: "published"
---
```

- git → CMS: `.github/workflows/content-sync.yml` が `content:push` を実行する。
- CMS → git: `plugins/github-export` がContents APIで即時commitする。
- `cms_id` を先に照合し、slug変更は同じentryのrenameとして扱う。
- CMS側renameは新パスを書いてから記憶済みの旧パスを削除する。
- 旧形式のIDなしファイルはslugで一度だけ照合し、次回push/pullでIDを追記する。
- `*_en` とtaxonomyは同期しない。翻訳pluginとAdminが所有する。

`content:push --prune` はローカルに対応IDがないCMS entryを削除するため、通常運用では明示的に必要な場合だけ使う。

## 翻訳

`plugins/translator` は公開済みentryの日本語sourceをWorkers AIで英訳する。既定modelは `@cf/google/gemma-4-26b-a4b-it`、AI Gateway IDはAdminで任意設定できる。

- 入力はsegment数だけでなくserialized文字数でも分割する。
- 応答は同数・同順序・非空stringだけのJSON arrayに限定する。
- finish reason、token usage、response shapeを構造化して記録する。
- entryごとのleaseで重複hookを抑え、source更新後の古い結果は破棄する。
- changed sourceの翻訳に失敗した場合は古い`*_en`を消し、英語ページを現行日本語fallbackへ戻す。
- code blockとinline codeは翻訳しない。

## キャッシュ

3層構成。コンテンツ変更は即時purgeされ、TTLはfallbackに過ぎない。

1. **Workers Cache** (`wrangler.jsonc` の `"cache"`): Workerの前段のedge cache。公開HTMLは `routeRules` (astro.config.mjs) の `CDN-Cache-Control: max-age=300, stale-while-revalidate=86400` と、EmDash cacheHint由来の `Cache-Tag` (collection名 + entry ULID) を返す。`plugins/cache-purge` がcontent hookから `cache.purge({ tags })` (`cloudflare:workers`、zone tokenは不要) を呼ぶ。
2. **KV object cache** (`CACHE` binding): EmDashのD1 query結果cache (`objectCache: kvCache(...)`)。invalidationはEmDash内蔵。
3. **D1 read replication** (`session: "auto"`): 読み取りを近隣replicaへ。

制約:

- Astro route cachingは `cache.provider` が無いと無効で、`Astro.cache.set` はno-opになる。providerは `src/lib/workers-cache-provider.ts`。**`onRequest` を実装しない**こと — 実装するとAstroが `Cache-Tag` / `CDN-Cache-Control` を最終responseから剥がし、edge cacheが機能しなくなる。
- browserには `src/middleware.ts` が `Cache-Control: public, max-age=0, must-revalidate` を付け、常にedgeへ再検証させる (purge後のstale HTML防止)。
- `/search` はvisitor cookieとrate limitを持つため `private, no-store`。
- routeを追加したら明示的な `Cache-Control` を返すこと。無いとWorkers Cacheのheuristic freshness (200は約2時間) で勝手にcacheされる。
- loginしたままsiteを見ると、cacheされた匿名variant (editing toolbar無し) が返ることがある (edge cacheはCookieを見ない)。保存・公開すればpurgeされる。

## 検索とRate Limiting

`plugins/search-sync` がpublish/save/unpublish/deleteをAI Searchへ反映し、`src/search-index.ts` が毎時D1と照合する。照合時に読めなかったcollectionは削除権限を持たず、既知の「table未作成」以外のD1 errorは処理全体を中断する。外部・所有不明のAI Search itemも削除しない。

`/search` は300文字まで。AI Searchを呼ぶ前に公式 `AI_RATE_LIMITER.limit({ key })` を、HttpOnly visitor IDごとに実行する。Binding障害・上限超過・AI Search障害ではproviderを呼ばずFTSへfallbackし、利用者には分類済みの一般メッセージだけを返す。

Rate Limiting Bindingはcolo単位・eventually consistentなabuse guardであり、厳密な課金カウンタではない。

## Newsletter / Email

Footer購読はdouble opt-in。購読要求は正規化emailのSHA-256をkeyに、公式 `NEWSLETTER_RATE_LIMITER` で制限する。email storageにはunique indexと短い送信leaseがあり、同時初回登録による重複確認メールを抑える。

記事公開hookは一括送信せず、campaignを1件作るだけ。5分ごとのEmDash cronがbounded pageで購読者を列挙し、campaign/subscriberごとのdelivery outboxを作る。状態は `pending` / `failed` / `queued` / `dead` / `skipped` で、失敗は上限まで再試行される。

EmDashの全メールは次の経路を通る。

```text
ctx.email.send → email-sender → EMAIL_QUEUE → Worker queue() → EMAIL.send
```

Queueへの永続化成功後だけnewsletter deliveryを`queued`にする。consumerは成功時に個別`ack()`、失敗時にbackoff付き`retry()`を行い、上限後は `inaridiy-email-dlq` へ移る。配信はat-least-onceであり、provider受理直後のprocess crashでは重複し得る。

## GitHub Secret

CMS → git用PATはplugin KVへ保存しない。`wrangler secret put GITHUB_EXPORT_TOKEN` で設定し、Adminではrepositoryとbranchだけを保存する。upgrade後のsettings readは旧 `settings:token` を削除する。

## UI / Styling

- Paletteとradiusは `src/styles/theme.css` のshadcn変数だけを変更する。
- `src/styles/tokens.css` は編集しない。
- 色は`light-dark()`でlight/dark両対応。OG cardはサイトに合わせたdark card。
- JA/ENの記事、About、Activityは共有view componentを使う。
- `Base.astro` はmetadataとEmDash page contributionを組み、header/footerは `SiteHeader.astro` / `SiteFooter.astro` が担当する。
- text-first、1 accent、dense listを維持し、hero/card/live-search dropdownは加えない。

## 主要ディレクトリ

```text
packages/content-contract/  translation/search/D1の共有契約
plugins/translator/         Workers AI翻訳
plugins/search-sync/        event-driven AI Search同期
plugins/github-export/      CMS → GitHub Contents API
plugins/newsletter/         double opt-in + durable campaign/outbox
plugins/email-sender/       Queue producer
plugins/cache-purge/        content変更時のWorkers Cache tag purge
content/                    CMS Markdown mirror
scripts/content-sync.mjs    Git ↔ CMS同期
src/email-queue.ts          Queue consumer
src/search-index.ts         hourly reconciliation
src/components/             JA/EN共有view、header/footer
tests/                      pure contract / failure-path tests
.github/workflows/          quality + content sync
```

運用上の不変条件と障害時の挙動は [docs/specs/2026-07-19-content-pipelines.md](docs/specs/2026-07-19-content-pipelines.md) に記録している。
