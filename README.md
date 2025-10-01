# Mail Discord Fork

Cloudflare Workersを使ったメール転送とDiscord通知を行うプロジェクトです。

## 機能

- 受信メールの転送
- Discordへの通知送信
- メールのパースと整形

## セットアップ

1. 依存関係のインストール
```bash
pnpm install
```

2. 環境変数の設定
```
wrangler secret put RECIPIENTS
wrangler secret put DISCORD_WEBHOOKS
```

## デプロイ

```bash
pnpm run deploy
```

## 使用方法

1. Cloudflareでメール受信ドメインを設定
2. 転送先メールアドレスをRECIPIENTSにカンマ区切りで設定
3. Discord Webhook URLをDISCORD_WEBHOOKSにカンマ区切りで設定