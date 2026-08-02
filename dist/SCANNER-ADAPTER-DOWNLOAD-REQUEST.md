# 一括ダウンロード＋マージ CSV アダプタ 実装依頼テンプレート

検査ツールから脆弱性・資産データを一括取得する処理（`Invoke-MikkeScannerDownload`）と、
取得したファイルから**取込用のマージ CSV を生成する処理**（`Invoke-MikkeScannerMerge`）を、
お客様環境の担当者 / AI に実装してもらうための**依頼文テンプレート**です。

- 実装の正となる仕様は同梱の **`SCANNER-ADAPTER-SPEC.md` の §9（取得）と §10（マージ CSV）**。この依頼文はその要約＋作業指示です。
- 併せて雛形 **`mikke-scanner-adapter.example.ps1`**（`Invoke-MikkeScannerDownload` の骨組み入り）を渡してください。
- 検査ツール固有の API 仕様（エンドポイント・認証）は**お客様環境でしか確認できない**ため、
  末尾の「この環境で確認して埋める点」を残しています。実エンドポイントが分かっていれば、その部分を具体値に置き換えて渡すと一発で仕上がります。

---

## 渡すファイル（relay と同じフォルダにある配布物）

1. `SCANNER-ADAPTER-SPEC.md`（**§9 取得** と **§10 マージ CSV** が対象）
2. `mikke-scanner-adapter.example.ps1`（雛形。2 関数の骨組み入り）
3. `sample-import-template.csv`（生成する CSV の列構成の見本）

---

## 依頼文（このブロックをそのまま貼り付け）

```
Mikke の中継サーバ用アダプタに「一括ダウンロード関数」と「マージCSV生成関数」の
2つを実装してください。

【参照仕様（必読・唯一の正）】
同梱の SCANNER-ADAPTER-SPEC.md の「§9 一括ダウンロード」と「§10 マージCSVの生成」。
契約・入出力・テスト方法・チェックリストはすべてここに従うこと。雛形は
mikke-scanner-adapter.example.ps1 の Invoke-MikkeScannerDownload /
Invoke-MikkeScannerMerge。

【全体の流れ（一括更新ボタン）】
① 既存エンドポイント /mikke/download で全レポート（脆弱性＋資産各種）を取得
② 新エンドポイント /mikke/merge が、①でダウンロード済みのファイルを入力に
   「脆弱性＋資産をマージしたCSV」を1枚生成
③ Mikke がそのCSVを、通常のCSV取込と同じ処理で取り込む

【成果物】
- ファイル: mikke-scanner-adapter.ps1（既存があれば、その中に関数を追記）
- 追加する関数は次の2つのみ（既存の Invoke-MikkeScannerFetch は変更しない）
  1) Invoke-MikkeScannerDownload -Types <string[]>
  2) Invoke-MikkeScannerMerge   -Files <object[]>
- relay 本体（mikke-relay.ps1 / *.bat）は編集しない（自動更新で上書きされる）

【関数1: Invoke-MikkeScannerDownload の仕様（§9-2 の要約）】
- 入力 $Types は 'vuln','ip','iprange','domain','cert','webapps' の部分集合
- 各種別について、検査ツールからその一覧をエクスポート取得し、
  ファイル内容を Base64 にして返す
- 戻り値は @{ items = @( @{ type; fileName; contentBase64;
  scannerDownloadTime; itemCount } , ... ) }
  ・contentBase64 = ファイルのバイト列を [Convert]::ToBase64String(...) したもの
    （CSV でも xlsx でも可。バイナリは Invoke-WebRequest の .Content を使う）
  ・取得できた種別だけ返す（0件の種別は要素を省略、全体が空なら items=@()）
  ・scannerDownloadTime / itemCount は任意
- ファイルは検査ツールのエクスポート原本のまま返してよい（zip/CSV/xlsx 可）。
  SharePoint 保存はブラウザ側が行う。アダプタは SP を触らない（取得の中継のみ）
- 並列化は relay 側で実施（種別ごとに並列で本関数が呼ばれる）。アダプタは 1 種別分だけを
  素直に実装すればよく、自前の並列化は不要。関数内で完結させ、共有状態を持たないこと

【関数2: Invoke-MikkeScannerMerge の仕様（§10 の要約）】
- 入力 $Files は ①でダウンロード済みのファイル群。各要素は
  @{ type; fileName; contentBase64 }（type = vuln/ip/iprange/domain/cert/webapps）
  → 検査ツールに再アクセスしないこと（二重ダウンロード禁止）
- 処理: contentBase64 をデコード（zipなら展開して中のCSVを取得）し、脆弱性を主表に、
  資産レポートを資産キー（FQDN/IP等）で突合して列を付加し、CSVを1枚生成する
- 戻り値: @{ fileName='merged_YYYYMMDD_HHMMSS.csv'; contentBase64=<CSVのBase64>;
  rowCount=<int> }
- ★ 生成するCSVは「Mikkeの通常のCSV取込メニューで取り込むCSVと同じ形式」にすること。
  必須列（この名前ちょうど・1行目がヘッダ）:
    Issue Instance ID（突合キー・一意・必須） / Title / Severity / Status /
    First Seen / Last Seen
  資産情報の列は自由に追加してよい（Asset, FQDN, IP, Asset Type, Owner 等）。
  追加列はMikke側で Scan_<列名> として保持され、一覧の表示列や詳細画面で参照できる。
  （資産をマージする目的はこの追加列なので、必要な資産属性は遠慮なく足すこと）
- 1脆弱性=1行。複数資産が紐づく場合は | 区切りで1セルにまとめてよい
- 文字コードUTF-8（BOM付き推奨）、RFC4180のクォート（ConvertTo-Csv を使えば自動）
- 見本: 同梱の sample-import-template.csv が取込CSVの列構成の実例

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

【テスト（§9-3 / §10-5）】
1) 単体(取得): . .\mikke-scanner-adapter.ps1;
   $f = (Invoke-MikkeScannerDownload -Types @('vuln','ip')).items; $f | %{ $_.type+' '+$_.fileName }
2) 単体(マージ): $r = Invoke-MikkeScannerMerge -Files $f; $r.fileName; $r.rowCount
   [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($r.contentBase64)) |
     Select-Object -First 3
   → 1行目が「Issue Instance ID,Title,Severity,...」のヘッダになっていること
3) relay 経由: POST http://127.0.0.1:18080/mikke/download body {"types":["vuln","ip"]}
   → ok:true と items、relay に [download] vuln,ip -> N file(s)
   続けて POST http://127.0.0.1:18080/mikke/merge body {"files":[...①の結果...]}
   → ok:true と fileName/contentBase64、relay に [merge] N file(s) -> ....csv (M rows)
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
