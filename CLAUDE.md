# Mikke — Claude Code instructions

> プロジェクトルートに置く開発指示。毎セッション自動で読まれる。

## プロジェクト概要

Mikke（みっけ）は SharePoint 上で動く**脆弱性管理ツール**。脆弱性検査ツール（ASM）の全件 CSV から「社内管理対象」を条件で選り分け、ステータスを継続トラッキングする。

- bookmarklet として起動 → `#mikke-root` に overlay 注入
- SharePoint REST API で SP リスト（ManagedIssues / Settings / ImportLog）を読み書き
- 大容量 CSV 解析・検査ツール API 中継は PowerShell 中継サーバ（localhost）が担う
- Graph API / 外部 SaaS は使えない M365 制約環境向け（Spira と同じ）

## 設計の正典

Notion のプロジェクト文書群（HUB / 機能設計書 / 技術設計書 / UI 設計書）が正典。
ローカルの設計起点は Spira（`/Users/a21/mytools/Spira`）— 構成・自動更新機構・UI を踏襲。

## 必ず守ること

- **クラス名はすべて `mikke-` prefix**、要素は `#mikke-root` 配下、`all: initial` で host CSS をシールド
- **デザイントークン経由のみ**（hex / px 直書き禁止、`var(--...)` を使う）
- アクセントは淡いブルー `--accent: #7b97c4`。Spira のモスグリーンから変更済み
- **box-shadow は warm/グレー系**（青系 shadow 禁止、青はアクセント面のみ）
- **左上ブランドは「N」マーク踏襲**（`brandMark()`、色は淡いブルー）— 作者識別
- **固有名詞（検査ツール製品名）を出さない** — UI・コード・ドキュメントでは「脆弱性検査ツール」と表記
- UI は「🎨 UI / デザインルール（全アプリ共通）」の反省点を踏まえる（ギリギリ余白禁止 / inline style 禁止 / layout shift 禁止 / トースト右上 / モーダル mousedown 起点クローズ / z-index 数値リテラル）

## データモデル（2 軸ステータス）

- **DetectionStatus（検知・取込が自動）**: 新規 / 継続 / 再検知 / 未検出(New) / 未検出
- **MgmtStatus（対応・人が手動）**: 未通知 / 通知 / 対応中 / 対応済み / リスク受容 / 過検出 / 対象外
- 突合キー = `Issue Instance ID`（CSV 列名そのまま）
- CSV から消えたら未検出化（物理削除しない）。再出現は「再検知」
- 検知遷移ロジックは `src/lib/detection.ts`

## 確定済みの方針

- CSV 解析は中継サーバ側（約2万件/100MB）。`/mikke/csv-parse`
- 同時編集は後勝ち（If-Match: *）
- F6 でチェックを外した列のデータは保持して非表示
- 条件変更は次回取込から適用（+「今すぐ再評価」ボタン）
- CSV 取込で社内管理項目は上書きしない

## ビルド

```sh
npm run type-check    # tsc --noEmit
npm run build         # dist/ 生成（loader / version.txt / install / relay manifest）
npm run dev           # watch + dev サーバ(:5177)、mock モード
```

build id は build.js が git SHA から生成し esbuild define で焼き込む（`__MIKKE_BUILD_ID__`）。

## ⚠️ PowerShell 互換（重要）

- 委託先 PC は **Windows PowerShell 5.1**（Windows 標準）。Spira relay が同環境で稼働実績あり。
- `mikke-relay.ps1` は **5.1 以上で動かす**（`#Requires -Version 5.1`）。**7 専用構文を使わない**：`?.` / `??` / 三項 `?:` / `ConvertFrom-Json -AsHashtable`。
- `.bat` は `powershell.exe`（=5.1）を呼ぶ。開発時の mac は `pwsh`(7) で検証してよいが、機能は 5.1 で動く範囲に限定。
- CSV/JSON の文字コード: 5.1 既定は CP932。CSV 読込時は `-Encoding` を明示、出力 JSON は UTF-8 で書く（Spira 踏襲）。

## 自動更新（Spira 同方式）

- UI: ローダが起動時に `version.txt` を見て最新 `mikke.bundle.js` を取得（サイレント）
- relay: UI が SP の `relay-version.txt` と比較 → `/mikke/relay/self-update` に POST → `.new` ステージ → `mikke-updater.bat` 生成 → relay 再起動
- relay スクリプトを編集したら `$MIKKE_RELAY_VERSION` を bump する

## 現状

Phase 0 スキャフォールド完了（起動・画面表示・型チェック・ビルド OK）。
F1〜F7 の本実装（特に CSV 取込の差分判定・$batch 書込）は Phase 1。
mock リポジトリ（`src/api/mock.ts`）で UI 検証可能。

## テスト

- `samples/` にダミー CSV（5月 / 6月）。差分テスト観点は `samples/README.md`
- mock 起動: `dev/index.html` または `dist/index.html?mock=1`
