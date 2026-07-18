# inaridiy.com

[EmDash](https://emdashcms.com) (Astro ベースの CMS) で構築した個人ブログ。Cloudflare Workers 上で動作し、D1 / R2 / AI Search / AI Gateway を利用する。

## 構成

| 要素 | 実装 |
| --- | --- |
| CMS / フレームワーク | EmDash + Astro (SSR, `output: "server"`) |
| ホスティング | Cloudflare Workers (`wrangler deploy`) |
| データベース | Cloudflare D1 (`DB` バインディング) |
| メディア | Cloudflare R2 (`MEDIA` バインディング) |
| 検索 | Cloudflare AI Search (旧 AutoRAG) + EmDash 全文検索 (FTS) |
| 自動英訳 | 自作プラグイン `plugins/translator` — AI Gateway 経由で LLM を呼ぶ |
| スタイル | shadcn/ui 互換 CSS 変数体系 (`src/styles/theme.css`) |

### ページ

| パス | 内容 |
| --- | --- |
| `/` | 最新記事の HN 風リスト + 直近の活動歴 |
| `/posts` `/posts/[slug]` | 記事一覧・記事詳細 |
| `/activities` | 活動歴の全リスト (年ごとにグループ表示、フッターとトップからリンク) |
| `/about` | 自己紹介 (`pages` コレクションの `about` スラッグ) |
| `/search` | 全文検索 + AI 検索 (「AI に聞く」)。ヘッダーの検索欄から遷移 |
| `/en/...` | 自動英訳版 (`/en`, `/en/posts/[slug]`, `/en/activities`, `/en/about`) |
| `/rss.xml` | RSS フィード |
| `/_emdash/admin` | 管理画面 |

ヘッダーは `サイト名 / blog / about / en` + 検索欄のみ。ナビは `src/layouts/Base.astro` にハードコード (CMS のメニュー機能は SNS リンク用の `social` メニューのみ使用)。

### コンテンツスキーマ (`seed/seed.json`)

- `posts` — `title` / `content` / `excerpt` / `featured_image` (OGP 用) + 自動英訳用の `title_en` / `excerpt_en` / `content_en`
- `pages` — `title` / `content` + `title_en` / `content_en`
- `activities` — `title` / `date` / `kind` / `url` / `description` + `title_en` / `description_en`

`*_en` フィールドは翻訳プラグインが書き込む。管理画面から手修正も可能。

## ローカル開発

```bash
pnpm install
npx emdash dev        # migrations + seed + 型生成 + dev サーバー (localhost:4321)
```

- 管理画面: `http://localhost:4321/_emdash/admin`
- 開発用ログインバイパス: `http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`
- 型の再生成: `npx emdash types` / `npx wrangler types`
- 検証: `pnpm typecheck` / `pnpm build`

シードは「DB が空の初回リクエスト時」に自動適用される。スキーマだけ入ってコンテンツが入らなかった場合は手動で適用できる:

```bash
# ローカル (workerd の D1 実体に直接適用)
npx emdash seed seed/seed.json -d .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite
```

## デプロイ手順

```bash
wrangler login

# 1. D1 データベースを作成し、返ってきた id を wrangler.jsonc の database_id に貼る
wrangler d1 create inaridiy-com

# 2. メディア用 R2 バケット
wrangler r2 bucket create inaridiy-media

# 3. 暗号化キー (ローカルの .env の EMDASH_ENCRYPTION_KEY と同じ形式)
wrangler secret put EMDASH_ENCRYPTION_KEY

# 4. デプロイ
pnpm deploy           # = astro build && wrangler deploy
```

初回アクセスでセットアップウィザードが起動し、パスキーで管理者を作成する。シードも同時に適用される。

## AI Search (検索) の有効化

1. ダッシュボードで AI Search の API トークンを作成: **AI > AI Search > Tokens**
2. インスタンスを作成:

   ```bash
   wrangler ai-search create inaridiy-blog-search --type builtin \
     --hybrid-search true \
     --custom-metadata url:text --custom-metadata title:text \
     --custom-metadata lang:text --custom-metadata collection:text \
     --custom-metadata hash:text
   ```

3. `wrangler.jsonc` の `ai_search` バインディングのコメントを外し、`npx wrangler types` を実行して再デプロイ。

仕組み: インデックス登録は**イベント駆動**。`plugins/search-sync` プラグインが記事の公開/更新/非公開/削除フックで、対象エントリを Markdown 化して AI Search の組み込みストレージへ即時 upsert / 削除する (自動英訳より後の priority で動くので、同一リクエスト内で `*_en` も反映される)。cron (毎時 0 分、`src/worker.ts` → `src/search-index.ts`) は取りこぼし用の照合バックストップ。`/search` の「AI に聞く」は `chatCompletions` (RAG 回答) と `search` (出典リンク) を並列で呼ぶ。バインディングが無い環境では自動的に全文検索へフォールバックする。

## 自動英訳 (AI Gateway) の有効化

1. ダッシュボードで AI Gateway を作成: **AI > AI Gateway** (例: gateway id `inaridiy-blog`)
2. 使いたいプロバイダの API キーを Gateway に保存 (BYOK)。Workers AI を使う場合は Workers AI 権限付きの Cloudflare API トークンを登録
3. (推奨) Gateway を Authenticated にして、そのトークンを控える
4. 管理画面 **Admin > Translator** で設定:
   - Cloudflare account ID
   - AI Gateway ID
   - Model — `{provider}/{model}` 形式。**ここを書き換えるだけでモデルを切り替えられる**
     - `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`
     - `openai/gpt-4o-mini`
     - `anthropic/claude-sonnet-4-5` など
   - Gateway token (Authenticated Gateway の場合)

仕組み: 記事の公開/更新時に `content:afterSave` / `content:afterPublish` フックが発火し、AI Gateway の unified endpoint (`/compat/chat/completions`) で本文を翻訳して `*_en` フィールドへ書き戻す。日本語ソースのハッシュを KV に保存し、本文が変わっていなければ再翻訳しない (Translator 管理画面からキャッシュのリセット可)。コードブロックとインラインコードは翻訳対象外。

## 記事の Markdown 管理 / GitHub 同期

記事の実体は `content/posts/*.md`(frontmatter: `slug` / `status` / `title` / `excerpt` + 本文 Markdown)。EmDash 公式クライアントの Portable Text ⇄ Markdown 変換(標準ブロックはロスレス往復、未知ブロックは `<!--ec:block ... -->` フェンスで保全)を使うため、独自変換は持たない。

```bash
pnpm content:pull   # CMS → content/posts/*.md
pnpm content:push   # content/posts/*.md → CMS (--prune でローカルに無い記事を削除)
```

- push は slug をキーに upsert。新規は create→publish、更新は `_rev` による楽観ロック付き update→publish。無変更はスキップ(冪等)
- **API 経由の公開でもフックは発火する**ので、git から push した記事も自動英訳・AI Search 登録される
- `*_en` フィールドは翻訳プラグインの管轄なので同期対象外。タクソノミーは管理画面で管理

同期は両方向とも**イベント駆動**:

- **git → CMS**: `content/**` への push で GitHub Actions (`.github/workflows/content-sync.yml`) が `content:push` を実行
- **CMS → git**: `plugins/github-export` プラグインが記事の保存/公開/非公開/削除の瞬間に、GitHub Contents API で `content/posts/<slug>.md` をコミット(コミットメッセージの `[cms-sync]` マーカーで Actions 側はスキップされ、ループしない)
- 手動の `pull` は復旧用として workflow_dispatch に残してある(定期実行なし)

エディタについて: この構成では **Markdown の編集は手元のエディタ(VSCode など)や GitHub 上で行う**のが主経路。管理画面の WYSIWYG (ProseMirror) で直した内容も即座に Markdown としてコミットされるので破綻しない。エージェントからは MCP サーバー / `emdash content` CLI 経由で Markdown のまま読み書きできる。管理画面自体に生 Markdown エディタを載せるにはネイティブプラグイン(React)が必要(未実装・必要なら追加可)。

## メール送信 (Cloudflare Email Sending)

EmDash のメール(認証メール、コメント通知、プラグインからの `ctx.email.send()`)は `plugins/email-sender` が **Cloudflare Email Sending** で配送する。API キー不要(`send_email` Worker バインディング、inaridiy.com はオンボード済み)。

- 送信元は `noreply@inaridiy.com`(`wrangler.jsonc` の `allowed_sender_addresses` で制限。変える場合は両方更新)
- 差出人名・アドレスは管理画面 **Admin → Email Sender** で変更可能
- 有効化: デプロイ後に管理画面 **Settings → Email** でプロバイダとして email-sender を選択
- 配送はデプロイ環境のみ(ローカルで実送信したい場合は binding に `"remote": true` を付ける)

## トークン設定まとめ

| どこに | 何を | 用途 / 作り方 |
| --- | --- | --- |
| GitHub リポジトリシークレット `EMDASH_URL` | サイト URL | Actions の git→CMS push 先 |
| GitHub リポジトリシークレット `EMDASH_REFRESH_TOKEN` | EmDash リフレッシュトークン | デプロイ後に `npx emdash login --url <サイト>` → `~/.config/emdash/auth.json` の `refreshToken` を登録。90 日有効、期限切れ時は再ログイン |
| 管理画面 Admin → GitHub Export | GitHub fine-grained PAT | CMS→git コミット用。github.com/settings/personal-access-tokens で **このリポジトリのみ・Contents: Read and write** に絞って発行 |
| 管理画面 Admin → Translator | AI Gateway トークン (任意) | Authenticated Gateway の場合のみ。プロバイダキーは AI Gateway 側に BYOK 保存 |
| Wrangler シークレット `EMDASH_ENCRYPTION_KEY` | 暗号化キー | 管理画面で保存するシークレット (PAT 等) の暗号化に使用 |

すべての PAT / トークンは最小権限で: GitHub PAT は単一リポジトリ + Contents のみ、EmDash トークンは自サイトのみ、AI Gateway キーは Gateway 側に置いてコードや git には一切入れない。

## スタイルシステム

`src/styles/theme.css` に **shadcn/ui 互換の CSS 変数** (`--background` / `--foreground` / `--primary` / `--secondary` / `--muted` / `--accent` / `--destructive` / `--border` / `--input` / `--ring` / `--radius` / `--chart-*`) をライト・ダーク両対応 (`light-dark()`) で定義し、EmDash テンプレートのトークン (`--color-*`) をそこへマッピングしている。

- 配色やラディウスの変更は theme.css の shadcn 変数を書き換えるだけ (1 箇所)
- 将来 shadcn/ui や Tailwind のコンポーネントを導入する場合も同じ変数がそのまま使える
- `src/styles/tokens.css` と `src/layouts/Base.astro` は直接編集しない (テンプレートの規約)

## ディレクトリ

```
content/posts/          記事の Markdown ミラー (git が実体)
plugins/email-sender/   Cloudflare Email Sending トランスポート (email:deliver)
plugins/translator/     自動英訳プラグイン (pnpm workspace)
plugins/search-sync/    AI Search イベント駆動同期プラグイン (docs.ts は cron と共有)
plugins/github-export/  CMS→git イベント駆動コミット (format.mjs はスクリプトと共有)
scripts/content-sync.mjs  git⇄CMS 同期スクリプト (content:pull / content:push)
.github/workflows/      content-sync (git→CMS push、手動 pull)
seed/seed.json          スキーマ + 初期コンテンツ
src/layouts/Base.astro  共通レイアウト (ヘッダー / フッター / テーマ切替)
src/pages/              ルーティング (en/ 以下が英語版)
src/search-index.ts     AI Search 照合バックストップ (毎時 cron)
src/worker.ts           Worker エントリ (EmDash + cron 合成)
src/styles/theme.css    スタイルシステム (shadcn 互換トークン)
```
