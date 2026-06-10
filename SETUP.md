# Mikke 配置・運用手順

脆弱性管理ツール Mikke を SharePoint 上で使えるようにする手順。**管理者の初回配置**と**各利用者のセットアップ**に分かれる。

---

## 0. 前提

- 管理 DB を置く SharePoint サイト（例: `https://<tenant>.sharepoint.com/sites/<site>`）にアクセスできること
- 各利用者の PC は Windows（PowerShell 5.1 標準搭載）
- 脆弱性検査ツールから「脆弱性全件 CSV」をダウンロードできること

---

## 1. ビルド（開発者）

```sh
cd Mikke
npm install
npm run build      # dist/ に配布物を生成
```

`dist/` に以下が生成される（すべて配布物）:

| ファイル | 役割 | 配置先 |
| --- | --- | --- |
| `mikke.bundle.js` | UI 本体 | ★ SharePoint |
| `version.txt` | バージョン（自動更新キー） | ★ SharePoint |
| `install-loader.html` | ブックマーク登録ページ（推奨） | 配布（SP 任意） |
| `install.html` | バンドル埋込版（オフライン用） | 任意 |
| `mikke-relay.ps1` ほか | ローカル中継サーバ一式 | 各利用者 PC |
| `relay-version.txt` | relay 自動更新 manifest | ★ SharePoint |

---

## 2. SharePoint への配置（初回・管理者）

1. 対象サイトの **ドキュメント ライブラリ**（"ドキュメント" / Shared Documents）に **`Mikke` フォルダ**を作成。
2. `Mikke` フォルダに以下をアップロード:
   - `mikke.bundle.js`
   - `version.txt`
   - `relay-version.txt`
   - （任意）`install-loader.html`
3. SP リスト（`MikkeManagedIssues` / `MikkeSettings` / `MikkeImportLog`）は**初回起動時に自動作成**されるので手動作成は不要。

> 配置パスを変える場合は `MIKKE_BUNDLE_LIB` を指定してビルド:
> `MIKKE_BUNDLE_LIB="/SiteAssets/mikke" npm run build`

---

## 3. ブックマークレット登録（各利用者）

1. `install-loader.html` をブラウザで開く（SP に置いた場合はその URL、ローカル配布でも可）。
2. ページ上の **「Mikke」ボタンをブックマークバーにドラッグ**して登録。
3. 以降、対象 SharePoint サイトを開いた状態で **Mikke ブックマークをクリック**すると起動する。

- 起動時にローダが `version.txt` を見て最新バンドルを取得する（**サイレント自動更新**。再登録不要）。

---

## 4. 中継サーバのセットアップ（各利用者）

中継サーバは **CSV 取込のサーバ側解析**（大容量対応）と**検査ツール API 中継（F3）**に使う。

1. `mikke-relay.ps1` / `mikke-relay.bat` / `mikke-launch.ps1` / `mikke-launch.bat` を任意フォルダに置く。
2. `mikke-relay.env.example` を `mikke-relay.env` にコピーし、編集:
   ```
   MIKKE_SITE_URL=https://<tenant>.sharepoint.com/sites/<site>
   # 検査ツール API は社内確認後に設定（未設定でも CSV 取込は動く）
   # MIKKE_SCANNER_API_BASE=...
   # MIKKE_SCANNER_API_KEY=...
   ```
3. **`mikke-launch.bat` をダブルクリック** → relay 起動 → SP サイトが既定ブラウザで開く。

> 中継サーバを起動しなくても CSV 取込は動く（ブラウザ側でパース）。ただし大容量
> （約 2 万件 / 100MB）では中継サーバ側解析を推奨。

### 検査ツール API 連携 (F3) — アダプタの実装（委託先環境）

詳細画面の「最新状態を取得」は、中継サーバ経由で検査ツール API を呼ぶ。
**API 仕様は委託先環境でのみ確認できるため、実装は別ファイル（アダプタ）に分離**している。

1. `mikke-scanner-adapter.example.ps1` を **`mikke-scanner-adapter.ps1`** にコピー。
2. ファイル内の `Invoke-MikkeScannerFetch` に実 API 呼び出しを実装（契約はファイル冒頭のコメント参照）。
3. relay と同じフォルダに置く。**relay の再起動は不要**（毎リクエスト読み込まれる）。

- アダプタ実装版は **relay 自動更新の対象外・git 管理外**。委託先環境で自由に実装・更新してよい。
- **relay 本体（mikke-relay.ps1 / .bat）は直接編集しない**こと（自動更新で上書きされる）。
- 接続先・API キーは `mikke-relay.env`（`MIKKE_SCANNER_API_BASE` / `MIKKE_SCANNER_API_KEY`）に置き、アダプタからは環境変数で参照する。
- アダプタ未配置の間、「最新状態を取得」は「未配置」のエラーメッセージを返す（他機能には影響なし）。

### ⚠️ 中継サーバに関する注意

- **PowerShell 5.1 で動く**（Windows 標準）。`#Requires -Version 5.1`。
- SharePoint ページ（https）から relay（http://127.0.0.1）への直接アクセスが
  **CSP / Mixed Content でブロックされる環境がある**。その場合 Mikke は自動で
  ブラウザ側 CSV パースにフォールバックする（取込自体は動く）。中継サーバ側解析を
  必須にしたい場合は、社内のブラウザポリシー（CSP `connect-src` に loopback 許可）を要確認。

---

## 5. 使い方（運用フロー）

1. **初回起動**: ブックマークから起動 → サイト選択 → リスト自動作成。
2. **管理項目の選択（設定 → F6）**: 一度 CSV を取り込むと列候補が出る。一覧/詳細に出したい列をチェック。
3. **管理対象条件（設定 → F7）**: AND/OR 条件で自動管理対象を定義（例: `Severity = Critical`）。
4. **個別追加（設定）**: 条件に関係なく管理したい Issue Instance ID を登録。
5. **CSV 取込**: 毎月の全件 CSV を取込 → 差分プレビュー（追加/更新/未検出/スキップ）→ 確定。
   - 検知ステータスが自動更新（新規 → 継続 → 未検出(New) → 未検出 → 再検知）。
   - 対応ステータス（未通知/対応中/対応済み 等）は人が編集（取込では上書きされない）。
6. **一覧・詳細**: 管理対象を確認、編集モーダルで対応ステータス・担当・期限・メモを更新。

---

## 6. 更新（開発者）

- **UI 更新**: `npm run build` → `mikke.bundle.js` と `version.txt` を SP に再アップロード。
  利用者は次回起動時に自動取得（サイレント）。
- **relay 更新**: `mikke-relay.ps1` 等を編集したら `$MIKKE_RELAY_VERSION` を上げて
  `npm run build` → `relay-version.txt` と各 `.ps1`/`.bat` を SP に再アップロード。
  Mikke UI が差分を検知し、relay の self-update（`/mikke/relay/self-update`）で
  各 PC の relay が自動更新される。

---

## 7. トラブルシューティング

| 症状 | 原因・対処 |
| --- | --- |
| 「ここでは Mikke を起動できません」 | SharePoint サイト以外で起動した。対象サイトを開いてからクリック |
| 取込で「中継サーバ未起動」 | `mikke-launch.bat` を起動。または無視してブラウザ側解析（小規模なら可） |
| CSV 取込で一部行が反映されない | 動的列（Scan_*）未作成の可能性。設定 F6 で列をチェック → 保存 → 再取込 |
| 日本語が文字化け | CSV が CP932 でも自動判定する。出ない場合は UTF-8 で保存し直す |
| relay が起動しない | ポート競合（既定 18080）。`mikke-relay.bat -Port 18081` 等で変更 |
