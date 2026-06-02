# Mikke（みっけ）

SharePoint 上で動く**脆弱性管理ツール**。脆弱性検査ツール（外部攻撃面管理 / ASM）の全件 CSV から「社内管理対象」だけを条件で選り分け、ステータスを継続トラッキングする。Spira と同じ **bookmarklet + PowerShell 中継サーバ + SharePoint リスト** 構成。

> 「見っけ（見つけた）」— 全件の脆弱性から管理対象を *みっけ* て選り分けるのが主機能。

## 特徴

- **ブックマークレット起動** → SharePoint ページに overlay UI を注入（`#mikke-root`）
- **2 軸ステータス**: 検知（新規 / 継続 / 再検知 / 未検出(New) / 未検出 — 取込が自動）＋ 対応（未通知 / 通知 / 対応中 / 対応済み / リスク受容 / 過検出 / 対象外 — 人が手動）
- **CSV 一括取込**（約2万件 / 100MB 想定 → PowerShell 中継サーバ側で解析）
- **AND/OR 条件エンジン** ＋ Issue Instance ID による個別指定
- **管理 DB は SharePoint リスト**（Graph API / 外部 SaaS 不要の M365 制約環境向け）
- **自動更新**: UI バンドルはローダがサイレント更新、relay スクリプトは self-update
- UI は Spira を踏襲、アクセントは淡いブルー。左上は「N」ブランドマーク

## 技術スタック

- TypeScript (Vanilla) + esbuild — フレームワーク非依存
- SharePoint REST API（同一オリジン Cookie 認証）
- PowerShell 中継サーバ（HttpListener、CSV 解析 / 検査ツール API 中継）

## 開発

```sh
npm install
npm run type-check      # 型チェック
npm run build           # 本番ビルド (dist/ 生成)
npm run dev             # esbuild watch + dev サーバ (http://localhost:5177)
```

dev は mock モードで起動する（`dev/index.html` が `?mock=1` を付与）。SharePoint なしで UI を検証できる。

### ビルド成果物（`dist/`）

| ファイル | 用途 |
| --- | --- |
| `mikke.bundle.js` / `version.txt` | UI 本体 + バージョン（SP ライブラリに配置） |
| `install-loader.html` | 利用者がブックマーク登録（推奨・自動更新対応） |
| `install.html` | バンドル埋込版（オフライン用） |
| `mikke-relay.ps1` ほか | ローカル中継サーバ一式 |
| `relay-version.txt` | relay 自動更新 manifest |

## ディレクトリ

```
src/
  main.ts            エントリ / overlay マウント
  state.ts           グローバル状態
  types.ts           ManagedIssue / DetectionStatus / MgmtStatus 等
  api/               repo(sp/mock 切替) / sp / mock / relay
  lib/               conditions(条件エンジン) / detection(検知遷移) / csv
  views/             shell / issueList / issueDetail / editModal / importView / settingsView
  styles/app.css     単一 CSS（トークン + コンポーネント）
scripts/             mikke-relay.ps1 / mikke-launch.* / env.example
samples/             テスト用 CSV サンプル（ダミーデータ）
```

## ステータス

Phase 0（スキャフォールド）完了。CSV 取込の本実装・SP 実環境テストは Phase 1。

## 注意

公開リポジトリだが、含まれるのはツールのソースコードと**ダミーの CSV サンプル**のみ。実際の脆弱性データ・組織情報・認証情報は一切含まない（API 認証情報は中継サーバの `.env` にのみ置き、gitignore 済み）。
