# Mikke 検査ツール API アダプタ実装仕様

**成果物: `mikke-scanner-adapter.ps1`（PowerShell スクリプト 1 ファイル）**

この文書は、脆弱性管理ツール Mikke の中継サーバ（relay）が呼び出す「検査ツール API アダプタ」の実装仕様である。この仕様に沿って、検査ツール（ASM）の API から Issue 1 件の最新ステータスを取得して返すスクリプトを実装してほしい。API の具体的な仕様（エンドポイント・認証・レスポンス形式）は実装側の環境で確認できるものを使用する。

---

## 1. 全体像（どこで呼ばれるか）

```
[ブラウザ UI]  詳細画面の「最新状態を取得」ボタン
   │  API のベース URL / キーは 設定 → 個人設定 → 接続 → 検査ツール API で
   │  各自のブラウザに保存されている（この端末にのみ保存）
   │
   │  POST http://127.0.0.1:18120/mikke/issue
   │  body: {"issueInstanceId":"<ID>", "apiBase":"https://…", "apiKey":"…"}
   ▼
[mikke-relay.ps1]  ローカル中継サーバ（HttpListener / 編集禁止・自動更新で管理）
   │  毎リクエスト  . mikke-scanner-adapter.ps1  を dot-source し、
   │  Invoke-MikkeScannerFetch -IssueInstanceId <ID> -ApiBase <URL> -ApiKey <KEY>
   │  を呼ぶ（受け取った接続情報は保存しない・ログに出さない）
   ▼
[mikke-scanner-adapter.ps1]  ★今回実装するファイル
   │  渡された接続情報で検査ツール API を呼び、結果を正規化して hashtable で返す
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
    param(
        [Parameter(Mandatory = $true)][string]$IssueInstanceId,
        [string]$ApiBase,
        [string]$ApiKey
    )
    # ...実装...
    return @{ ... }   # 下記スキーマの hashtable
}
```

### 3-2. 入力

| パラメータ | 型 | 説明 |
| --- | --- | --- |
| `IssueInstanceId` | string | 検査ツールの Issue Instance ID（CSV の「Issue Instance ID」列と同じ値） |
| `ApiBase` | string | API のベース URL。ブラウザの設定から渡る（§4） |
| `ApiKey` | string | API キー / トークン。同上 |

`ApiBase` / `ApiKey` は **必須ではない引数**にしておくこと（`Mandatory` を付けない）。
渡ってこない場合の扱いは §4 を参照。

> relay は、アダプタがこの 2 つを**宣言しているときだけ**渡す（PowerShell は宣言の無い
> パラメータを渡すとエラーになるため、関数定義を見て判定している）。
> つまり、引数を足していない古いアダプタでも relay は壊れず、環境変数で動き続ける。

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
| 設定不足 | `'検査ツール API のベース URL が指定されていません (Mikke の 設定 → 個人設定 → 検査ツール API で設定してください)'` |
| 認証失敗 | `'検査ツール API の認証に失敗しました (API キーを確認してください)'` |
| 該当 ID なし | `'Issue が見つかりません: <ID>'` |
| タイムアウト/接続不可 | `'検査ツール API に接続できません: <理由>'` |

タイムアウトは `Invoke-RestMethod -TimeoutSec 30` 程度を設定すること（無限待ちにしない）。

## 4. 接続情報（ベース URL / API キー）の受け渡し

### 4-1. 原則: **引数で受け取る**

接続先 URL・API キー等の**固有情報はスクリプトにもファイルにも書かない**。
利用者が Mikke の画面（**設定 → 個人設定 → 接続 → 検査ツール API**）に入力した値が、
**実行のたびにリクエストの引数として** relay 経由でアダプタに渡る。

```powershell
function Invoke-MikkeScannerFetch {
    param(
        [Parameter(Mandatory = $true)][string]$IssueInstanceId,
        [string]$ApiBase,
        [string]$ApiKey
    )
    # 引数を優先し、無ければ環境変数にフォールバック (§4-2)
    if (-not $ApiBase) { $ApiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE') }
    if (-not $ApiKey)  { $ApiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY') }
    if (-not $ApiBase) { throw '検査ツール API のベース URL が指定されていません (Mikke の 設定 → 個人設定 → 検査ツール API で設定してください)' }
    if (-not $ApiKey)  { throw '検査ツール API のキーが指定されていません (Mikke の 設定 → 個人設定 → 検査ツール API で設定してください)' }
    # 以降は $ApiBase / $ApiKey を使う
}
```

**なぜこうするか**: API キーをファイル（`mikke-relay.env`）に置くと、配布物・バックアップ・
リポジトリに秘密情報が残る。ブラウザ（各自の端末）にだけ置き、使うときだけ渡す方式にしている。
値は `127.0.0.1` 宛の通信でのみ流れ、端末の外には出ない。

### 4-2. 環境変数はフォールバック

引数が来なかったときだけ、従来どおり `mikke-relay.env` の環境変数を見る。

| 環境変数 | 用途 |
| --- | --- |
| `MIKKE_SCANNER_API_BASE` | API のベース URL（例: `https://scanner.example.com/api/v1`） |
| `MIKKE_SCANNER_API_KEY` | API キー / トークン |

- 古いブラウザ（引数を送らない版）から呼ばれても動くようにするための保険。
- **通常は env に書かない運用**。書く場合も、その端末限りの一時的な設定として扱う。
- 追加の設定（プロキシ設定など、秘密でないもの）が必要なら `MIKKE_SCANNER_` 接頭辞で
  `mikke-relay.env` に追加してよい。**env を変更した場合のみ relay の再起動が必要**
  （アダプタ本体の変更は再起動不要）。

### 4-3. 秘密情報を残さない（必須）

- **ログに出さない**。`Write-Host` に `$ApiKey` を含めない。リクエスト body をまるごと
  出力しない。診断ログ規約（§5-1）に従うこと。
- **ファイルに保存しない**。トークンのキャッシュをファイルに書かない（§12-3 の競合問題にもなる）。
- **`$script:` / グローバル変数に入れない**。並列実行（§12）で別の呼び出しに混ざる。
  **関数のローカル変数だけで完結させる**。
- **エラーメッセージに含めない**。API のレスポンス本文をそのまま throw する実装は、
  キーが混ざっていないか確認する。

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
    param(
        [Parameter(Mandatory = $true)][string]$IssueInstanceId,
        [string]$ApiBase,
        [string]$ApiKey
    )

    # TLS 1.2 (PS5.1 対策)
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # 接続情報: 引数が正。無ければ env にフォールバック (§4)
    $apiBase = $ApiBase
    $apiKey  = $ApiKey
    if (-not $apiBase) { $apiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE') }
    if (-not $apiKey)  { $apiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY') }
    if (-not $apiBase) { throw '検査ツール API のベース URL が指定されていません (Mikke の 設定 → 個人設定 → 検査ツール API で設定してください)' }

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
Invoke-RestMethod -Uri 'http://127.0.0.1:18120/mikke/issue' -Method Post `
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
- [ ] API キー・URL はスクリプトにもファイルにも書かず、**引数 (`-ApiBase` / `-ApiKey`) で受け取る**
- [ ] 引数が無いときだけ環境変数にフォールバックしている（§4-2）
- [ ] 未設定時のエラーは §4-1 の文言（設定場所が分かる）で throw している
- [ ] 秘密情報をログ (`Write-Host`)・ファイル・`$script:` 変数に残していない
- [ ] §7 のテスト 3 段階がすべて通る

---

## 9. 一括ダウンロード（脆弱性 / 資産データ）

「ダウンロードデータ」画面の**取得**、および管理対象一覧の**一括更新（固定／追加モード）**で、検査ツールから脆弱性および登録資産情報（IP / IP Range / Domain / Cert / WebAPPS）を**一括取得**する。§1〜§8 の Issue 取得（`Invoke-MikkeScannerFetch`）と**同じ relay + アダプタ方式**。

> **実装する関数は 2 つ**: 本章の `Invoke-MikkeScannerDownload`（取得）と、**§10 の `Invoke-MikkeScannerMerge`（マージ CSV 生成）**。
> 一括更新は「①この章のエンドポイントで全レポートを取得 → ②§10 のエンドポイントでマージ CSV を生成 → ③その CSV を取り込む」という流れで動く。

### 9-1. 全体像（どこで呼ばれるか）

```
[ブラウザ UI]  「ダウンロードデータ」→「取得」→ 対象種別を選択
   │  POST http://127.0.0.1:18120/mikke/download   body: {"types":["vuln","ip",...]}
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
- **並列ダウンロード（relay 側で実施）**: relay は要求された種別を **runspace プールで種別ごとに並列取得**する（同時 **最大 6 件** = `$MIKKE_DOWNLOAD_MAX_PARALLEL`。全 6 種別を要求した場合は 6 件が同時に走る）。
  つまり `Invoke-MikkeScannerDownload` は **1 種別ずつ・同時に複数回**呼ばれる（`-Types @('vuln')`, `-Types @('ip')`, … が並行）。
  取得後の SharePoint への保存もブラウザ側で 6 並列で行う。同時実行時の注意点は §12-3 と共通。
  - アダプタ側で**自前の並列化は不要**（1 呼び出し＝1 種別に集中して実装すればよい）。
  - 各呼び出しは**隔離された runspace** で独立に dot-source・実行されるため、関数内で
    グローバル変数やファイルを共有・書き換えると競合しうる。**関数内で完結**させる（共有状態を持たない）こと。
  - 診断ログ（`Write-Host`）は種別ごとに `[download:<種別>]` を前置して relay コンソールへ再出力される。
- ブラウザは**アダプタが返したファイルをそのまま（元のファイル名のまま・再 zip 化やリネームなし）**、設定で指定した SP フォルダの**日時サブフォルダ**（例: `Shared Documents/MikkeDownloads/20260704-153000/`）に保存し、1 ファイル＝1 行で一覧に記録する。検査ツールのエクスポートが既に zip なら、その zip がそのまま置かれる。

### 9-2. 契約（インターフェース — 変更不可）

```powershell
function Invoke-MikkeScannerDownload {
    param(
        [Parameter(Mandatory = $true)][string[]]$Types,
        [string]$ApiBase,
        [string]$ApiKey
    )
    # ...実装...
    return @{ items = @( ... ) }
}
```

#### 入力

| パラメータ | 型 | 説明 |
| --- | --- | --- |
| `Types` | string[] | 取得する種別の配列。`vuln` / `ip` / `iprange` / `domain` / `cert` / `webapps` の**部分集合**（利用者がモーダルで選んだもの） |
| `ApiBase` / `ApiKey` | string | 接続情報。§4 と同じ扱い（引数が正・env はフォールバック） |

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
Invoke-RestMethod -Uri 'http://127.0.0.1:18120/mikke/download' -Method Post `
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

参考: 配布物に同梱の **`sample-import-template.csv`**（`dist/` にあります）が取込 CSV の見本（列構成の実例）。

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
Invoke-RestMethod -Uri 'http://127.0.0.1:18120/mikke/merge' -Method Post -ContentType 'application/json' -Body $body
```

→ `ok: true` と `fileName` / `contentBase64` が返れば OK。relay コンソールに `[merge] N file(s) -> merged_....csv (M rows)` が出る。

### 10-6. チェックリスト（追加分）

- [ ] `Invoke-MikkeScannerMerge -Files <object[]>` を定義（Fetch / Download と同じファイルに追記）
- [ ] 入力の `contentBase64` をデコードし、必要なら zip を展開して中の CSV を読む
- [ ] 脆弱性を主表に、資産レポートを資産キー（FQDN / IP 等）で突合して列を付加
- [ ] 出力 CSV に必須列（`Issue Instance ID` / `Title` / `Severity` / `Status` / `First Seen` / `Last Seen`）を含む
- [ ] 1 脆弱性 = 1 行 / UTF-8 / RFC4180 クォート
- [ ] エラーは日本語メッセージで throw / 秘密をログに出さない

---

## 11. 個別レポートの取得（脆弱性 1 件ごと）

管理対象一覧でチェックを入れて **「情報更新」** を押したとき、選択された脆弱性 **1 件につき 1 回**、検査ツールからその脆弱性のレポート（**PDF**）を取得する。取得したファイルは Mikke が SharePoint に保存し、一覧からリンクで開けるようにするほか、**資産管理者への連携用リストの該当アイテムに添付**する。

> **この章の関数は任意実装**です。定義しなければ relay が 501 を返し、Mikke は個別レポートの取得だけをスキップして情報更新を続けます（エラーにはなりません）。

### 11-1. 全体像（どこで呼ばれるか）

```
[ブラウザ UI]  管理対象一覧 → 行にチェック → 「情報更新」
   │  ① POST /mikke/issue         body: {"issueInstanceId":"IID-1001"}   … 既存 (§1〜§8)
   │  ② POST /mikke/issue-report  body: {"issueInstanceId":"IID-1001"}   … 本章
   ▼
[relay]  mikke-scanner-adapter.ps1 を dot-source し
         Invoke-MikkeScannerIssueReport -IssueInstanceId 'IID-1001' を呼ぶ
   ▼
[ブラウザ]  返ってきたファイルを
            (a) SharePoint ドキュメントライブラリに保存 → 一覧の「レポート」列からダウンロード
            (b) 連携用リストの同じ Issue Instance ID のアイテムに添付
```

選択件数分だけ呼ばれる。実際には §12 の `/mikke/issues` 経由で **最大 5 件並列** で呼ばれる（アダプタ側の並列安全性については §12 を参照）。1 件が失敗しても他の件と情報更新自体は続行する。

### 11-2. 契約（インターフェース — 変更不可）

| 項目 | 内容 |
|---|---|
| 関数名 | `Invoke-MikkeScannerIssueReport` |
| 入力 | `-IssueInstanceId <string>` `-ApiBase <string>` `-ApiKey <string>` |
| 戻り値 | hashtable（下記） |

```powershell
function Invoke-MikkeScannerIssueReport {
    param(
        [Parameter(Mandatory = $true)][string]$IssueInstanceId,
        [string]$ApiBase,
        [string]$ApiKey
    )
    # 接続情報の扱いは §4 と同じ
}
```

```powershell
@{
  fileName            = 'IID-1001_2026_Jul_05.pdf'  # 検査ツールが付けた名前のまま
  contentBase64       = '<Base64>'                  # ファイル本体
  scannerDownloadTime = '2026-07-05T09:00:00'       # 任意。ISO8601
}
```

- **`contentBase64` は必須**。空だと relay が 502 を返す。
- `fileName` を省略した場合は relay が `<IssueInstanceId>.pdf` を補う。
- 検査ツールからは **PDF** でダウンロードされる想定。**圧縮もリネームもしない**でそのまま返す（Mikke 側も再圧縮しない。拡張子から Content-Type を決めるので、zip / CSV 等で返しても壊れないが、**拡張子は必ず中身と合わせる**こと）。
- ファイル名は SharePoint の添付ファイル名になる。Mikke 側で英数字・`.` `_` `-` 以外は `_` に置換するので日本語名でも動くが、英数字を推奨。
- エラーは throw する（relay が 502 + メッセージで UI に返す）。診断ログ規約は §5-1 と同じ。

### 11-3. 実装の雛形

`mikke-scanner-adapter.example.ps1` の `Invoke-MikkeScannerIssueReport` を参照（Fetch / Download と同じファイルに実装する）。

```powershell
function Invoke-MikkeScannerIssueReport {
    param(
        [Parameter(Mandatory = $true)][string]$IssueInstanceId,
        [string]$ApiBase,
        [string]$ApiKey
    )

    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # 接続情報: 引数が正。無ければ env にフォールバック (§4)
    $apiBase = $ApiBase
    $apiKey  = $ApiKey
    if (-not $apiBase) { $apiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE') }
    if (-not $apiKey)  { $apiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY') }
    if (-not $apiBase) { throw '検査ツール API のベース URL が指定されていません (Mikke の 設定 → 個人設定 → 検査ツール API で設定してください)' }

    $url = "$apiBase/issues/$([uri]::EscapeDataString($IssueInstanceId))/report"
    $resp = Invoke-WebRequest -Uri $url -Headers @{ Authorization = "Bearer $apiKey" } `
                              -Method Get -TimeoutSec 120
    $bytes = $resp.Content
    if ($bytes -is [string]) { $bytes = [System.Text.Encoding]::UTF8.GetBytes($bytes) }

    # Content-Disposition があれば検査ツールが付けた名前をそのまま使う
    $name = "$IssueInstanceId.pdf"
    $cd = $resp.Headers['Content-Disposition']
    if ($cd -and $cd -match 'filename="?([^";]+)"?') { $name = $Matches[1] }

    return @{
        fileName            = $name
        contentBase64       = [Convert]::ToBase64String($bytes)
        scannerDownloadTime = (Get-Date).ToString('s')
    }
}
```

### 11-4. テスト方法

アダプタ単体:

```powershell
. .\mikke-scanner-adapter.ps1
$r = Invoke-MikkeScannerIssueReport -IssueInstanceId 'IID-1001'
$r.fileName
[Convert]::FromBase64String($r.contentBase64).Length   # バイト数が出れば OK
```

relay 経由:

```powershell
$body = @{ issueInstanceId = 'IID-1001' } | ConvertTo-Json
Invoke-RestMethod -Uri 'http://127.0.0.1:18120/mikke/issue-report' -Method Post -ContentType 'application/json' -Body $body
```

→ `ok: true` と `fileName` / `contentBase64` が返れば OK。relay コンソールに `[issue-report] IID-1001 -> ....pdf (N KB base64)` が出る。

### 11-5. チェックリスト（追加分）

- [ ] `Invoke-MikkeScannerIssueReport -IssueInstanceId <string>` を定義（Fetch / Download / Merge と同じファイルに追記）
- [ ] `contentBase64` を必ず返す（空なら 502 になる）
- [ ] 検査ツールが返したファイルを**再圧縮・リネームせず**そのまま返す
- [ ] `fileName` は英数字・`.` `_` `-` を推奨
- [ ] エラーは日本語メッセージで throw / 秘密をログに出さない

---

## 12. 情報更新の並列化（複数脆弱性の一括取得）

管理対象一覧で複数件にチェックを入れて「情報更新」を押したとき、**relay が 5 件ずつ並列で**アダプタを呼ぶ。

> **この章のためにアダプタへ追加実装するものはありません。**
> 呼ばれるのは §1〜§8 の `Invoke-MikkeScannerFetch` と §11 の `Invoke-MikkeScannerIssueReport` のままです。
> ただし **「同時に複数回呼ばれても壊れないこと」** という制約が加わります（12-3）。

### 12-1. なぜ relay 側で並列化するのか

relay の受付ループは `GetContext()` の逐次ループで、**1 リクエストずつしか処理しません**。そのためブラウザから `/mikke/issue` を 5 本同時に投げても listener で順番待ちになり、実質直列になります。

そこで `/mikke/download`（§9）と同じ **runspace プール方式**を使い、**relay の中で並列化**します。

```
[ブラウザ]  チェック 10 件 → 5 件ずつに分けて送信
   │  POST /mikke/issues  body: {"issueInstanceIds":["IID-1",...,"IID-5"],"includeReport":true}
   ▼
[relay]  runspace プール (最大 5) で 1 件 = 1 runspace
   │   ├ runspace1: adapter を dot-source → Fetch + IssueReport
   │   ├ runspace2: 〃
   │   … (最大 5 本同時)
   ▼
[ブラウザ]  返ってきた 5 件を SharePoint へ保存・添付（こちらも 5 並列）→ 次の 5 件へ
```

実測（1 件あたり Fetch 1 秒 + Report 1 秒のスタブ、10 件）: 直列なら 20 秒のところ **4.07 秒**。

### 12-2. 契約（エンドポイント）

| 項目 | 内容 |
|---|---|
| URL | `POST /mikke/issues` |
| 入力 | `{ "issueInstanceIds": ["IID-1","IID-2"], "includeReport": true, "apiBase": "https://…", "apiKey": "…" }` |
| 並列数 | relay 側 `$MIKKE_ISSUES_MAX_PARALLEL`（既定 **5**） |

出力:

```json
{ "ok": true, "items": [
  { "issueInstanceId": "IID-1", "ok": true,
    "scannerStatus": "open", "severity": "high", "lastSeen": "2026-08-02T00:00:00",
    "detected": true, "scanFields": { "Scan_Asset": "host1.example.com" },
    "report": { "fileName": "IID-1.pdf", "contentBase64": "…", "scannerDownloadTime": "…" } },
  { "issueInstanceId": "IID-2", "ok": false, "error": "404 Not Found" }
] }
```

- **1 件の失敗は他を巻き込まない**。失敗した件だけ `ok:false` + `error` で返る。**全件失敗したときだけ** 502。
- `includeReport: true` でもアダプタに `Invoke-MikkeScannerIssueReport` が無ければ、その件は `reportSkipped: true` を返すだけ（エラーにしない）。ブラウザは以降のリクエストでレポートを要求しなくなる。
- レポート取得だけが失敗した場合は `reportError` に理由が入り、**情報更新は成功扱い**（`ok: true`）。

### 12-3. アダプタ側の制約（重要）

**同じ関数が最大 5 本、同時に別々の runspace で実行されます。** 各 runspace は独立にアダプタを dot-source するため、変数は共有されませんが、**プロセス外の資源は共有されます**。以下に注意してください。

- **固定パスの一時ファイルを使わない**。`$env:TEMP\export.csv` のような固定名は 5 本が同じファイルを奪い合います。`[System.IO.Path]::GetRandomFileName()` や Issue Instance ID を混ぜた名前にしてください。
- **グローバル変数・`$script:` スコープに状態を持たない**。関数内で完結させてください。
  接続情報 (`$ApiBase` / `$ApiKey`) も同様です。**引数で受け取ってローカル変数だけで使う**こと。
  グローバルに持つと、別の利用者・別のリクエストの値が混ざります。
- **検査ツール API のレート制限に注意**。同時 5 リクエストが許容されない場合は、
  - アダプタ内で待つ（`Start-Sleep` 等）か、
  - relay の `$MIKKE_ISSUES_MAX_PARALLEL` を下げる（Mikke 側の `REFRESH_PARALLEL` も同じ値に合わせる）
  のどちらかで調整します。**どちらが必要かは検査ツール側の仕様次第なので、判明したら連絡してください。**
- **ログイン/トークン取得を毎回行う実装でも動きます**が、5 本が同時にログインしても問題ないか確認してください。トークンをファイルにキャッシュする実装は、上記の一時ファイルと同じ競合が起きます。
- 診断ログ（`Write-Host`）は件ごとに `[issues:<Issue Instance ID>]` を前置して relay コンソールへ再出力されます。

### 12-4. テスト方法

```powershell
$body = @{ issueInstanceIds = @('IID-1','IID-2','IID-3','IID-4','IID-5','IID-6')
           includeReport = $true } | ConvertTo-Json
Measure-Command {
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:18120/mikke/issues' -Method Post `
                         -ContentType 'application/json' -Body $body
  $r.items | Select-Object issueInstanceId, ok, error
}
```

確認する点:

- `items` が投げた件数ぶん返る（順序は問わない）
- 所要時間が **直列の総和より明確に短い**（6 件・1 件 2 秒なら 4 秒前後。12 秒なら並列化できていない）
- 1 件だけ存在しない ID を混ぜたとき、その件だけ `ok:false` で他は成功する
- relay コンソールに `[issues] 6 件 (並列 5) -> OK 5 / NG 1` が出る

### 12-5. チェックリスト（追加分）

- [ ] `Invoke-MikkeScannerFetch` / `Invoke-MikkeScannerIssueReport` が**同時 5 本の実行に耐える**（固定パスの一時ファイル・グローバル変数を使っていない）
- [ ] 検査ツール API のレート制限を確認し、超える場合は並列数の調整方針を連絡した
- [ ] 存在しない Issue Instance ID を渡したとき、その件だけ throw する（他の件を巻き込まない）
- [ ] 上記テストで所要時間が直列より短くなることを確認した
