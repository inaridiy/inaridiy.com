# Operations

Cloudflare resourceの初回作成、Secret、deploy、復旧手順。コマンドにSecret値を直接書かない。

## Prerequisites

- Node.js 24 / pnpm 11
- Wranglerで対象Cloudflare accountへlogin済み
- `inaridiy.com` がWorkers、Email Sendingで利用可能
- GitHub fine-grained PATはこのrepositoryのContents read/writeだけを許可

## First provision

既存resourceがある場合は作り直さず、`wrangler.jsonc` の名前・IDと一致することだけを確認する。

```bash
pnpm install
pnpm exec wrangler login

pnpm exec wrangler d1 create inaridiy-com
pnpm exec wrangler r2 bucket create inaridiy-media
pnpm exec wrangler kv namespace create CACHE
```

D1作成時に返るIDを `wrangler.jsonc` の `database_id` に、KV namespace作成時のIDを `kv_namespaces` の `id` に設定する。

AI Search instanceは作らない。EmDashの `aiSearch()` pluginが `default` namespaceに `inaridiy-content` (dev: `inaridiy-content-dev`) を必要なcustom metadata付きで自動作成する。

## Required secrets

```bash
pnpm exec wrangler secret put EMDASH_ENCRYPTION_KEY
```

値は対話入力する。`wrangler.jsonc` の `secrets.required` は名前とgenerated typeだけを固定し、値はsource controlへ入れない。ローカル値はignored `.env` に置く。

どちらもruntimeに `process.env` / Bindingから読まれ、build成果物へ埋め込まれない。buildは名前の存在だけを確認するので、CIはplaceholder値でbuildする。ローカルでbuildすると `.env` の値が `dist/server/.dev.vars` (dev用、deploy対象外) に書かれるため、`dist/` を共有しない。

### GitHub Actions secrets

| Secret | 用途 |
| --- | --- |
| `EMDASH_URL` / `EMDASH_TOKEN` | `content-sync.yml`。`EMDASH_TOKEN` はAdminで作るAPI token (content:read, content:write, schema:read)。`EMDASH_REFRESH_TOKEN` (90日) もfallbackとして読む |

```bash
npx emdash login --url https://inaridiy.com # EMDASH_REFRESH_TOKEN の取得元 (90日で失効)
```

Cloudflare API tokenはGitHubに置かない。deployはCloudflare Workers Buildsが行う (次節)。

## Validate and deploy

`main` へのpushでCloudflare Workers Buildsが `pnpm check` (型・test・build・bundle budget) を実行し、通ったときだけ `wrangler deploy` する。GitHub Actionsの `ci.yml` はPRとpushのcheckだけを担当する。

Workers Buildsの設定 (dashboard → Workers & Pages → `inaridiy-com` → Settings → Build):

| 項目 | 値 |
| --- | --- |
| Git repository | `inaridiy/inaridiy.com` |
| Production branch | `main` |
| Root directory | `/` |
| Build command | `pnpm check` |
| Deploy command | `pnpm exec wrangler deploy` |
| Non-production branch builds | 無効 (PRはGitHub Actionsでcheck) |
| Build watch paths | include `*`、exclude `content/*` (CMS → git同期commitではdeployしない) |
| Build variables | `PNPM_VERSION=11.9.0` (build imageの既定はpnpm 10)。Node.jsは `.node-version` |

Worker名 (`inaridiy-com`) は `wrangler.jsonc` の `name` と一致している必要がある。build失敗時はdashboardのBuild履歴でlogを見る。

手元からdeployする場合 (緊急時):

```bash
pnpm check
pnpm exec wrangler types --check
pnpm check:deploy
pnpm run deploy   # `pnpm deploy` はpnpm組み込みcommandなので使わない
```

初回deploy後:

1. `/_emdash/admin` で初期Adminを作成する。
2. Settings → Emailで `cloudflare-email` がproviderになっていることを確認し、test emailを送る。差出人は `astro.config.mjs` の `cloudflareEmail({ from })`。
3. Admin → Cloudflare AI Searchでposts / pages / activitiesを選び、Sync All Contentを実行する。
4. Admin → GitHub Syncでrepository (`owner/name`)、fine-grained PAT (このrepositoryのContents read/writeのみ)、branchを設定し、Export allを実行する。
5. Admin → Translatorでmodelと任意のAI Gateway IDを確認する。

## Rate limits

`wrangler.jsonc` に2つの公式Bindingがある。

- `AI_RATE_LIMITER`: visitor/resourceごとに60秒10回
- `NEWSLETTER_RATE_LIMITER`: normalized email hashごとに60秒2回

`namespace_id` はaccount内で一意な正の整数文字列を維持する。同じIDを別Bindingで再利用するとcounterを共有する。Rate Limiting APIはcolo-localかつpermissiveなので、billing accountingやglobal exact quotaには使わない。

## Monitoring and recovery

```bash
pnpm exec wrangler tail
pnpm exec wrangler ai-search stats inaridiy-content
```

構造化log event / prefix:

- `search_rate_limit_failed` / `ai_search_request_failed` / `fts_search_failed`
- `[ai-search]` (EmDash aiSearch plugin)、`auto-translator:`、`newsletter:`、`github-sync:`
- `EmDash <hook> hook error: Hook timeout after 5000ms` は多くが `aiSearch()` のhook。自作pluginのhookはそれより先に走る (README「検索とRate Limiting」)。

### Email

- newsletterの`failed` deliveryはcronがbackoff付きで最大8回再送する。
- newsletter campaignが`partial`なら`dead`件数をAdminで確認する。
- magic link等の送信失敗はSettings → Emailのtest emailで原因を確認する。

### Search

- `AI_SEARCH` が利用できない、またはAI Searchが失敗した場合、公開検索はFTSへfallbackする。
- indexがずれた場合はAdmin → Cloudflare AI SearchのSync All Contentで再同期する。

### Translation

- 翻訳失敗 (`model_or_contract` failure) では古い英語entryがunpublishされ、`/en` は日本語へfallbackする。日本語entryを再保存/再publishすると再試行される。
- Workers AIの `4006: Service temporarily at capacity` は一時的なmodel容量不足。続く場合はAdmin → Translatorでmodelを変える。

### Content identity

旧Markdownに `cms_id` がなければ、最初の `content:push` または `content:pull` で移行する。Git側でslugを変える前にidentityが入っていることを確認する。誤った/消滅した `cms_id` はslug fallbackせず停止するため、CMSの現状を確認してからpullで復旧する。

### Secret rotation

GitHub PATをrotateしたら、Admin → GitHub Syncのtoken欄に新しい値を入力して保存する (deploy不要)。
