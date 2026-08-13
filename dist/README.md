# Mikke 配布物

**Version:** UI = 0.0.1-ead7049+ (2026-08-13T11:40:15+09:00) / relay = v1.0.27

## SharePoint に置くファイル
- `mikke.bundle.js` … UI 本体 (ブラウザ実行)
- `version.txt` … UI バージョン (自動更新のキャッシュキー)
- `install-loader.html` … 利用者がブックマーク登録 (推奨)
- `relay-version.txt` … relay 自動更新 manifest

## ローカル中継サーバ (各自 PC)
- `mikke-relay.ps1` / `mikke-launch.ps1` / `mikke-launch.bat` / `mikke-relay.env`
- `mikke-launch.bat` を実行すると relay 起動 → SP サイトを開く

## 自動更新
- UI バンドルは起動時にローダが version.txt を見て最新を取得 (サイレント)。
- relay スクリプトは UI が SP の relay-version.txt と比較し、差があれば self-update を実行。
