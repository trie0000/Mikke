// Mikke build script — esbuild + dev server + bookmarklet loader generator
import * as esbuild from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');
const prod = !watch && !serve;

// SP のドキュメントライブラリ上のバンドル配置パス (ローダがサイト URL に連結)。
//   既定: <site>/Shared Documents/Mikke
const libPath = process.env.MIKKE_BUNDLE_LIB || '/Shared%20Documents/Mikke';
// テスト用: ローカル relay からバンドルを読む場合の絶対ベース。
const overrideBase = process.env.MIKKE_BUNDLE_BASE
  ? JSON.stringify(process.env.MIKKE_BUNDLE_BASE.replace(/\/+$/, ''))
  : '""';

// ── Build identity (cache-busting key / 表示用) ──
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let gitSha = 'nogit';
let gitDirty = '';
try {
  gitSha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) gitDirty = '+';
} catch { /* not a git repo */ }
// ビルド時刻は JST (+09:00) 表記。stableBuildId の比較は " (" より前の
// version-sha 部分のみなので、時刻表記の変更は更新検知に影響しない。
const buildTime = new Date(Date.now() + 9 * 3600_000).toISOString().replace(/\.\d+Z$/, '+09:00');
const buildId = `${pkg.version}-${gitSha}${gitDirty} (${buildTime})`;
console.log(`[build] id: ${buildId}`);

const buildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Mikke',
  outfile: 'dist/mikke.js',
  target: 'es2020',
  platform: 'browser',
  minify: prod,
  sourcemap: !prod,
  loader: { '.css': 'text' },
  define: {
    'process.env.NODE_ENV': prod ? '"production"' : '"development"',
    __MIKKE_BUILD_ID__: JSON.stringify(buildId),
    __MIKKE_BUILD_TIME__: JSON.stringify(buildTime),
    __MIKKE_BUILD_SHA__: JSON.stringify(gitSha + gitDirty),
    __MIKKE_VERSION__: JSON.stringify(pkg.version),
  },
  // @kenjiuno/msgreader (.msg 解析) が iconv-lite (→ safer-buffer → buffer +
  // string_decoder) を持ち込むが、現代の Unicode .msg では実呼びしないため、
  // Node 専用モジュールをブラウザ向け空スタブに差し替える。
  alias: {
    'iconv-lite':     path.resolve('src/lib/_browser-shims.ts'),
    'safer-buffer':   path.resolve('src/lib/_browser-shims.ts'),
    'buffer':         path.resolve('src/lib/_browser-shims.ts'),
    'string_decoder': path.resolve('src/lib/_browser-shims.ts'),
  },
  logLevel: 'info',
};

if (watch || serve) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('[esbuild] watching...');
  if (serve) {
    const port = 5177;
    http.createServer((req, res) => {
      let url = req.url.split('?')[0];
      if (url === '/') url = '/dev/index.html';
      const filePath = path.join(process.cwd(), url);
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
      const types = {
        '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.map': 'application/json; charset=utf-8',
      };
      res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'text/plain; charset=utf-8' });
      fs.createReadStream(filePath).pipe(res);
    }).listen(port, () => console.log(`[dev] http://localhost:${port}/`));
  }
} else {
  await esbuild.build(buildOptions);
  console.log('[esbuild] build complete');

  const js = fs.readFileSync('dist/mikke.js', 'utf8');
  const sizeKb = (s) => (fs.statSync(s).size / 1024).toFixed(1);

  // index.html: 単一ファイル (SP ライブラリに置いて直接開く用)
  fs.writeFileSync('dist/index.html',
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Mikke</title>` +
    `<style>html,body{margin:0;padding:0;background:#fafaf7}</style></head><body>` +
    `<script>${js}\n</script></body></html>`);
  console.log(`[html] dist/index.html: ${sizeKb('dist/index.html')} KB`);

  // install.html: バンドル丸ごと埋込型 (オフライン用)
  // ⚠ バンドルは esbuild の IIFE 形式 = `"use strict";var Mikke=(()=>{...})();`。
  //   これを生で javascript: URL にすると、末尾の `var Mikke=...`(完了値=empty)
  //   の手前にある "use strict"(ExpressionStatement) が完了値として残り、
  //   ブックマークレット実行時にページが "use strict" に置換される。
  //   ローダ同様 IIFE で包んで完了値を undefined にする (= 画面遷移しない)。
  const inlineHref = 'javascript:' + encodeURIComponent('(function(){' + js + '})();');
  fs.writeFileSync('dist/install.html', renderInstallHtml(inlineHref, true));
  console.log(`[install] dist/install.html: ${sizeKb('dist/install.html')} KB (bundle inlined)`);

  // ── ローダ型配布 (推奨) ──
  // minified バンドルを mikke.bundle.js としてコピー、version.txt に build id。
  fs.copyFileSync('dist/mikke.js', 'dist/mikke.bundle.js');
  fs.writeFileSync('dist/version.txt', buildId + '\n');

  // ローダ: 起動ページのサイト URL + libPath からベースを組み立て、version.txt を
  //   毎回 fetch して最新の mikke.bundle.js?v=<ver> を読み込む (サイレント自動更新)。
  //   ローカル dev (localStorage mikke.dev.bundle-source=local) は fetch+eval、
  //   SP 配信は <script src> (同一オリジン)。
  // ローダの base 解決:
  //   1) _spPageContextInfo.webServerRelativeUrl があれば使う
  //   2) 無ければ location.pathname の /sites/<x> or /teams/<x> から推定
  //      (モダン SP ページでは _spPageContextInfo が無いことがあるため必須)
  // bundle 読込は SP / ローカルとも fetch+eval に統一:
  //   SP は `mikke.bundle.js?v=` のクエリ付き .js を 404 にすることがあるため、
  //   クエリ無し URL を fetch してテキストを eval する (SP の CSP は unsafe-eval 可)。
  const loader =
    `(function(){var d=document,w=window;` +
    `function REL(){try{var c=w._spPageContextInfo;if(c&&c.webServerRelativeUrl)return c.webServerRelativeUrl.replace(/\\/$/,'');}catch(e){}` +
    `try{var m=location.pathname.match(/^(\\/(?:sites|teams)\\/[^/]+)/i);if(m)return m[1];}catch(e){}return '';}` +
    `function SP(){var r=REL();return r?r+${JSON.stringify(libPath)}:'';}` +
    `var sp=SP(),dev='';` +
    `try{if(w.localStorage&&localStorage.getItem('mikke.dev.bundle-source')==='local')dev=(localStorage.getItem('mikke.dev.local-base')||'http://127.0.0.1:18080/mikke').replace(/\\/+$/,'');}catch(e){}` +
    `var primary=dev||${overrideBase}||sp;var fb=(primary!==sp&&sp)?sp:'';var isLocal=!!dev;` +
    `if(!primary){alert('[Mikke] 起動できません: SharePoint サイト (/sites/<name>) 上で実行してください。');return;}` +
    `function fail(base,why){var msg='[Mikke] バンドル読込失敗: '+base+(why?' ('+why+')':'')+'\\nrelay 起動 / 配置 / CORS を確認してください。';if(isLocal){alert(msg);console.error(msg);}else{console.warn(msg);}}` +
    `function load(base){var o=d.getElementById('mikke-script');if(o)o.remove();` +
    `fetch(base+'/mikke.bundle.js',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();}).then(function(t){if(!t||t.length<1000)throw new Error('bundle too small ('+t.length+')');try{(0,eval)(t);}catch(e){fail(base,'eval: '+(e&&e.message||e));}}).catch(function(e){fail(base,e&&e.message||'fetch error');if(!isLocal&&fb){var x=fb;fb='';load(x);}});}` +
    `load(primary);})();`;
  fs.writeFileSync('dist/mikke.loader.js', loader);
  const loaderHref = 'javascript:' + encodeURIComponent(loader);
  fs.writeFileSync('dist/bookmarklet.txt', loaderHref);
  fs.writeFileSync('dist/install-loader.html', renderInstallHtml(loaderHref, false));
  console.log(`[loader] dist/mikke.bundle.js: ${sizeKb('dist/mikke.bundle.js')} KB / version.txt: "${buildId}"`);

  // ── relay 配布物 + 自動更新 manifest ──
  const relayFiles = [
    'mikke-relay.ps1', 'mikke-launch.ps1', 'mikke-relay.bat', 'mikke-launch.bat',
    'mikke-relay.env.example',
    // 検査ツール API アダプタの雛形。実装版 (mikke-scanner-adapter.ps1) は
    // 委託先環境で作成し、self-update 管理外・git 管理外 (固有情報を含むため)。
    'mikke-scanner-adapter.example.ps1',
  ];
  let relayVersion = '0.0.0';
  const relayPs1Path = 'scripts/mikke-relay.ps1';
  if (fs.existsSync(relayPs1Path)) {
    const relayPs1 = fs.readFileSync(relayPs1Path, 'utf8');
    const m = relayPs1.match(/\$MIKKE_RELAY_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (m) relayVersion = m[1];
    // 配布物を dist/ にコピー
    for (const f of relayFiles) {
      const src = path.join('scripts', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join('dist', f));
    }
    // relay-version.txt = self-update manifest (UI が SP の値と比較)
    // .example.* は配布はするが self-update の管理対象 (manifest) には含めない
    // (relay 側の許可リスト外ファイルを送ると self-update 全体が 400 になる)。
    // mikke.loader.js はビルド生成物 (上で dist/ に直接出力済み) なので scripts/ には無いが、
    // ランチャーが CDP 注入で読むため、self-update の配布対象に含める。
    const manifest = relayFiles
      .filter((f) => fs.existsSync(path.join('scripts', f)) && !f.includes('.example'))
      .concat(fs.existsSync('dist/mikke.loader.js') ? ['mikke.loader.js'] : []);
    // ★ manifest に relay の許可リスト外のファイルが入っていると、self-update は
    //   その 1 件で 400 になり **全ファイルが更新されない** (relay 側で即 return)。
    //   過去に mikke.loader.js を manifest だけに足して self-update が全滅したので、
    //   ここでビルドを止める。
    const allowMatch = relayPs1.match(/\$MIKKE_RELAY_MANAGED_FILES\s*=\s*@\(([\s\S]*?)\)/);
    const allowed = allowMatch
      ? [...allowMatch[1].matchAll(/'([^']+)'/g)].map((x) => x[1].toLowerCase())
      : [];
    const notAllowed = manifest.filter((f) => !allowed.includes(f.toLowerCase()));
    if (notAllowed.length) {
      throw new Error(
        `[relay] self-update の manifest に許可リスト外のファイルがあります: ${notAllowed.join(', ')}\n`
        + `        scripts/mikke-relay.ps1 の $MIKKE_RELAY_MANAGED_FILES に追加してください`
        + ` (このまま配布すると self-update が 400 で全滅します)`,
      );
    }
    fs.writeFileSync('dist/relay-version.txt',
      JSON.stringify({ version: relayVersion, buildTime, files: manifest }, null, 2) + '\n');
    console.log(`[relay] dist/relay-version.txt: v${relayVersion} (${manifest.length} files)`);
  } else {
    console.warn('[relay] WARN: scripts/mikke-relay.ps1 が無いので relay 配布物は出力しません');
  }

  // 委託先向けアダプタ実装仕様 (雛形 example.ps1 とセットで配布)
  if (fs.existsSync('SCANNER-ADAPTER-SPEC.md')) {
    fs.copyFileSync('SCANNER-ADAPTER-SPEC.md', 'dist/SCANNER-ADAPTER-SPEC.md');
  }
  // 一括ダウンロードアダプタの実装依頼テンプレ (お客様環境へ渡す用)
  if (fs.existsSync('SCANNER-ADAPTER-DOWNLOAD-REQUEST.md')) {
    fs.copyFileSync('SCANNER-ADAPTER-DOWNLOAD-REQUEST.md', 'dist/SCANNER-ADAPTER-DOWNLOAD-REQUEST.md');
  }
  // 取込 CSV の列構成見本 (マージ CSV 実装の参照用。SPEC §10 から参照される)
  if (fs.existsSync('samples/template.csv')) {
    fs.copyFileSync('samples/template.csv', 'dist/sample-import-template.csv');
  }
  // 同梱 OSS のライセンス表記 (配布物に含める)
  if (fs.existsSync('THIRD_PARTY_NOTICES.md')) {
    fs.copyFileSync('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md');
  }

  // README / SETUP
  fs.writeFileSync('dist/README.md', renderReadme(buildId, relayVersion));
  console.log('');
  console.log('  ▶ 配置: SharePoint「ドキュメント」→ Mikke フォルダに mikke.bundle.js と version.txt を置く');
  console.log('  ▶ 利用者は install-loader.html の「Mikke」をブックマークに登録');
  if (overrideBase !== '""') console.log(`  ✔ 上書きベース (テスト): ${process.env.MIKKE_BUNDLE_BASE}`);
}

function renderInstallHtml(href, inlined) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mikke インストール</title>
<style>
  :root{--ink:#2a2a26;--ink-3:#7a766c;--paper:#fafaf7;--paper-2:#f3f1ea;
    --line:rgba(42,42,38,0.12);--accent:#7b97c4;--accent-strong:#5a76a3;
    --font:"Meiryo","メイリオ","Hiragino Sans","Yu Gothic UI",-apple-system,"Segoe UI",system-ui,sans-serif;}
  *{box-sizing:border-box}
  body{font-family:var(--font);max-width:680px;margin:48px auto 80px;padding:0 24px;color:var(--ink);line-height:1.8;background:var(--paper)}
  h1{font-size:28px;font-weight:700;margin:0 0 8px;display:flex;align-items:center;gap:12px}
  .mark{width:30px;height:30px;border-radius:7px;background:var(--accent);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:18px}
  .sub{color:var(--ink-3);font-size:14px;margin:0 0 36px}
  .bm{display:inline-block;padding:12px 28px;background:var(--accent);color:#fff;border-radius:8px;font-weight:700;text-decoration:none;font-size:18px}
  .bm:hover{background:var(--accent-strong)}
  ol{padding-left:1.4em} li{margin:8px 0}
  .note{background:var(--paper-2);border:1px solid var(--line);border-radius:8px;padding:16px;font-size:13px;color:var(--ink-3);margin-top:24px}
</style></head>
<body>
  <h1><span class="mark">N</span> Mikke インストール</h1>
  <p class="sub">脆弱性管理ツール — SharePoint + ブックマークレット${inlined ? ' (バンドル埋込版)' : ' (ローダ版・推奨)'}</p>
  <ol>
    <li>下のボタンをブックマークバーに<strong>ドラッグ</strong>して登録</li>
    <li>管理対象の <strong>SharePoint サイト</strong> を開く</li>
    <li>登録した <strong>Mikke</strong> ブックマークをクリック</li>
  </ol>
  <p style="margin:28px 0"><a class="bm" href="${href.replace(/"/g, '&quot;')}">Mikke</a></p>
  <div class="note">${inlined
    ? 'これはバンドル埋込版です。更新時は再登録が必要です。通常は「ローダ版 (install-loader.html)」を使うと自動更新されます。'
    : 'ローダ版です。起動のたびに SharePoint 上の最新バンドルを自動取得します (再登録不要)。'}</div>
</body></html>`;
}

function renderReadme(buildId, relayVersion) {
  return `# Mikke 配布物

**Version:** UI = ${buildId} / relay = v${relayVersion}

## SharePoint に置くファイル
- \`mikke.bundle.js\` … UI 本体 (ブラウザ実行)
- \`version.txt\` … UI バージョン (自動更新のキャッシュキー)
- \`install-loader.html\` … 利用者がブックマーク登録 (推奨)
- \`relay-version.txt\` … relay 自動更新 manifest

## ローカル中継サーバ (各自 PC)
- \`mikke-relay.ps1\` / \`mikke-launch.ps1\` / \`mikke-launch.bat\` / \`mikke-relay.env\`
- \`mikke-launch.bat\` を実行すると relay 起動 → SP サイトを開く

## 自動更新
- UI バンドルは起動時にローダが version.txt を見て最新を取得 (サイレント)。
- relay スクリプトは UI が SP の relay-version.txt と比較し、差があれば self-update を実行。
`;
}
