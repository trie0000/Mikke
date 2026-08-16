import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

// 中継サーバの接続先は **env (MIKKE_RELAY_PORT) だけ** で決める。画面に設定欄は無い。
// ブックマークレットで開いた場合など、ランチャーが書き込めないときのために
// 既定ポートの周辺を自動で探す。ここはその探索の検査。

const g = globalThis as unknown as {
  localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  fetch?: unknown;
};

let store: Record<string, string> = {};
let asked: string[] = [];

beforeEach(() => {
  store = {};
  asked = [];
  g.localStorage = {
    getItem: (k: string) => (k in store ? store[k]! : null),
    setItem: (k: string, v: string) => { store[k] = v; },
  };
});
afterEach(() => { delete g.fetch; });

/** 指定した base だけが応答する fetch を作る。 */
function serveOnly(okBase: string | null): void {
  g.fetch = async (url: string): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
    asked.push(url);
    if (okBase && url === `${okBase}/health`) {
      return { ok: true, json: async () => ({ ok: true, version: '1.0.0' }) };
    }
    throw new Error('ECONNREFUSED');
  };
}

describe('接続先の自動探索', () => {
  it('既定ポートで応答すればそれを使う', async () => {
    const { discoverRelayBase, getRelayBase } = await import('../src/api/relay');
    serveOnly('http://127.0.0.1:18120/mikke');
    expect(await discoverRelayBase()).toBe('http://127.0.0.1:18120/mikke');
    expect(getRelayBase()).toBe('http://127.0.0.1:18120/mikke');
  });

  it('★ env でポートを変えても、連番で探して見つける', async () => {
    const { discoverRelayBase, getRelayBase } = await import('../src/api/relay');
    serveOnly('http://127.0.0.1:18125/mikke');
    expect(await discoverRelayBase()).toBe('http://127.0.0.1:18125/mikke');
    // 次からは探さずに済むよう覚える
    expect(getRelayBase()).toBe('http://127.0.0.1:18125/mikke');
  });

  it('どこにも居なければ null (画面には「接続できません」を出す)', async () => {
    const { discoverRelayBase } = await import('../src/api/relay');
    serveOnly(null);
    expect(await discoverRelayBase()).toBeNull();
  });

  it('探す範囲は既定ポートから 20 個まで (無限に叩かない)', async () => {
    const { discoverRelayBase } = await import('../src/api/relay');
    serveOnly(null);
    await discoverRelayBase();
    const ports = [...new Set(asked.map((u) => Number(new URL(u).port)))].sort((a, b) => a - b);
    expect(ports[0]).toBe(18120);
    expect(ports[ports.length - 1]).toBe(18139);
    expect(ports).toHaveLength(20);
  });

  it('覚えている接続先が駄目になったら探し直す (health 経由)', async () => {
    const { relayHealth, getRelayBase } = await import('../src/api/relay');
    store['mikke.relay.base'] = 'http://127.0.0.1:18120/mikke';   // 前回のポート
    serveOnly('http://127.0.0.1:18130/mikke');                    // env で変えた後
    const h = await relayHealth();
    expect(h.ok).toBe(true);
    expect(getRelayBase()).toBe('http://127.0.0.1:18130/mikke');
  });
});

describe('★ 接続先の設定欄を画面に置かない (env と二重管理にしない)', () => {
  const settings = fs.readFileSync('src/views/settingsModal.ts', 'utf8');

  it('設定画面に中継サーバ URL の入力欄が無い', () => {
    expect(settings).not.toContain('中継サーバ ベース URL');
    // 保存もしない (localStorage への書き込みはランチャーと自動探索だけ)
    expect(settings).not.toContain("setItem('mikke.relay.base'");
  });

  it('バンドル読込元の設定欄も無い (表示だけ)', () => {
    expect(settings).not.toContain('setBundleSource');
    expect(settings).not.toContain('setLocalBase');
    expect(settings).not.toContain('relaySetBundleDir');
  });

  it('ランチャーが env のポートを書き込む', () => {
    const launcher = fs.readFileSync('dist/mikke-launch.ps1', 'utf8');
    expect(launcher).toContain('localStorage.setItem("mikke.relay.base"');
    expect(launcher).toContain('MIKKE_BUNDLE_SOURCE');
    expect(launcher).toContain('MIKKE_BUNDLE_LOCAL_BASE');
  });

  it('★ env の見本にキーの重複が無い', () => {
    // 重複すると読む側は **先に書いた方だけ** を採用する
    // (Import-EnvFile は既に設定済みのキーを上書きしない)。
    // 見本に 2 つあると、後ろを直したのに効かない、という事故になる。
    const env = fs.readFileSync('dist/mikke-relay.env.example', 'utf8');
    const keys = [...env.matchAll(/^#?\s*(MIKKE_[A-Z_]+)\s*=/gm)].map((m) => m[1]!);
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect([...new Set(dup)]).toEqual([]);
  });

  it('env の見本に指定方法が書いてある', () => {
    const env = fs.readFileSync('dist/mikke-relay.env.example', 'utf8');
    for (const key of ['MIKKE_RELAY_PORT', 'MIKKE_BUNDLE_SOURCE', 'MIKKE_BUNDLE_LOCAL_BASE', 'MIKKE_BUNDLE_DIR']) {
      expect(env, `${key} が見本に無い`).toContain(key);
    }
  });
});
