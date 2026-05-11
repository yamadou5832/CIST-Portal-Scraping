# Cloudflare Workers 本気移植プラン

## Summary
- 既存の `Express + Node.js Playwright + ローカル storageState` 構成を、`Cloudflare Workers + Hono + @cloudflare/playwright + KV` 構成へ移植する。
- API公開保護はアプリ内Bearer認証ではなく、ユーザー選択どおり **Cloudflare Access 前提** とする。
- 既存ローカルExpress版は維持せず、Workers専用構成へ整理する。

## Key Changes
- HTTP入口を `app.listen()` から Workers の `fetch(request, env, ctx)` へ変更し、ルーティングは **Hono** で実装する。
- 通常の `playwright` / `chromium.launch()` を削除し、`@cloudflare/playwright` の `launch(env.BROWSER)` を使う。
- `.auth/storage-state.json` 保存を廃止し、KV binding `CIST_AUTH_KV` の key `portal-storage-state` に Playwright `storageState` JSON を保存する。
- `dotenv` / `process.env` / `node:fs` / `node:path` 依存を外し、Workers `env` から設定を読む。
- `wrangler.jsonc` を追加し、Worker name は `cist-portal-scraping-api`、main は `src/index.ts`、browser binding は `BROWSER`、KV binding は `CIST_AUTH_KV` にする。
- `package.json` は Workers 用に更新する。
  - 追加: `hono`, `@cloudflare/playwright`, `wrangler`
  - 削除: `express`, `dotenv`, `playwright`, `@types/express`
  - scripts: `dev` は `wrangler dev --remote`、`deploy` は `wrangler deploy`、`check` は `tsc --noEmit`

## API / Config
- 既存エンドポイントは維持する。
  - `GET /health`
  - `GET /api/mypage`
  - `GET /api/unsubmitted-reports`
  - `GET /api/reflection-replies`
  - `GET /api/timetable`
  - `GET /api/received-office-memos?filter=all|unread|read|star&searchKeyword=...&c_filter=...`
- Workers env/secrets は以下に固定する。
  - secret: `CIST_USERNAME`
  - secret: `CIST_PASSWORD`
  - variable: `CIST_PORTAL_URL`, default `https://portal.mc.chitose.ac.jp`
- Cloudflare Access で Worker URL 全体を保護する前提のため、アプリコード内では追加認証を実装しない。
- KV の同一キー書き込み制限を避けるため、storageState はログイン成功時または状態更新時のみ保存し、不要な連続書き込みはしない。

## Test Plan
- `pnpm install` 後に `pnpm check` で型チェックする。
- `wrangler dev --remote` で実ブラウザ binding を使って確認する。
- `/health` が `{ ok: true }` を返すことを確認する。
- 各 `/api/*` が既存と同じ JSON 形状を返すことを確認する。
- KV に storageState がない初回アクセスでログインし、2回目以降はKVの状態を使えることを確認する。
- `filter` に不正値を渡した場合、既存同様 `400` を返すことを確認する。
- Cloudflare Access 有効化後、未認証アクセスが Access により遮断されることを確認する。

## Assumptions
- Cloudflare Browser Run / Browser Rendering の browser binding を使えるアカウントで運用する。
- Free plan のブラウザ利用枠は小さいため、継続運用では Workers Paid への移行を想定する。
- ローカルで通常の Playwright/Chromium を起動する開発体験は捨て、Cloudflare remote dev を正式な確認環境にする。
- 参考仕様は Cloudflare 公式の Browser Run Playwright、Workers limits、KV limits に従う。
