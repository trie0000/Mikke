# 一括ダウンロードアダプタ 実装依頼テンプレート

検査ツールから脆弱性・資産データを一括取得する処理（`Invoke-MikkeScannerDownload`）を、
お客様環境の担当者 / AI に実装してもらうための**依頼文テンプレート**です。

- 実装の正となる仕様は同梱の **`SCANNER-ADAPTER-SPEC.md` の §9**。この依頼文はその要約＋作業指示です。
- 併せて雛形 **`mikke-scanner-adapter.example.ps1`**（`Invoke-MikkeScannerDownload` の骨組み入り）を渡してください。
- 検査ツール固有の API 仕様（エンドポイント・認証）は**お客様環境でしか確認できない**ため、
  末尾の「この環境で確認して埋める点」を残しています。実エンドポイントが分かっていれば、その部分を具体値に置き換えて渡すと一発で仕上がります。

---

## 渡すファイル（relay と同じフォルダにある配布物）

1. `SCANNER-ADAPTER-SPEC.md`（§9 が対象）
2. `mikke-scanner-adapter.example.ps1`（雛形）

---

## 依頼文（このブロックをそのまま貼り付け）

```
Mikke の中継サーバ用アダプタに「一括ダウンロード関数」を実装してください。

【参照仕様（必読・唯一の正）】
同梱の SCANNER-ADAPTER-SPEC.md の「§9 一括ダウンロード」。契約・入出力・
テスト方法・チェックリストはすべてここに従うこと。雛形は
mikke-scanner-adapter.example.ps1 の Invoke-MikkeScannerDownload。

【成果物】
- ファイル: mikke-scanner-adapter.ps1（既存があれば、その中に関数を追記）
- 追加する関数: Invoke-MikkeScannerDownload -Types <string[]> のみ
  （既存の Invoke-MikkeScannerFetch は変更しない）
- relay 本体（mikke-relay.ps1 / *.bat）は編集しない（自動更新で上書きされる）

【関数の仕様（§9-2 の要約）】
- 入力 $Types は 'vuln','ip','iprange','domain','cert','webapps' の部分集合
- 各種別について、検査ツールからその一覧をエクスポート取得し、
  ファイル内容を Base64 にして返す
- 戻り値は @{ items = @( @{ type; fileName; contentBase64;
  scannerDownloadTime; itemCount } , ... ) }
  ・contentBase64 = ファイルのバイト列を [Convert]::ToBase64String(...) したもの
    （CSV でも xlsx でも可。バイナリは Invoke-WebRequest の .Content を使う）
  ・取得できた種別だけ返す（0件の種別は要素を省略、全体が空なら items=@()）
  ・scannerDownloadTime / itemCount は任意
- zip 化・SharePoint 保存はブラウザ側が行う。アダプタは SP を触らない（取得の中継のみ）

【制約（必ず守る）】
- Windows PowerShell 5.1 互換（?. / ?? / 三項 ?: / ConvertFrom-Json -AsHashtable /
  && || は使わない）。HTTPS を呼ぶなら関数先頭で TLS1.2 を明示
- ファイルは UTF-8 (BOM 付き) で保存
- 接続先 URL・API キーはスクリプトに直書きせず mikke-relay.env の環境変数
  （MIKKE_SCANNER_API_BASE / MIKKE_SCANNER_API_KEY、必要なら MIKKE_SCANNER_ 接頭辞で追加）
- エラーは利用者が読める日本語メッセージで throw、タイムアウトを設定（例 -TimeoutSec 120）
- 診断ログ規約（§5-1）に従い、リクエスト URL をログ／失敗時は HTTP status と
  応答ボディ先頭500文字をログ。ただし Authorization 等の秘密はログに出さない

【この環境で確認して埋めてほしい点】
- 6種別それぞれの実エクスポート用エンドポイント／エクスポート形式（CSV/xlsx 等）
- 認証方式（Bearer トークン等）とレスポンスの取り出し方

【テスト（§9-3）】
1) 単体: . .\mikke-scanner-adapter.ps1;
   (Invoke-MikkeScannerDownload -Types @('vuln','ip')).items | %{ $_.type+' '+$_.fileName }
2) relay 経由: POST http://127.0.0.1:18080/mikke/download body {"types":["vuln","ip"]}
   → ok:true と items が返り、relay に [download] vuln,ip -> N file(s) が出れば完了
```

---

## 種別（`Types`）の対応表

| 種別キー | 内容 |
| --- | --- |
| `vuln` | 脆弱性一覧 |
| `ip` | 登録資産: IP |
| `iprange` | 登録資産: IP Range |
| `domain` | 登録資産: Domain |
| `cert` | 登録資産: Cert（証明書） |
| `webapps` | 登録資産: WebAPPS（Web アプリ） |

## 補足

- 既に「最新状態を取得」用のアダプタ（`Invoke-MikkeScannerFetch`）を実装済みなら、
  **同じ `mikke-scanner-adapter.ps1` に関数を 1 つ足すだけ**です。`mikke-relay.env` や relay の配置はそのまま流用できます。
- ブラウザ側（Mikke）が行う処理は「取得結果を種別ごとに zip 化 → SP ドキュメントライブラリの
  日時フォルダに保存 → 一覧に記録」です。アダプタは**検査ツールからの取得と Base64 返却のみ**を担当します。
