// 設定 → 管理対象一覧のリセット。
//
// ★ 元に戻せない操作なので、この画面は「消す前に見せる」ことに寄せている。
//   1. いま何件あるかを出す
//   2. 何を消すかを選ばせる (連携用リスト / 履歴は任意)
//   3. 確認語をキーボードで打たせる (誤クリックで消えないように)
import { el, clear } from '../utils/dom';
import { getRepo } from '../api/repo';
import { toast } from '../components/toast';
import { openModal } from '../components/modal';

/** 実行前に打ってもらう語。押し間違いでは通らない長さにする。 */
const CONFIRM_WORD = 'リセット';

export interface ResetPanelParts { body: HTMLElement }

export function renderResetPanel(root: HTMLElement): ResetPanelParts {
  let busy = false;
  const withVulnResponse = el('input', { type: 'checkbox', checked: 'checked' }) as HTMLInputElement;
  const withHistory = el('input', { type: 'checkbox', checked: 'checked' }) as HTMLInputElement;

  const counts = el('div', { class: 'mikke-note' }, ['件数を確認しています…']);
  const result = el('div', { style: 'margin-top:var(--s-4)' });

  const runBtn = el('button', {
    class: 'mikke-btn mikke-btn--danger', type: 'button',
  }, ['管理対象一覧をリセット']) as HTMLButtonElement;

  /** いま何件あるかを出す。数を見ないまま消させない。 */
  async function loadCounts(): Promise<{ issues: number; linked: number }> {
    const [issues, linked] = await Promise.all([
      getRepo().listIssues().then((a) => a.length).catch(() => -1),
      getRepo().listVulnResponseRows().then((a) => a.length).catch(() => -1),
    ]);
    clear(counts);
    counts.appendChild(el('div', {}, [
      `管理対象一覧: ${issues < 0 ? '(取得できません)' : `${issues} 件`}`,
      el('br'),
      `連携用リスト: ${linked < 0 ? '(取得できません)' : `${linked} 件`}`,
    ]));
    return { issues: Math.max(0, issues), linked: Math.max(0, linked) };
  }

  const check = (cb: HTMLInputElement, title: string, desc: string): HTMLElement =>
    el('label', {
      style: 'display:flex;align-items:flex-start;gap:var(--s-3);cursor:pointer;'
        + 'padding:var(--s-3);background:var(--paper-2);border-radius:var(--r-2);margin-bottom:var(--s-2)',
    }, [
      cb,
      el('span', {}, [
        el('div', {}, [title]),
        el('div', { style: 'font-size:var(--fs-sm);color:var(--ink-3);margin-top:var(--s-1)' }, [desc]),
      ]),
    ]);

  runBtn.addEventListener('click', () => void (async () => {
    if (busy) return;
    const { issues, linked } = await loadCounts();
    if (!issues && !(withVulnResponse.checked && linked)) {
      toast(root, '消すものがありません。', 'warn');
      return;
    }
    const input = el('input', {
      type: 'text', class: 'mikke-input', style: 'width:100%', placeholder: CONFIRM_WORD, spellcheck: 'false',
    }) as HTMLInputElement;
    const targets = [
      `管理対象一覧 ${issues} 件`,
      ...(withVulnResponse.checked ? [`連携用リスト ${linked} 件`] : []),
      ...(withHistory.checked ? ['対応履歴・更新履歴'] : []),
    ];
    openModal(root, {
      title: '管理対象一覧をリセット',
      body: el('div', { style: 'line-height:1.8' }, [
        el('p', { style: 'margin:0 0 var(--s-3)' }, ['次のものを削除します。']),
        el('ul', { style: 'margin:0 0 var(--s-4);padding-left:1.2em' },
          targets.map((t) => el('li', {}, [el('b', {}, [t])]))),
        el('p', { style: 'margin:0 0 var(--s-4);color:var(--danger)' }, [
          el('b', {}, ['元に戻せません。']),
          ' 設定 (管理項目・管理対象条件・アクセス権) は消えません。',
        ]),
        el('div', { class: 'mikke-field' }, [
          el('label', { class: 'mikke-field-label' }, [`確認のため「${CONFIRM_WORD}」と入力してください`]),
          input,
        ]),
      ]),
      primaryLabel: '削除する',
      onPrimary: async () => {
        if (input.value.trim() !== CONFIRM_WORD) {
          toast(root, `「${CONFIRM_WORD}」と入力してください`, 'warn');
          throw new Error('confirm required');
        }
        await run();
      },
    });
  })());

  async function run(): Promise<void> {
    busy = true;
    runBtn.setAttribute('disabled', '');
    const line = el('div', { class: 'mikke-note' }, ['準備中…']);
    clear(result); result.appendChild(line);
    const done: string[] = [];
    const failed: string[] = [];
    try {
      // ★ 履歴は Issue Instance ID を鍵に持っているので、管理対象を消す **前** に集める。
      const iids = withHistory.checked
        ? [...new Set((await getRepo().listIssues()).map((i) => i.issueInstanceId).filter(Boolean))]
        : [];

      if (withVulnResponse.checked) {
        const rows = await getRepo().listVulnResponseRows().catch(() => []);
        let n = 0;
        for (const r of rows) {
          line.textContent = `連携用リストを削除しています… (${++n}/${rows.length})`;
          try { await getRepo().deleteVulnResponseItem(r.id); } catch { failed.push(`連携用リスト #${r.id}`); }
        }
        done.push(`連携用リスト ${rows.length - failed.length} 件`);
      }

      if (iids.length) {
        let n = 0;
        for (const iid of iids) {
          line.textContent = `履歴を削除しています… (${++n}/${iids.length})`;
          try {
            for (const h of await getRepo().listHistory(iid)) await getRepo().deleteHistory(h.id);
            await getRepo().clearChangeLog(iid);
          } catch { failed.push(`履歴 ${iid}`); }
        }
        done.push(`履歴 ${iids.length} 件分`);
      }

      line.textContent = '管理対象一覧を削除しています…';
      const r = await getRepo().deleteAllIssues((d, t) => {
        line.textContent = `管理対象一覧を削除しています… (${d}/${t})`;
      });
      done.push(`管理対象一覧 ${r.ok} 件`);
      if (r.fail) failed.push(`管理対象 ${r.fail} 件`);

      clear(result);
      result.appendChild(el('div', { class: failed.length ? 'mikke-error' : 'mikke-note' }, [
        `削除しました: ${done.join(' / ')}`
        + (failed.length ? ` — 失敗 ${failed.length} 件 (${failed.slice(0, 3).join(', ')})` : ''),
      ]));
      toast(root, `リセットしました (${done.join(' / ')})`, failed.length ? 'warn' : 'ok');
      await loadCounts();
    } catch (e) {
      clear(result);
      result.appendChild(el('div', { class: 'mikke-error' }, [`リセットに失敗しました: ${(e as Error).message}`]));
    } finally {
      busy = false;
      runBtn.removeAttribute('disabled');
    }
  }

  const body = el('div', {}, [
    el('div', { class: 'mikke-note', style: 'margin-bottom:var(--s-4)' }, [
      '管理対象一覧の中身をすべて消して、取り込み前の状態に戻します。',
      el('br'),
      'Excel からの移行や CSV 取込をやり直すときに使います。',
    ]),
    el('ul', { style: 'margin:0 0 var(--s-5);padding-left:1.2em;font-size:var(--fs-sm);color:var(--ink-2);line-height:1.8' }, [
      el('li', {}, [el('b', {}, ['元に戻せません。']), ' 削除したデータは復旧できません。']),
      el('li', {}, ['設定は消えません（管理項目の選択 / 管理対象条件 / 個別指定 / アクセス権 / 脆弱性タイプの判定 / 旧略称の読み替え）。']),
      el('li', {}, ['資産管理・ダウンロードデータ・SharePoint のリスト定義そのものは消えません。']),
    ]),
    counts,
    el('div', { style: 'margin-top:var(--s-5)' }, [
      el('div', { class: 'mikke-field-label', style: 'margin-bottom:var(--s-2)' }, ['一緒に消すもの']),
      check(withVulnResponse, '連携用リストのアイテム',
        '残しておくと、管理対象に無いアイテムとして次の反映で削除されます。事業会社の記入内容も消えます。'),
      check(withHistory, '対応履歴・更新履歴',
        '残すと、同じ Issue Instance ID を取り込み直したときに以前の履歴が再び紐づきます。'),
    ]),
    el('div', { style: 'margin-top:var(--s-5)' }, [runBtn]),
    result,
  ]);

  void loadCounts();
  return { body };
}
