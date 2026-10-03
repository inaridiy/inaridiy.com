# Content pipeline invariants — 2026-07-19

> 2026-10-03: 「Search reconciliation」と「Email and newsletter」のQueue部分、`*_en` fieldを前提にした記述は [native i18n](2026-10-03-native-i18n.md) で置き換えた。Translationのbatch/contract/lease/hashの不変条件は引き続き有効 (stale targetはclearではなくunpublish)。

## Search reconciliation

- Translation map、search projection、D1 columnsは `@inaridiy/content-contract` が正本。
- Event pathとhourly pathは同じdocument key、metadata、hashを使う。
- reconciliationでdeleteできるのは、そのrunでD1 scanに成功した既知collectionが所有するitemだけ。
- `no such table` 以外のD1 errorはrun全体を中断する。
- metadataのないitem、未知collectionのitem、scan失敗collectionのitemは保持する。

## Translation

- Providerへ渡す単位はserialized 8,000文字・30segment以下。
- 1segmentだけでbudgetを超える入力は送らず、明示的に失敗する。
- Accepted outputはexact cardinalityの非空string JSON arrayのみ。単一JSON code fenceは許可する。
- Source snapshotにはfield structure、model、Gateway IDを含めてhashする。
- Leaseを失ったrunとsource hashが変わったrunは結果を永続化しない。
- Changed sourceのprovider/contract failureでは全targetをclearし、stale translationを公開しない。

## Content identity

- CMS ULID (`cms_id`) がMarkdown identity。slugはURL/pathでありrename可能。
- ID付きlocal entryがremoteに存在しない場合、slug fallbackで別entryを上書きしない。
- prune exclusionはslugではなくmatched remote IDで判定する。
- CMS → Git renameはnew path writeが先、old path deleteが後。

## Email and newsletter

- EmDashのemail providerはEmail Sendingを直接呼ばず、先に `EMAIL_QUEUE` へversioned envelopeを保存する。
- Queue consumerはprovider成功後にackし、失敗時はmessage単位でretryする。
- Newsletter publish hookはcampaign record作成だけを行う。
- Delivery identityはcampaign ID + subscriber ID。campaign completionは全subscriber enumeration完了かつretryable delivery 0件が条件。
- `dead` が1件以上ならcampaignは`partial`で、成功扱いにしない。
- Queue/provider境界はat-least-once。exactly-onceを主張しない。

## Abuse boundaries

- AI Searchとsubscription emailのcost-bearing callはCloudflare公式Rate Limiting Bindingを通る。
- AI keyはfirst-party HttpOnly visitor ID、newsletter keyはnormalized emailのSHA-256。
- Binding errorではprovider callを行わない。
- Rate limiterはcolo-local abuse guardであり、正確なglobal quotaではない。

## Verification

`pnpm check` はAstro diagnostics、全workspace TypeScript、unit tests、production buildを実行する。unit testsはmissing-table deletion scope、unexpected D1 abort、JA/EN projection、strict translation grammar、chunk budget、Markdown identity、Queue envelopeを固定する。
