# inaridiy.com

[EmDash](https://emdashcms.com) と Astro で構築した、HackerNews風のテキスト中心ブログ。Cloudflare Workers上でSSRし、D1、R2、Workers AI、AI Search、Workflows、Email SendingをBinding経由で利用する。日本語が原文で、英語版はEmDash native i18nの翻訳entryとして `/en/` 以下に出し、未翻訳なら日本語へfallbackする。

## 概要

| 要素 | 実装 |
| --- | --- |
| CMS / Web | EmDash 1.1 + Astro 7 (`output: "server"`) |
| Runtime | Cloudflare Workers |
| Content / Media | D1 (`DB`) / R2 (`MEDIA`) |
| キャッシュ | Workers Cache (edge HTML, tag purge) + KV object cache (`CACHE`) |
| i18n | EmDash native i18n (`ja` = default/source, `en` = `/en/`) |
| 検索 | EmDash `aiSearch()` plugin (`AI_SEARCH` namespace) + EmDash FTS fallback |
| 翻訳 | `plugins/translator` → Workflow → Workers AI (`AI`)、任意でAI Gateway経由 |
| メール | EmDash `cloudflareEmail()` → Email Sending (`EMAIL`) |
| Rate limit | Cloudflare Rate Limiting bindings (`AI_RATE_LIMITER`, `NEWSLETTER_RATE_LIMITER`) |
| Styling | shadcn/ui互換CSS変数、Inter + JetBrains Mono |

主なページは `/`、`/posts`、`/posts/[slug]`、`/activities`、`/about`、`/search`、`/en/...`、`/rss.xml`。管理画面は `/_emdash/admin`。

## セットアップ

Node.js 24とpnpm 11を使用する。

```bash
pnpm install
pnpm dev
```

- サイト: `http://localhost:4321`
- 管理画面: `http://localhost:4321/_emdash/admin`
- 開発ログイン: `http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`

`pnpm dev`（`astro dev`）はローカルD1を使い、初回リクエスト時にmigrationとseedのschema適用を行う。EmDash型 (`emdash-env.d.ts`) は起動時に生成される。Worker Binding型を更新するときは `pnpm exec wrangler types` を実行する。実環境の作成、Secret、初回deployは [docs/operations.md](docs/operations.md) を参照。

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
pnpm run deploy           # build + wrangler deploy (通常はCloudflare Workers Buildsがmainから実行)
```

## 手動確認

変更後はまず `pnpm check` を通し、`pnpm dev` で次を確認する。

1. `/`、`/posts`、記事詳細、`/activities`、`/about` が表示される。
2. 対応する `/en/` ページで英語entryが使われ、未翻訳時は日本語へfallbackする。言語切替リンクとhreflangが相手entryを指す。
3. `/search?q=test` と `/search?q=test&lang=en` が結果または分類済みメッセージを返し、内部例外を表示しない (dev はdev用AI Search instanceを使う。index前は0件)。
4. Footerの購読フォームが中立な成功・失敗メッセージを返す。
5. AdminのGitHub Exportにtoken入力欄がなく、`GITHUB_EXPORT_TOKEN` Secretの案内だけが出る。

本番Bindingを含む非破壊の構成確認:

```bash
pnpm exec wrangler types --check
pnpm check:deploy
```

## コンテンツ契約

`seed/seed.json` のコレクション:

- `posts`: `title`, `excerpt`, `content`, `featured_image` (translatable: false)
- `pages`: `title`, `content`
- `activities`: `title`, `date`, `kind`, `url`, `description` (`date` / `kind` / `url` は translatable: false)

`astro.config.mjs` の `i18n` で `ja` (default、prefixなし) と `en` (`/en`) を設定している。日本語entryと英語entryは同じtranslation groupに属する別rowで、slugもlocaleごとに持つ。translatable: false のfieldはEmDashがgroup内で同期する。

翻訳対象field、locale、公開pathは `packages/content-contract` に集約し、translator・ページ・検索結果のURL変換が同じ契約を読む。翻訳groupをまたぐリンク (言語切替、hreflang、`/en/about`、OG) は `src/utils/i18n.ts` が `getTranslations()` から解決する。

すべてのCMSクエリページは返された `cacheHint` を `Astro.cache.set()` へ渡す。Activity一覧はcursorを最後まで追い、各ページのcache tagを合成する。

## Markdown / CMS同期

`content/posts`、`content/pages`、`content/activities` はCMSの日本語entryのMarkdownミラー。frontmatterの共通identityは次の通り。

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
- 英語entryとtaxonomyは同期しない。翻訳pluginとAdminが所有する。`content:push --prune` も日本語entryだけを対象にする。

`content:push --prune` はローカルに対応IDがないCMS entryを削除するため、通常運用では明示的に必要な場合だけ使う。

## 翻訳

`plugins/translator` は公開済みの日本語entryを英訳し、同じtranslation groupの英語entryを作成・更新・公開する。既定modelは `@cf/google/gemma-4-26b-a4b-it`、AI Gateway IDはAdminで任意設定できる。

- hookはWorkflow instanceを作るだけで、model呼び出しはsegmentごとの再試行可能なstepで行う。
- 英語entryはpluginが所有する。日本語sourceが変わると英語entryの手動編集は上書きされる。
- 英語entryのslugは作成時に英語titleから決まる。`/en/posts/<日本語slug>` は英語entryへ301する。
- 日本語sourceのunpublishに追従して英語entryもunpublishする。再publishで戻す。
- 翻訳に失敗したら古い英語entryをunpublishし、`/en` は日本語へfallbackする。
- 入力はsegment数とserialized文字数で分割し、応答は同数・同順序・非空stringのJSON arrayに限る。
- entryごとのleaseで重複jobを抑え、source hashが変わった古い結果は破棄する。
- code blockとinline codeは翻訳しない。

## キャッシュ

3層構成。コンテンツ変更は即時purgeされ、TTLはfallbackに過ぎない。

1. **Workers Cache** (`wrangler.jsonc` の `"cache"`): Workerの前段のedge cache。route cache providerはAstro Cloudflare adapterの `cacheCloudflare()`。公開HTMLは `routeRules` (astro.config.mjs) の `Cloudflare-CDN-Cache-Control: max-age=300, stale-while-revalidate=86400` と、EmDash cacheHint由来の `Cache-Tag` (collection名 + entry ULID) を返す。EmDashのadmin書き込みは `Astro.cache.invalidate()` を自ら呼び、HTTP routeを通らない書き込み (予約公開cron、plugin write-back) は `plugins/cache-purge` がcontent hookから `cache.purge({ tags })` で補う。
2. **KV object cache** (`CACHE` binding): EmDashのD1 query結果cache (`objectCache: kvCache(...)`)。invalidationはEmDash内蔵。
3. **D1 read replication** (`session: "auto"`): 読み取りを近隣replicaへ。

制約:

- Astro route cachingは `cache.provider` が無いと無効で、`Astro.cache.set` はno-opになる。独自providerに置き換える場合も **`onRequest` を実装しない**こと — 実装するとAstroが `Cache-Tag` / CDN cache headerを最終responseから剥がし、edge cacheが機能しなくなる。
- browserには `src/middleware.ts` が `Cache-Control: public, max-age=0, must-revalidate` を付け、常にedgeへ再検証させる (purge後のstale HTML防止)。
- `/search` はvisitor cookieとrate limitを持つため `private, no-store`。
- routeを追加したら明示的な `Cache-Control` を返すこと。無いとWorkers Cacheのheuristic freshness (200は約2時間) で勝手にcacheされる。
- loginしたままsiteを見ると、cacheされた匿名variant (editing toolbar無し) が返ることがある (edge cacheはCookieを見ない)。保存・公開すればpurgeされる。

## 検索とRate Limiting

EmDash公式の `aiSearch()` plugin (`@emdash-cms/cloudflare/plugins`) がentryをlocale付きでAI Search instance (`inaridiy-content`、`astro dev` では `inaridiy-content-dev`) へindexする。collection選択、初回の全件sync、同義語はAdmin → Cloudflare AI Searchで管理する。AI Search Bindingは `astro dev` でも実accountへ接続するため、dev用instanceを分けている。

`/search` は300文字まで。通常検索はpluginの検索handlerを、AI回答は同じinstanceの `chatCompletions` を、どちらも閲覧中のlocale (`?lang=en`) に絞って呼ぶ。AI Searchを呼ぶ前に公式 `AI_RATE_LIMITER.limit({ key })` をHttpOnly visitor IDごとに実行する。Binding障害・上限超過・AI Search障害ではFTSへfallbackし、利用者には分類済みの一般メッセージだけを返す。

Rate Limiting Bindingはcolo単位・eventually consistentなabuse guardであり、厳密な課金カウンタではない。

自作pluginのcontent hookはpriority 50〜90で、`aiSearch()` のhook (priority 100、errorPolicy `abort`、timeout 5秒) より先に走らせる。AI Searchが遅いとそのhook chainが中断されるため。

## Newsletter / Email

Footer購読はdouble opt-in。購読要求は正規化emailのSHA-256をkeyに、公式 `NEWSLETTER_RATE_LIMITER` で制限する。email storageにはunique indexと短い送信leaseがあり、同時初回登録による重複確認メールを抑える。

日本語postの初回公開hookはcampaignを1件作るだけ。5分ごとのEmDash cronがbounded pageで購読者を列挙し、campaign/subscriberごとのdelivery outboxを作って送る。状態は `pending` / `failed` / `sent` / `dead` / `skipped` で、失敗はbackoff付きで最大8回再試行する。

EmDashの全メールはEmDash公式 `cloudflareEmail()` providerがEmail Sending (`EMAIL` binding) で送る。配信はat-least-onceであり、provider受理直後のprocess crashでは重複し得る。

## GitHub Secret

CMS → git用PATはplugin KVへ保存しない。`wrangler secret put GITHUB_EXPORT_TOKEN` で設定し、Adminではrepositoryとbranchだけを保存する。upgrade後のsettings readは旧 `settings:token` を削除する。

## UI / Styling

- Paletteとradiusは `src/styles/theme.css` のshadcn変数だけを変更する。
- `src/styles/tokens.css` は編集しない。
- 色は`light-dark()`でlight/dark両対応。OG cardはサイトに合わせたdark card。
- JA/ENの記事、About、Activityは共有view componentを使い、localeごとのentryをそのまま渡す。
- `Base.astro` はmetadataとEmDash page contributionを組み、header/footerは `SiteHeader.astro` / `SiteFooter.astro` が担当する。
- text-first、1 accent、dense listを維持し、hero/card/live-search dropdownは加えない。

## 主要ディレクトリ

```text
packages/content-contract/  locale・翻訳field・公開pathの共有契約
plugins/translator/         JA → EN翻訳entry (Workflow + Workers AI)
plugins/github-export/      CMS → GitHub Contents API
plugins/newsletter/         double opt-in + durable campaign/outbox
plugins/cache-purge/        content変更時のWorkers Cache tag purge
content/                    CMSの日本語entryのMarkdown mirror
scripts/content-sync.mjs    Git ↔ CMS同期
scripts/migrate-native-i18n.mjs  *_en → native i18n移行 (2026-10、実行済み)
src/translator-workflow.ts  翻訳Workflow
src/utils/i18n.ts           translation group経由のlink / hreflang解決
src/utils/search.ts         /search のAI Search呼び出し
src/components/             JA/EN共有view、header/footer
tests/                      pure contract / failure-path tests
.github/workflows/          CI (check) + content sync。deployはCloudflare Workers Builds
```

運用上の不変条件と障害時の挙動は [docs/specs/2026-10-03-native-i18n.md](docs/specs/2026-10-03-native-i18n.md) (現行) と [docs/specs/2026-07-19-content-pipelines.md](docs/specs/2026-07-19-content-pipelines.md) (一部置き換え済み) に記録している。
