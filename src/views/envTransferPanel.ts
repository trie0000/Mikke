// 設定 → 環境間コピー: 開発環境 ↔ 本番環境 の設定を持ち運ぶ。
//
// ★ 流れ
//   1. 開発サイト / 本番サイト の URL を入れる (端末ごとに保存)
//   2. 向き (開発→本番 / 本番→開発) と、運ぶもの (抽出条件 / アクセス権) を選ぶ
//   3. 「差分を確認」で **何が変わるか** を見てから実行する
//
// ★ 同一テナント内なら直接コピーできる。別テナント (別オリジン) はブラウザが
//   遮るので、ファイル (JSON) で受け渡す導線に切り替える。
import { el, clear } from '../utils/dom';
import { getRepo, getRepoMode } from '../api/repo';
import { toast } from '../components/toast';
import { openModal } from '../components/modal';
import {
  toBundle, applyBundle, normalizeBundle, unresolvedGroupIds, sameOrigin,
  bundleFileName, PART_LABEL, type EnvBundle, type TransferPart,
} from '../lib/envTransfer';

const LS_DEV = 'mikke.env.devSite';
const LS_PROD = 'mikke.env.prodSite';

const lsGet = (k: string): string => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* noop */ } };

export interface EnvTransferPanelParts { body: HTMLElement; save?: () => Promise<void> }

export function renderEnvTransferPanel(root: HTMLElement): EnvTransferPanelParts {
  let dir: 'dev2prod' | 'prod2dev' = 'dev2prod';
  const parts = new Set<TransferPart>(['extraction', 'perms']);

  const devInput = el('input', {
    type: 'text', class: 'mikke-input', value: lsGet(LS_DEV), style: 'width:100%',
    placeholder: 'https://<tenant>.sharepoint.com/sites/<開発サイト>',
  }) as HTMLInputElement;
  const prodInput = el('input', {
    type: 'text', class: 'mikke-input', value: lsGet(LS_PROD), style: 'width:100%',
    placeholder: 'https://<tenant>.sharepoint.com/sites/<本番サイト>',
  }) as HTMLInputElement;

  const result = el('div', { style: 'margin-top:var(--s-4)' });
  const note = el('div', { style: 'margin-top:var(--s-3)' });

  const from = (): string => (dir === 'dev2prod' ? devInput.value : prodInput.value).trim();
  const to = (): string => (dir === 'dev2prod' ? prodInput.value : devInput.value).trim();
  const fromLabel = (): string => (dir === 'dev2prod' ? '開発' : '本番');
  const toLabel = (): string => (dir === 'dev2prod' ? '本番' : '開発');
  const chosen = (): TransferPart[] => (['extraction', 'perms'] as TransferPart[]).filter((p) => parts.has(p));

  /** 直接コピーできるか。両方の URL が揃っていて、同じオリジンのときだけ。 */
  const canDirect = (): boolean => !!from() && !!to() && sameOrigin(from(), to());

  function paintNote(): void {
    clear(note);
    lsSet(LS_DEV, devInput.value.trim());
    lsSet(LS_PROD, prodInput.value.trim());
    if (!from() || !to()) {
      note.appendChild(el('div', { class: 'mikke-note' }, ['開発サイトと本番サイトの URL を両方入れてください。']));
      return;
    }
    if (canDirect()) {
      note.appendChild(el('div', { class: 'mikke-note' }, [
        `同じテナント内なので直接コピーできます: ${fromLabel()} → ${toLabel()}`,
      ]));
      return;
    }
    note.appendChild(el('div', { class: 'mikke-error' }, [
      '2 つのサイトのテナント (ドメイン) が違うため、ブラウザから直接コピーできません。',
      el('br'),
      `下の「ファイルに書き出す」で ${fromLabel()} 側の設定を保存し、${toLabel()} 側で Mikke を開いて`
      + '「ファイルから取り込む」を実行してください。',
    ]));
  }

  const dirSel = el('select', { class: 'mikke-select' }, [
    el('option', { value: 'dev2prod' }, ['開発 → 本番']),
    el('option', { value: 'prod2dev' }, ['本番 → 開発']),
  ]) as HTMLSelectElement;
  dirSel.addEventListener('change', () => {
    dir = dirSel.value as 'dev2prod' | 'prod2dev';
    clear(result);
    paintNote();
  });

  const partCheck = (p: TransferPart, desc: string): HTMLElement => {
    const cb = el('input', { type: 'checkbox', checked: 'checked' }) as HTMLInputElement;
    cb.addEventListener('change', () => {
      cb.checked ? parts.add(p) : parts.delete(p);
      clear(result);
    });
    return el('label', {
      style: 'display:flex;align-items:flex-start;gap:var(--s-3);cursor:pointer;'
        + 'padding:var(--s-3);background:var(--paper-2);border-radius:var(--r-2);margin-bottom:var(--s-2)',
    }, [
      cb,
      el('span', {}, [
        el('div', {}, [PART_LABEL[p]]),
        el('div', { style: 'font-size:var(--fs-sm);color:var(--ink-3);margin-top:var(--s-1)' }, [desc]),
      ]),
    ]);
  };

  /** 差分を見せる。ここで気づけないと、入れてから直すことになる。 */
  function paintPreview(bundle: EnvBundle, applied: ReturnType<typeof applyBundle>, target: string): void {
    clear(result);
    result.append(
      el('div', { class: 'mikke-note' }, [
        `コピー元: ${bundle.sourceSite || '(不明)'}`,
        el('br'),
        `コピー先: ${target}`,
      ]),
    );
    if (!applied.changes.length) {
      result.appendChild(el('div', { class: 'mikke-note', style: 'margin-top:var(--s-3)' }, [
        '変更はありません（コピー先は既に同じ内容です）。',
      ]));
      return;
    }
    result.appendChild(el('div', { style: 'margin-top:var(--s-3)' }, [
      el('div', { class: 'mikke-note' }, [`変わる項目 (${applied.changes.length} 件):`]),
      el('table', { class: 'mikke-table', style: 'width:100%;margin-top:var(--s-2)' }, [
        el('thead', {}, [el('tr', {}, ['項目', '変更前', '変更後'].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, applied.changes.map((c) => el('tr', {}, [
          el('td', {}, [c.field]), el('td', {}, [c.before]), el('td', {}, [c.after]),
        ]))),
      ]),
    ]));
    if (applied.missingGroups.length) {
      result.appendChild(el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `コピー先に無い SharePoint グループが ${applied.missingGroups.length} 件あります: `
        + applied.missingGroups.join(' / '),
        el('br'),
        'このまま実行すると、その割当は空になります（誰にも権限が付きません）。',
        el('br'),
        'コピー先のサイトで同じ名前のグループを作ってから、もう一度実行してください。',
      ]));
    }
  }

  // ── 直接コピー ──
  const previewBtn = el('button', { class: 'mikke-btn', type: 'button' }, ['差分を確認']);
  const runBtn = el('button', {
    class: 'mikke-btn mikke-btn--primary', type: 'button', disabled: 'disabled',
  }, ['コピーする']) as HTMLButtonElement;
  let pending: { target: string; settings: ReturnType<typeof applyBundle>['settings'] } | null = null;

  previewBtn.addEventListener('click', () => void (async () => {
    pending = null;
    runBtn.setAttribute('disabled', '');
    if (!chosen().length) { toast(root, 'コピーするものを選んでください。', 'warn'); return; }
    if (!canDirect()) { toast(root, '直接コピーできません。ファイル経由で受け渡してください。', 'warn'); return; }
    clear(result);
    result.appendChild(el('div', { class: 'mikke-note' }, ['読み込み中…']));
    try {
      const repo = getRepo();
      const [srcSettings, srcGroups, dstSettings, dstGroups] = await Promise.all([
        repo.getSettingsAt(from()), repo.listSiteGroupsAt(from()),
        repo.getSettingsAt(to()), repo.listSiteGroupsAt(to()),
      ]);
      const bundle = toBundle(srcSettings, srcGroups, chosen(), from(), new Date().toISOString());
      const applied = applyBundle(dstSettings, bundle, dstGroups, chosen());
      paintPreview(bundle, applied, to());
      // コピー元で名前を引けなかったグループは、そもそも運べない。
      const lost = unresolvedGroupIds(srcSettings, srcGroups);
      if (lost.length && parts.has('perms')) {
        result.appendChild(el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
          `コピー元で名前を引けないグループ ID があります: ${lost.join(' / ')}`,
          el('br'),
          '削除済みのグループが割当に残っている可能性があります。この分は運べません。',
        ]));
      }
      if (applied.changes.length) {
        pending = { target: to(), settings: applied.settings };
        runBtn.removeAttribute('disabled');
      }
    } catch (e) {
      clear(result);
      result.appendChild(el('div', { class: 'mikke-error' }, [`読み込みに失敗しました: ${(e as Error).message}`]));
    }
  })());

  runBtn.addEventListener('click', () => {
    if (!pending) return;
    const { target, settings } = pending;
    openModal(root, {
      title: `${toLabel()}環境へコピー`,
      body: el('div', { style: 'line-height:1.8' }, [
        el('p', { style: 'margin:0 0 var(--s-3)' }, [
          `コピー先: `, el('b', {}, [target]),
        ]),
        el('p', { style: 'margin:0;color:var(--ink-2)' }, [
          `コピー先の「${chosen().map((p) => PART_LABEL[p]).join('」「')}」は、`,
          el('b', {}, ['この内容で置き換わります']),
          '。元に戻せません。',
        ]),
      ]),
      primaryLabel: 'コピーする',
      onPrimary: async () => {
        runBtn.setAttribute('disabled', '');
        try {
          await getRepo().saveSettingsAt(target, settings);
          pending = null;
          clear(result);
          result.appendChild(el('div', { class: 'mikke-note' }, [`コピーしました: ${target}`]));
          toast(root, `${toLabel()}環境へコピーしました`, 'ok');
        } catch (e) {
          toast(root, `コピーに失敗しました: ${(e as Error).message}`, 'error');
          throw e;
        }
      },
    });
  });

  // ── ファイル経由 (別テナント / 手元に控えを残したいとき) ──
  const exportBtn = el('button', { class: 'mikke-btn', type: 'button' }, ['ファイルに書き出す']);
  exportBtn.addEventListener('click', () => void (async () => {
    if (!chosen().length) { toast(root, 'コピーするものを選んでください。', 'warn'); return; }
    try {
      const repo = getRepo();
      // URL が入っていればその環境を、無ければ今開いているサイトを書き出す。
      const src = from();
      const [settings, groups] = src
        ? await Promise.all([repo.getSettingsAt(src), repo.listSiteGroupsAt(src)])
        : await Promise.all([repo.getSettings(), repo.listSiteGroups()]);
      const now = new Date().toISOString();
      const bundle = toBundle(settings, groups, chosen(), src || '(今開いているサイト)', now);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const a = el('a', {
        href: URL.createObjectURL(blob), download: bundleFileName(chosen(), now), style: 'display:none',
      }) as HTMLAnchorElement;
      root.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast(root, '設定を書き出しました', 'ok');
    } catch (e) {
      toast(root, `書き出しに失敗しました: ${(e as Error).message}`, 'error');
    }
  })());

  const fileInput = el('input', { type: 'file', accept: '.json', style: 'display:none' }) as HTMLInputElement;
  const importBtn = el('button', { class: 'mikke-btn', type: 'button' }, ['ファイルから取り込む']);
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => void (async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    clear(result);
    try {
      const bundle = normalizeBundle(JSON.parse(await f.text()));
      if (!bundle) {
        result.appendChild(el('div', { class: 'mikke-error' }, ['Mikke の設定ファイルではありません（形式が違います）。']));
        return;
      }
      const repo = getRepo();
      // 取り込み先は「今開いているサイト」。URL の取り違えを防ぐためここは固定にする。
      const [cur, groups] = await Promise.all([repo.getSettings(), repo.listSiteGroups()]);
      const applied = applyBundle(cur, bundle, groups, chosen());
      paintPreview(bundle, applied, '（今開いているサイト）');
      if (!applied.changes.length) return;
      const ok = el('button', { class: 'mikke-btn mikke-btn--primary', type: 'button' }, ['この内容で取り込む']);
      ok.addEventListener('click', () => void (async () => {
        try {
          await repo.saveSettings(applied.settings);
          clear(result);
          result.appendChild(el('div', { class: 'mikke-note' }, ['取り込みました。']));
          toast(root, '設定を取り込みました', 'ok');
        } catch (e) {
          toast(root, `取り込みに失敗しました: ${(e as Error).message}`, 'error');
        }
      })());
      result.appendChild(el('div', { style: 'margin-top:var(--s-4)' }, [ok]));
    } catch (e) {
      result.appendChild(el('div', { class: 'mikke-error' }, [`読み込みに失敗しました: ${(e as Error).message}`]));
    }
  })());

  devInput.addEventListener('input', () => { clear(result); paintNote(); });
  prodInput.addEventListener('input', () => { clear(result); paintNote(); });

  const body = el('div', {}, [
    el('div', { class: 'mikke-note', style: 'margin-bottom:var(--s-4)' }, [
      '開発環境で決めた設定を本番環境へ（またはその逆へ）持っていきます。',
      el('br'),
      '運ぶのは設定だけです。管理対象の脆弱性データ・資産データ・連携用リストの中身は動かしません。',
    ]),
    el('ul', { style: 'margin:0 0 var(--s-5);padding-left:1.2em;font-size:var(--fs-sm);color:var(--ink-2);line-height:1.8' }, [
      el('li', {}, ['SharePoint グループはサイトごとに ID が違うため、',
        el('b', {}, ['グループ名で引き直します']),
        '。コピー先に同じ名前のグループが無いと権限が付きません（実行前に名指しで出します）。']),
      el('li', {}, ['実行前に必ず「差分を確認」で、何が変わるかを見てください。']),
      el('li', {}, ['コピー先の設定は選んだ分だけ置き換わります。元に戻せません。']),
    ]),

    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, ['開発サイト URL']), devInput,
    ]),
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, ['本番サイト URL']), prodInput,
    ]),
    el('div', { style: 'font-size:var(--fs-sm);color:var(--ink-3);margin:calc(-1 * var(--s-3)) 0 var(--s-5)' }, [
      'この 2 つはこの端末に保存します（サイト側の設定には保存しません）。',
    ]),

    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, ['向き']), dirSel,
    ]),
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, ['コピーするもの']),
      partCheck('extraction', '管理項目の選択 / 管理対象条件 / 個別指定 / 資産列 / 脆弱性タイプの判定'),
      partCheck('perms', '管理者グループ / 事業会社ごとの割当 / 事業会社の略称 / 旧略称の読み替え'),
    ]),
    note,
    el('div', { style: 'display:flex;gap:var(--s-3);margin-top:var(--s-4);flex-wrap:wrap' }, [
      previewBtn, runBtn,
      el('span', { style: 'flex:1' }),
      exportBtn, importBtn, fileInput,
    ]),
    result,
  ]);

  paintNote();
  if (getRepoMode() === 'mock') {
    body.insertBefore(el('div', { class: 'mikke-note', style: 'margin-bottom:var(--s-4);color:var(--warn)' }, [
      '※ 現在はモックモードです。コピー先はこの端末の保存領域になります（SharePoint には書きません）。',
    ]), body.firstChild);
  }
  return { body };
}
