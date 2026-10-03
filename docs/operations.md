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
pnpm exec wrangler queues create inaridiy-email
pnpm exec wrangler kv namespace create CACHE
```

D1作成時に返るIDを `wrangler.jsonc` の `database_id` に、KV namespace作成時のIDを `kv_namespaces` の `id` に設定する。`inaridiy-email-dlq` はconsumer deploy時、存在しなければCloudflareが自動作成する。DLQ自体にconsumerは設定していないため、失敗messageは保持期間内に手動調査する。

AI Searchを初めて作る場合:

```bash
pnpm exec wrangler ai-search create inaridiy-blog-search --type builtin \
  --hybrid-search true \
  --custom-metadata url:text --custom-metadata title:text \
  --custom-metadata lang:text --custom-metadata collection:text \
  --custom-metadata hash:text --custom-metadata entryId:text
```

## Required secrets

```bash
pnpm exec wrangler secret put EMDASH_ENCRYPTION_KEY
pnpm exec wrangler secret put GITHUB_EXPORT_TOKEN
```

値は対話入力する。`wrangler.jsonc` の `secrets.required` は名前とgenerated typeだけを固定し、値はsource controlへ入れない。ローカル値はignored `.env` に置く。

`EMDASH_ENCRYPTION_KEY` はEmDashのAstro build設定にも必要なので、`pnpm deploy` を実行する環境の `.env` またはprocess environmentにも同じ値を用意する。remote Wrangler Secretだけを設定した状態でbuildしない。`GITHUB_EXPORT_TOKEN` はruntime Bindingだけで参照され、build成果物へ埋め込まれない。

GitHub Actionsのcontent syncにはrepository secrets `EMDASH_URL` と `EMDASH_REFRESH_TOKEN` が必要。後者は次で取得したlogin credentialから登録する。

```bash
npx emdash login --url https://inaridiy.com
```

## Validate and deploy

```bash
pnpm check
pnpm exec wrangler types --check
pnpm check:deploy
pnpm deploy
```

deploy後:

1. `/_emdash/admin` で初期Adminを作成する。
2. Settings → Emailで `email-sender` をproviderとして選択する。
3. Admin → Email Senderでfrom addressが `noreply@inaridiy.com` であることを確認する。
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
pnpm exec wrangler queues list
```

構造化log event:

- `search_index_reconciliation_failed` / `search_index_query_failed`
- `email_queue_delivery_failed` / `email_queue_invalid_message`
- `search_rate_limit_failed` / `ai_search_request_failed`

### Email

- `inaridiy-email` のretryはmessage単位。5回失敗するとDLQへ移る。
- malformed messageはpoison retryを避けるためackし、event logを残す。
- newsletterの`failed` deliveryはcronが最大8回enqueueを再試行する。
- newsletter campaignが`partial`なら`dead`件数をAdminで確認する。

### Search

- `SEARCH` が利用できない場合も公開検索はFTSへfallbackする。
- D1 reconciliation errorでAI Search itemを手動削除しない。次の毎時実行またはcontent save/publishで回復する。
- missing tableはそのcollectionだけ非authoritative扱いになり、既存itemは保持される。

### Content identity

旧Markdownに `cms_id` がなければ、最初の `content:push` または `content:pull` で移行する。Git側でslugを変える前にidentityが入っていることを確認する。誤った/消滅した `cms_id` はslug fallbackせず停止するため、CMSの現状を確認してからpullで復旧する。

### Secret rotation

GitHub PATをrotateしたら `wrangler secret put GITHUB_EXPORT_TOKEN` を再実行してdeployする。plugin KVへtokenを戻さない。Admin settings readは旧plaintext keyを継続的に削除する。
