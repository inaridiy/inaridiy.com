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
pnpm exec wrangler secret put GITHUB_EXPORT_TOKEN
```

値は対話入力する。`wrangler.jsonc` の `secrets.required` は名前とgenerated typeだけを固定し、値はsource controlへ入れない。ローカル値はignored `.env` に置く。

どちらもruntimeに `process.env` / Bindingから読まれ、build成果物へ埋め込まれない。buildは名前の存在だけを確認するので、CIはplaceholder値でbuildする。ローカルでbuildすると `.env` の値が `dist/server/.dev.vars` (dev用、deploy対象外) に書かれるため、`dist/` を共有しない。

### GitHub Actions secrets

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | `ci.yml` のdeploy job。dashboardのAPI Tokensで「Edit Cloudflare Workers」templateから作り、対象をこのaccountと `inaridiy.com` zoneに絞る。deployが権限不足で失敗したら、errorに出たresource (D1、AI Search等) の権限を足す |
| `CLOUDFLARE_ACCOUNT_ID` | 同上 |
| `EMDASH_URL` / `EMDASH_REFRESH_TOKEN` | `content-sync.yml` |

```bash
gh secret set CLOUDFLARE_API_TOKEN          # 値は対話入力
gh secret set CLOUDFLARE_ACCOUNT_ID --body <account id>
npx emdash login --url https://inaridiy.com # EMDASH_REFRESH_TOKEN の取得元 (90日で失効)
```

deploy jobは `production` environmentで動く。承認を挟みたい場合はGitHubのenvironment protection rulesで設定する。

## Validate and deploy

通常は `main` へのpushで `.github/workflows/ci.yml` が `pnpm check` の後にdeployする (`content/**` だけの変更ではdeployしない)。手元からdeployする場合:

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
4. Admin → GitHub Exportでrepository (`owner/name`) とbranchを設定する。PAT入力欄は存在しない。
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
- `[ai-search]` (EmDash aiSearch plugin)、`auto-translator:`、`newsletter:`、`github-export:`
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

GitHub PATをrotateしたら `wrangler secret put GITHUB_EXPORT_TOKEN` を再実行してdeployする。plugin KVへtokenを戻さない。Admin settings readは旧plaintext keyを継続的に削除する。
