# Mikke 検査ツール API アダプタ実装仕様

**成果物: `mikke-scanner-adapter.ps1`（PowerShell スクリプト 1 ファイル）**

この文書は、脆弱性管理ツール Mikke の中継サーバ（relay）が呼び出す「検査ツール API アダプタ」の実装仕様である。この仕様に沿って、検査ツール（ASM）の API から Issue 1 件の最新ステータスを取得して返すスクリプトを実装してほしい。API の具体的な仕様（エンドポイント・認証・レスポンス形式）は実装側の環境で確認できるものを使用する。

---

## 1. 全体像（どこで呼ばれるか）

```
[ブラウザ UI]  詳細画面の「最新状態を取得」ボタン
   │  POST http://127.0.0.1:18080/mikke/issue   body: {"issueInstanceId":"<ID>"}
   ▼
[mikke-relay.ps1]  ローカル中継サーバ（HttpListener / 編集禁止・自動更新で管理）
   │  毎リクエスト  . mikke-scanner-adapter.ps1  を dot-source し、
   │  Invoke-MikkeScannerFetch -IssueInstanceId <ID>  を呼ぶ
   ▼
[mikke-scanner-adapter.ps1]  ★今回実装するファイル
   │  検査ツール API を呼び、結果を正規化して hashtable で返す
   ▼
[検査ツール API]
```

- relay が受けた結果は JSON でブラウザへ返り、SharePoint リストの該当 Issue が更新される。
- **relay 本体（mikke-relay.ps1 / *.bat）は編集しないこと**。自動更新で上書きされる。アダプタはこのファイル 1 つで完結させる。

## 2. 成果物の要件

| 項目 | 要件 |
| --- | --- |
| ファイル名 | `mikke-scanner-adapter.ps1`（固定） |
| 置き場所 | `mikke-relay.ps1` と同じフォルダ |
| エンコーディング | **UTF-8（BOM 付き）**。BOM が無いと PowerShell 5.1 で日本語が文字化けする |
| 実行環境 | **Windows PowerShell 5.1**（Windows 標準。PowerShell 7 ではない） |
| 依存 | 追加モジュール禁止。標準の `Invoke-RestMethod` / `Invoke-WebRequest` / .NET クラスのみ |
| 配布 | git 等のリポジトリに**置かない**（API の固有情報を含むため）。実装環境内でのみ管理 |

### PowerShell 5.1 互換の禁止構文（重要）

以下は PS7 専用のため**使用禁止**（5.1 で構文エラーになる）:

- `?.`（null 条件演算子） / `??`（null 合体） / 三項演算子 `a ? b : c`
- `ConvertFrom-Json -AsHashtable`
- `&&` / `||` によるコマンド連結

また HTTPS API を呼ぶ場合、5.1 は既定で TLS 1.2 が無効なことがあるため、関数内の先頭で次を実行すること:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
```

## 3. 契約（インターフェース — 変更不可）

### 3-1. 定義する関数

スクリプトのトップレベルには**関数定義のみ**を書く（毎リクエスト dot-source されるため、トップレベルに副作用のある処理を書くと毎回実行される）。

```powershell
function Invoke-MikkeScannerFetch {
    param([Parameter(Mandatory = $true)][string]$IssueInstanceId)
    # ...実装...
    return @{ ... }   # 下記スキーマの hashtable
}
```

### 3-2. 入力

| パラメータ | 型 | 説明 |
| --- | --- | --- |
| `IssueInstanceId` | string | 検査ツールの Issue Instance ID（CSV の「Issue Instance ID」列と同じ値） |

### 3-3. 戻り値（hashtable）

```powershell
@{
    scannerStatus = '<string>'   # 検査ツール側の最新ステータス (例: open / fixed / ...)
    severity      = '<string>'   # 深刻度 (例: Critical / High / ...)
    lastSeen      = '<string>'   # 最終検出日時。ISO 8601 推奨 (例: 2026-06-10T12:34:56)
    detected      = $true        # 任意。現在も検出されているか (bool)。下記参照
    scanFields    = @{           # 任意。省略可 (省略時は @{} 扱い)
        '<CSV列名>' = '<string値>'
    }
}
```

- **`detected`（任意・重要）**: この Issue が**現在も検出されている状態か**を bool で返す。
  API のステータス値（例: open/active → `$true`、resolved/fixed/closed → `$false`）から**アダプタが正規化**する。
  返すと Mikke 側が検知ステータス（新規/継続/再検知/未検出）を自動で遷移させる。
  判定できない場合は**キー自体を省略**する（Mikke は検知ステータスを変更しない）。
- `detected` 以外はすべて**文字列**で返す（数値・日付も文字列化する）。
- `scanFields` のキーは**検査ツール CSV のヘッダ列名そのまま**（例: `Status`、`First Seen`）。`Scan_` 接頭辞は付けない。
  - Mikke 側で管理項目（F6）にチェックされている列だけが SharePoint に反映される。それ以外のキーは無視される（エラーにはならない）。
- 該当データが無い項目は空文字 `''` でよい。

### 3-4. エラー

**`throw` で投げる**。relay が catch して HTTP 502 + メッセージとして UI のトーストに表示する。利用者が読んで原因が分かるメッセージにすること。区別して投げてほしいケース:

| ケース | throw メッセージの例 |
| --- | --- |
| 設定不足 | `'MIKKE_SCANNER_API_BASE が未設定です (mikke-relay.env に設定してください)'` |
| 認証失敗 | `'検査ツール API の認証に失敗しました (API キーを確認してください)'` |
| 該当 ID なし | `'Issue が見つかりません: <ID>'` |
| タイムアウト/接続不可 | `'検査ツール API に接続できません: <理由>'` |

タイムアウトは `Invoke-RestMethod -TimeoutSec 30` 程度を設定すること（無限待ちにしない）。

## 4. 設定値の受け渡し

接続先 URL・API キー等の**固有情報はスクリプトに直書きしない**。relay が起動時に読み込む `mikke-relay.env`（`KEY=VALUE` 形式、同フォルダ）に置き、アダプタからは**環境変数**で参照する:

```powershell
$apiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE')
$apiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY')
```

| 環境変数 | 用途 |
| --- | --- |
| `MIKKE_SCANNER_API_BASE` | API のベース URL（例: `https://scanner.example.com/api/v1`） |
| `MIKKE_SCANNER_API_KEY` | API キー / トークン |

追加の設定が必要な場合は `MIKKE_SCANNER_` 接頭辞で `mikke-relay.env` に追加してよい（relay が全キーを環境変数として読み込む）。**env を変更した場合のみ relay の再起動が必要**（アダプタ本体の変更は再起動不要）。

## 5. 動作上の前提

- **ホットリロード**: relay は毎リクエスト dot-source するため、アダプタを保存すれば次の呼び出しから反映される（relay 再起動不要）。
- **呼び出し頻度**: 詳細画面でユーザが 1 件ずつ手動実行する想定（低頻度・単発）。一括同期は別機能なので考慮不要。
### 5-1. 診断ログ規約（必須）

`Write-Host` の出力は relay のコンソールにそのまま出る。失敗時の原因特定のため、以下を**必ず**実装すること:

1. **API 呼び出しの直前**に、リクエストの URL（メソッド付き）をログする。
   `Write-Host "[adapter] GET $url"`（**Authorization 等の秘密はログに出さない**）
2. **失敗時**に、HTTP ステータスコードと**応答ボディ（先頭 500 文字）**をログする。
   404 や 400 の「理由」（ID 形式違い・エンドポイント違い等）は応答ボディに入っていることが多く、これが無いと原因を特定できない。
   - PS5.1 での取り出し方: まず `$_.ErrorDetails.Message`、無ければ `$_.Exception.Response.GetResponseStream()` を StreamReader で読む（§6 の雛形参照）。
3. **throw メッセージに HTTP ステータスを含める**（例: `"Issue が見つかりません (HTTP 404): <ID> / API応答: <body抜粋>"`）。このメッセージはそのまま UI のトーストに表示される。

なお relay 本体も例外の型・発生箇所（アダプタの行番号）・スタックをコンソールに出すが、アダプタ内で元の例外を catch して文字列を throw し直すと HTTP 詳細は relay 側では取れない。**HTTP の詳細ログはアダプタの責務**。
- relay 側のエンドポイント仕様（参考。アダプタ実装には直接関係しない）:
  - `POST /mikke/issue`、入力 `{"issueInstanceId": "<ID>"}`
  - 成功: `200 {"ok":true, "scannerStatus":..., "severity":..., "lastSeen":..., "detected":..., "scanFields":{...}}`
  - 失敗: `400`(ID なし) / `501`(アダプタ未配置) / `500`(関数未定義) / `502`(アダプタが throw)

## 6. 実装の雛形

同梱の `mikke-scanner-adapter.example.ps1` をコピーして実装する。骨組み:

```powershell
# mikke-scanner-adapter.ps1 — 検査ツール API アダプタ (この環境専用・リポジトリに置かない)
# 保存: UTF-8 (BOM 付き) / Windows PowerShell 5.1 互換

function Invoke-MikkeScannerFetch {
    param([Parameter(Mandatory = $true)][string]$IssueInstanceId)

    # TLS 1.2 (PS5.1 対策)
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # 設定 (mikke-relay.env 由来の環境変数)
    $apiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE')
    $apiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY')
    if (-not $apiBase) { throw 'MIKKE_SCANNER_API_BASE が未設定です (mikke-relay.env に設定してください)' }

    # ── API 呼び出し (実際のエンドポイント/認証方式に合わせて実装) ──
    $headers = @{ Authorization = "Bearer $apiKey" }
    $url = "$apiBase/issues/$([uri]::EscapeDataString($IssueInstanceId))"
    Write-Host "[adapter] GET $url" -ForegroundColor DarkGray    # 診断ログ §5-1 (秘密は出さない)
    try {
        $r = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec 30
    } catch {
        # 診断ログ §5-1: HTTP status と応答ボディ (先頭500文字) を必ず出す。
        # 404/400 の「理由」は応答ボディに入っていることが多い。
        $status = $null
        if ($_.Exception.Response) { try { $status = [int]$_.Exception.Response.StatusCode } catch { } }
        $respBody = ''
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $respBody = $_.ErrorDetails.Message }
        elseif ($_.Exception.Response) {
            try {
                $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $respBody = $sr.ReadToEnd(); $sr.Close()
            } catch { }
        }
        if ($respBody.Length -gt 500) { $respBody = $respBody.Substring(0, 500) + '…' }
        Write-Host "[adapter] -> HTTP $status" -ForegroundColor Yellow
        if ($respBody) { Write-Host "[adapter] response: $respBody" -ForegroundColor Yellow }

        if ($status -eq 401 -or $status -eq 403) { throw "検査ツール API の認証に失敗しました (HTTP $status)" }
        if ($status -eq 404) { throw "Issue が見つかりません (HTTP 404): $IssueInstanceId / API応答: $respBody" }
        throw "検査ツール API の呼び出しに失敗 (HTTP $status): $($_.Exception.Message)"
    }

    # ── 正規化して返す (フィールド名は実際のレスポンスに合わせる) ──
    return @{
        scannerStatus = [string]$r.status
        severity      = [string]$r.severity
        lastSeen      = [string]$r.last_seen
        # detected: 現在も検出されているか。API のステータス値から正規化する
        # (例: open/active → $true、resolved/fixed/closed → $false)。
        # 判定できない場合はキーごと省略 (Mikke は検知ステータスを変更しない)。
        detected      = ($r.status -in @('open', 'active'))
        scanFields    = @{
            'Status' = [string]$r.status
            # 必要に応じて CSV 列名 = 値 を追加
        }
    }
}
```

## 7. テスト方法

### 7-1. 単体（relay なし）

```powershell
powershell -NoProfile -Command ". .\mikke-scanner-adapter.ps1; Invoke-MikkeScannerFetch -IssueInstanceId '<実在するID>' | ConvertTo-Json"
```

→ §3-3 のスキーマの JSON が出れば OK。エラー系（存在しない ID 等）も throw メッセージを確認する。

### 7-2. relay 経由

relay（`mikke-launch.bat`）を起動した状態で:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:18080/mikke/issue' -Method Post `
  -ContentType 'application/json' -Body '{"issueInstanceId":"<実在するID>"}'
```

→ `ok: true` と正規化済みの値が返れば OK。relay のコンソールに `[issue] <ID> -> OK` が出る。

### 7-3. UI から

Mikke の詳細画面 →「最新状態を取得」→ 値が更新され「最新状態を取得しました」トーストが出れば完了。

## 8. チェックリスト

- [ ] ファイル名は `mikke-scanner-adapter.ps1`、relay と同じフォルダに配置
- [ ] UTF-8 (BOM 付き) で保存
- [ ] PowerShell **5.1** で動作（禁止構文なし / TLS 1.2 明示）
- [ ] トップレベルは関数定義のみ（副作用コードなし）
- [ ] 戻り値は §3-3 のスキーマ（すべて文字列値）
- [ ] エラーは利用者が読める日本語メッセージで throw / タイムアウト設定あり
- [ ] API キー・URL はスクリプトに直書きせず `mikke-relay.env` 参照
- [ ] 秘密情報をログ (`Write-Host`) に出していない
- [ ] §7 のテスト 3 段階がすべて通る

---

## 9. 一括ダウンロード（脆弱性 / 資産データ）

「ダウンロードデータ」画面の**取得**、および管理対象一覧の**一括更新（固定／追加モード）**で、検査ツールから脆弱性および登録資産情報（IP / IP Range / Domain / Cert / WebAPPS）を**一括取得**する。§1〜§8 の Issue 取得（`Invoke-MikkeScannerFetch`）と**同じ relay + アダプタ方式**。

> **実装する関数は 2 つ**: 本章の `Invoke-MikkeScannerDownload`（取得）と、**§10 の `Invoke-MikkeScannerMerge`（マージ CSV 生成）**。
> 一括更新は「①この章のエンドポイントで全レポートを取得 → ②§10 のエンドポイントでマージ CSV を生成 → ③その CSV を取り込む」という流れで動く。

### 9-1. 全体像（どこで呼ばれるか）

```
[ブラウザ UI]  「ダウンロードデータ」→「取得」→ 対象種別を選択
   │  POST http://127.0.0.1:18080/mikke/download   body: {"types":["vuln","ip",...]}
   ▼
[mikke-relay.ps1]  毎リクエスト mikke-scanner-adapter.ps1 を dot-source し、
   │               Invoke-MikkeScannerDownload -Types <string[]> を呼ぶ
   ▼
[mikke-scanner-adapter.ps1]  ★この関数を実装する
   │  検査ツールから各種別のエクスポートを取得し、Base64 で返す
   ▼
[検査ツール API]
```

- **役割分担**: アダプタは「検査ツールからデータを取得して Base64 で返す」中継のみ。
  **SharePoint ドキュメントライブラリへの保存・一覧記録はブラウザ側**（SP 認証を持つ）が行う。アダプタは SP を触らない。
- **並列ダウンロード（relay 側で実施）**: relay は要求された種別を **runspace プールで種別ごとに並列取得**する。
  つまり `Invoke-MikkeScannerDownload` は **1 種別ずつ・同時に複数回**呼ばれる（`-Types @('vuln')`, `-Types @('ip')`, … が並行）。
  - アダプタ側で**自前の並列化は不要**（1 呼び出し＝1 種別に集中して実装すればよい）。
  - 各呼び出しは**隔離された runspace** で独立に dot-source・実行されるため、関数内で
    グローバル変数やファイルを共有・書き換えると競合しうる。**関数内で完結**させる（共有状態を持たない）こと。
  - 診断ログ（`Write-Host`）は種別ごとに `[download:<種別>]` を前置して relay コンソールへ再出力される。
- ブラウザは**アダプタが返したファイルをそのまま（元のファイル名のまま・再 zip 化やリネームなし）**、設定で指定した SP フォルダの**日時サブフォルダ**（例: `Shared Documents/MikkeDownloads/20260704-153000/`）に保存し、1 ファイル＝1 行で一覧に記録する。検査ツールのエクスポートが既に zip なら、その zip がそのまま置かれる。

### 9-2. 契約（インターフェース — 変更不可）

```powershell
function Invoke-MikkeScannerDownload {
    param([Parameter(Mandatory = $true)][string[]]$Types)
    # ...実装...
    return @{ items = @( ... ) }
}
```

#### 入力

| パラメータ | 型 | 説明 |
| --- | --- | --- |
| `Types` | string[] | 取得する種別の配列。`vuln` / `ip` / `iprange` / `domain` / `cert` / `webapps` の**部分集合**（利用者がモーダルで選んだもの） |

種別の意味:

| 種別 | 内容 |
| --- | --- |
| `vuln` | 脆弱性一覧 |
| `ip` | 登録資産: IP |
| `iprange` | 登録資産: IP Range |
| `domain` | 登録資産: Domain |
| `cert` | 登録資産: Cert（証明書） |
| `webapps` | 登録資産: WebAPPS（Web アプリ） |

#### 戻り値（hashtable）

```powershell
@{
    items = @(
        @{
            type                = 'vuln'                 # 上記種別のいずれか
            fileName            = 'ips_export_2026_Jul_05.zip'  # 元ファイル名 (この名前のまま SP に保存される。zip/csv/xlsx いずれも可)
            contentBase64       = '<base64>'             # ファイル内容の Base64 (zip/CSV/xlsx 等バイナリ安全)
            scannerDownloadTime = '2026-07-04T15:29:00'  # 任意。検査ツール側のエクスポート日時 (ISO8601 推奨)
            itemCount           = 1234                   # 任意。件数 (一覧の参考表示に使う)
        }
        # 種別ごとに 1 要素が基本。1 種別で複数ファイルがあれば同 type を複数要素で返してよい
        # (それぞれ元の名前のまま保存され、1 ファイル＝1 行で記録される)。
    )
}
```

- `contentBase64` は**ファイルのバイト列を Base64 化**したもの。CSV でも Excel(.xlsx) でも可。バイナリで受けるなら `Invoke-WebRequest` の `.Content`（byte[]）を `[Convert]::ToBase64String(...)` する。文字列（CSV テキスト）なら `[System.Text.Encoding]::UTF8.GetBytes($csv)` を Base64 化する。
- ここで返すファイルは**検査ツールのエクスポート原本のまま**でよい（zip / CSV / xlsx いずれも可）。
  取込に使う CSV は §10 の `Invoke-MikkeScannerMerge` が**このファイル群を入力として**生成するので、
  この段階で形式を揃える必要はない。ただし**§10 のマージ関数が読める形式**であること（自作の関数同士なので、
  例えば「vuln は zip 内 CSV」と決めておけばよい）。
- **要求された `Types` のうち取得できたものだけ**返せばよい（0 件の種別は要素を省略。全体が空なら `items = @()`）。
- `scannerDownloadTime` / `itemCount` は任意（省略可）。`scannerDownloadTime` は一覧の「検査ツールDL時間」列に表示される。

#### エラー

§3-4 と同じ。**`throw` で投げる**（relay が 502 + メッセージで UI のトーストに表示）。タイムアウトは長め（例: `-TimeoutSec 120`）に。診断ログ規約（§5-1）も同じ。

### 9-3. テスト方法

単体（relay なし）:

```powershell
powershell -NoProfile -Command ". .\mikke-scanner-adapter.ps1; (Invoke-MikkeScannerDownload -Types @('vuln','ip')).items | ForEach-Object { $_.type + ' ' + $_.fileName + ' (' + $_.contentBase64.Length + ' b64chars)' }"
```

relay 経由:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:18080/mikke/download' -Method Post `
  -ContentType 'application/json' -Body '{"types":["vuln","ip"]}'
```

→ `ok: true` と `items`（各要素に type / fileName / contentBase64）が返れば OK。relay コンソールに `[download] vuln,ip -> N file(s)` が出る。

### 9-4. チェックリスト（追加分）

- [ ] `Invoke-MikkeScannerDownload -Types <string[]>` を定義（既存の Fetch 関数と同じファイルに追記）
- [ ] 戻り値は §9-2 のスキーマ（`items` 配列。`contentBase64` は Base64）
- [ ] 6 種別（vuln/ip/iprange/domain/cert/webapps）のうち、環境で取得できるものをマッピング
- [ ] エラーは日本語メッセージで throw / タイムアウト設定あり / 秘密をログに出さない

---

## 10. マージ CSV の生成（脆弱性＋資産 → 取込用 CSV 1 枚）

管理対象一覧の**一括更新（固定／追加モード）**は、§9 で取得したファイル群を入力に、**脆弱性情報と資産情報を突合（マージ）した CSV を 1 枚**作り、それを Mikke に取り込む。この CSV を作るのが `Invoke-MikkeScannerMerge`。

### 10-1. 全体像（一括更新の流れ）

```
[ブラウザ UI]  管理対象一覧 →「一括更新(固定)」/「一括更新(追加)」
   │
   │ ① POST /mikke/download  {"types":["vuln","ip","iprange","domain","cert","webapps"]}
   │    → 全レポートを取得。原本はそのまま SP に保存＋一覧に記録
   │
   │ ② POST /mikke/merge     {"files":[{type,fileName,contentBase64}, ...]}   ← ①の取得結果
   ▼
[mikke-relay.ps1]  mikke-scanner-adapter.ps1 を dot-source し、
   │               Invoke-MikkeScannerMerge -Files <object[]> を呼ぶ
   ▼
[mikke-scanner-adapter.ps1]  ★この関数を実装する
   │  脆弱性を主表に資産情報を突合し、取込用 CSV を 1 枚生成して Base64 で返す
   ▼
[ブラウザ]  ③ マージ CSV を SP に保存＋一覧に記録し、そのまま取り込む
            （固定／追加モードのステータス遷移を適用）
```

- **入力は「①でダウンロード済みのファイル」**。アダプタが検査ツールへ再アクセスする必要はない（二重ダウンロードしない）。
- マージ CSV も原本と同じ日時フォルダに保存され、ダウンロードデータ一覧に**タイプ「マージCSV」**として記録される。

### 10-2. 契約（インターフェース — 変更不可）

```powershell
function Invoke-MikkeScannerMerge {
    param([Parameter(Mandatory = $true)][object[]]$Files)
    # ...実装...
    return @{ fileName = '...'; contentBase64 = '...'; rowCount = 0 }
}
```

#### 入力

| パラメータ | 型 | 説明 |
| --- | --- | --- |
| `Files` | object[] | §9 で取得済みのファイル群。各要素は `type` / `fileName` / `contentBase64`（§9-2 の items と同じ形） |

各要素の `type` は `vuln` / `ip` / `iprange` / `domain` / `cert` / `webapps`。`contentBase64` は原本（zip / CSV / xlsx 等）の Base64。

#### 戻り値（hashtable）

```powershell
@{
    fileName      = 'merged_20260705_201500.csv'  # 生成した CSV のファイル名
    contentBase64 = '<base64>'                    # CSV 本体の Base64 (UTF-8。BOM 付き推奨)
    rowCount      = 1234                          # 任意。データ行数
}
```

### 10-3. ★ 生成する CSV の形式（最重要）

**「Mikke の通常の CSV 取込メニューで取り込む CSV」と同じ形式**にすること。一括更新はこの CSV を、手動取込とまったく同じロジックで処理する。

必須列（この名前ちょうどで、1 行目をヘッダにする）:

| 列名 | 説明 |
| --- | --- |
| `Issue Instance ID` | **突合キー（一意・必須）**。これが空の行はスキップされる |
| `Title` | 脆弱性名 |
| `Severity` | Critical / High / Medium / Low / Info |
| `Status` | 検査ツール側ステータス（open / resolved 等） |
| `First Seen` | 初回検出日 |
| `Last Seen` | 最終検出日 |

- **資産情報の列は自由に追加してよい**（例: `Asset` / `FQDN` / `IP` / `Asset Type` / `Owner` / `管理部門` …）。
  追加列は Mikke 側で `Scan_<列名>` として保持され、一覧の表示列（設定→管理項目の選択）や詳細画面で参照できる。
  **資産情報をマージする目的はまさにこの追加列**なので、必要な資産属性は遠慮なく列として足すこと。
- **1 脆弱性 = 1 行**。1 つの脆弱性に複数資産が紐づく場合は、`|` 区切りで 1 セルにまとめてよい
  （Mikke の資産管理は `|` 区切りを分解して個別資産として扱う）。
- 文字コードは **UTF-8**（BOM 付き推奨。Excel で開いても文字化けしない）。改行は CRLF / LF どちらでも可。
- 値にカンマ・改行・引用符を含む場合は **RFC4180 のダブルクォート**で囲む（`ConvertTo-Csv` を使えば自動）。

参考: 配布物に同梱の **`sample-import-template.csv`**（リポジトリでは `samples/template.csv`）が取込 CSV の見本（列構成の実例）。

### 10-4. エラー

§3-4 と同じく **`throw`**（relay が 502 + メッセージで UI のトーストに表示）。マージ対象の脆弱性ファイルが見つからない場合なども、利用者が読める日本語で throw すること（例: `'脆弱性レポートが入力に含まれていません'`）。

### 10-5. テスト方法

単体（relay なし）— ダミー入力で CSV が返ることを確認:

```powershell
. .\mikke-scanner-adapter.ps1
$files = (Invoke-MikkeScannerDownload -Types @('vuln','ip')).items
$r = Invoke-MikkeScannerMerge -Files $files
$r.fileName; $r.rowCount
[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($r.contentBase64)) | Select-Object -First 3
```

→ 1 行目がヘッダ（`Issue Instance ID,Title,Severity,...`）の CSV になっていれば OK。

relay 経由:

```powershell
$body = @{ files = @(@{ type='vuln'; fileName='v.zip'; contentBase64='<base64>' }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri 'http://127.0.0.1:18080/mikke/merge' -Method Post -ContentType 'application/json' -Body $body
```

→ `ok: true` と `fileName` / `contentBase64` が返れば OK。relay コンソールに `[merge] N file(s) -> merged_....csv (M rows)` が出る。

### 10-6. チェックリスト（追加分）

- [ ] `Invoke-MikkeScannerMerge -Files <object[]>` を定義（Fetch / Download と同じファイルに追記）
- [ ] 入力の `contentBase64` をデコードし、必要なら zip を展開して中の CSV を読む
- [ ] 脆弱性を主表に、資産レポートを資産キー（FQDN / IP 等）で突合して列を付加
- [ ] 出力 CSV に必須列（`Issue Instance ID` / `Title` / `Severity` / `Status` / `First Seen` / `Last Seen`）を含む
- [ ] 1 脆弱性 = 1 行 / UTF-8 / RFC4180 クォート
- [ ] エラーは日本語メッセージで throw / 秘密をログに出さない
