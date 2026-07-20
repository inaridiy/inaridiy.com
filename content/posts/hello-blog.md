---
cms_id: "01KXWVW18VRGC3KJ4X0MEKXGF4"
slug: "hello-blog"
status: "published"
title: "ブログを作ったよ"
excerpt: "Cloudflare まみれなブログを(AIが)作ったよ。"
---

タラタラ独り言を述べる場が欲しくなったので、ブログを(AIで)こさえてみた。
Cloudflare Blogの新しい構成をまねて、EmDash on Cloudflare Worker with D1,R2をベースにしている。



あと、管理画面ログインやメール購読にはCloudflare Email Sendingを、検索にはCloudflare AI Searchを入れて、Cloudflare Rate Limittingでレート制限している。

さらに、自動翻訳機能もCloudflare Worker AIでGemma4を呼び出すことで実現しているし、記事の内容もGithubと連携されるようになっていて、パソコン上でMDとして編集できる。



一昔前なら、こんだけ大層な機能の付いたブログを作ろうとするとそれ何に時間がかかったが、Fable5君とGPT5.6 Sol君にお願いしたら半日ぐらいで作ってくれた。便利な時代だ。あと、CF系だけでAI呼び出しからDB、メール送信まで完結出来て、全部Service Bindingで呼べるようになったのもデカいと思う。普通に開発体験が良すぎて感動した





このブログを作るにあたって、眠らせていた [https://inari.diy](https://inari.diy) っていうドメインも活用する事にした。 [https://inari.diy](https://inari.diy) にアクセスすると、 [https://inaridiy.com](https://inaridiy.com) にリダイレクトされる。名刺とかに [inari.diy](http://inari.diy) って書けるのなんかいいよね。



では、続くかもしれないし、続かないかもしれない。僕は三日坊主なので
