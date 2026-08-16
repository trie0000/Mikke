// 検査ツール API の接続情報 (ベース URL / API キー)。
//
// ★ **この端末にだけ** 保存する (localStorage)。理由は 2 つ。
//   - SharePoint の共通設定に置くと、リストを見られる人全員に API キーが渡る。
//   - relay の .env に置くと、配布物やリポジトリに混ざる事故が起きる。
//     Mikke は「秘密情報はコード/env/リポジトリに置かない」方針。
// ★ relay へは **リクエストのたびに引数として渡す**。relay 側は受け取った値を
//   そのままアダプタに渡すだけで、保存しない。
//
// UI にも SP にも依存しない (テストしやすくするため)。

const BASE_KEY = 'mikke.scanner.apiBase';
const KEY_KEY = 'mikke.scanner.apiKey';

export interface ScannerApi {
  /** 検査ツール API のベース URL (例: https://api.example.com)。 */
  base: string;
  /** API キー。 */
  key: string;
}

const read = (k: string): string => {
  try { return (localStorage.getItem(k) ?? '').trim(); } catch { return ''; }
};

/** 保存済みの接続情報。未設定なら空文字。 */
export function getScannerApi(): ScannerApi {
  return { base: read(BASE_KEY).replace(/\/+$/, ''), key: read(KEY_KEY) };
}

/** 保存する。空文字を渡した項目は消す。 */
export function setScannerApi(v: ScannerApi): void {
  try {
    const base = (v.base ?? '').trim().replace(/\/+$/, '');
    const key = (v.key ?? '').trim();
    if (base) localStorage.setItem(BASE_KEY, base); else localStorage.removeItem(BASE_KEY);
    if (key) localStorage.setItem(KEY_KEY, key); else localStorage.removeItem(KEY_KEY);
  } catch { /* noop */ }
}

/** 両方そろっているか (片方だけでは呼べない)。 */
export function hasScannerApi(): boolean {
  const v = getScannerApi();
  return !!v.base && !!v.key;
}

/**
 * relay へ渡す引数を作る。
 * ★ 未設定の項目は **入れない**。入れると relay 側で「空文字が指定された」と
 *   区別できず、relay の .env に設定してある環境で上書きしてしまう。
 */
export function scannerApiArgs(): { apiBase?: string; apiKey?: string } {
  const v = getScannerApi();
  const out: { apiBase?: string; apiKey?: string } = {};
  if (v.base) out.apiBase = v.base;
  if (v.key) out.apiKey = v.key;
  return out;
}
