// アクセス権画面: 連携用リストのアイテム単位アクセス権を設定する。
//
// ★ 方式は WebReg の src/perms.js に準拠 (詳細は lib/itemPerms.ts の先頭コメント)。
//   ここは画面だけを持ち、判断は lib/itemPerms.ts、SP 呼び出しは api/sp.ts にある。
//
// 画面構成 (WebReg のマスタ管理と同じ流れ):
//   1. 管理者グループ … 全アイテムにフルコントロール
//   2. 事業会社を一括登録 … 1 行 1 件のテキストエリア (Excel から貼り付け可)
//   3. 事業会社ごとにグループを手動で割当
//   4. 「権限を反映」で全アイテムへ適用
import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { getRepo } from '../api/repo';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import {
  normalizePerms, registeredCompanies, groupIdsFor, parseCompanyList, mergeCompanies,
  type VulnResponsePerms, type SiteGroup,
} from '../lib/itemPerms';
import type { MikkeSettings } from '../types';

export function renderPermsView(rootEl: HTMLElement): HTMLElement {
  const root = el('div', { class: 'mikke-main', style: 'display:flex;flex-direction:column' });
  const subbar = el('div', { class: 'mikke-subbar' });
  const toolbar = el('div', { class: 'mikke-toolbar' });
  const bodyWrap = el('div', { class: 'mikke-table-wrap', style: 'padding:0 var(--gutter) var(--s-8)' });
  root.append(subbar, toolbar, bodyWrap);

  let settings: MikkeSettings | null = null;
  let perms: VulnResponsePerms = normalizePerms(null);
  let groups: SiteGroup[] = [];
  /** 連携用リストに実際に入っている事業会社 (未登録のものに気付けるように出す)。 */
  let inUse: string[] = [];
  let busy = false;

  const groupTitle = (id: number): string =>
    groups.find((g) => g.id === id)?.title ?? `(不明なグループ #${id})`;

  async function save(): Promise<void> {
    if (!settings) return;
    settings = { ...settings, vulnResponsePerms: perms };
    await getRepo().saveSettings(settings);
  }

  async function load(): Promise<void> {
    settings = await getRepo().getSettings();
    perms = normalizePerms(settings.vulnResponsePerms);
    const [g, targets] = await Promise.all([
      getRepo().listSiteGroups().catch(() => [] as SiteGroup[]),
      getRepo().listVulnResponsePermTargets().catch(() => [] as { id: number; businessCompany: string }[]),
    ]);
    groups = g;
    inUse = [...new Set(targets.map((t) => t.businessCompany.trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'ja'));
    paint();
  }

  // ── グループ選択モーダル (管理者用 / 事業会社用で共用) ─────────────────────
  function openGroupPicker(title: string, note: string, selected: number[]): Promise<number[] | null> {
    return new Promise((resolve) => {
      if (!groups.length) {
        toast(rootEl, 'サイトの権限グループを取得できませんでした。SharePoint の権限を確認してください。', 'error', 8000);
        resolve(null);
        return;
      }
      const sel = new Set(selected);
      const search = el('input', {
        class: 'mikke-input', type: 'text', placeholder: 'グループ名で絞り込み',
        style: 'width:100%;margin-bottom:var(--s-3)',
      }) as HTMLInputElement;
      const list = el('div', { style: 'max-height:46vh;overflow:auto;border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-2)' });
      const paintList = (): void => {
        clear(list);
        const q = search.value.trim().toLowerCase();
        // 既に選ばれているものを先頭に (WebReg と同じ並べ方)
        const sorted = [...groups].sort((a, b) => (sel.has(b.id) ? 1 : 0) - (sel.has(a.id) ? 1 : 0));
        const shown = sorted.filter((g) => !q || g.title.toLowerCase().includes(q));
        if (!shown.length) { list.appendChild(el('div', { class: 'mikke-note' }, ['該当するグループがありません。'])); return; }
        for (const g of shown) {
          const cb = el('input', { type: 'checkbox', ...(sel.has(g.id) ? { checked: 'checked' } : {}) }) as HTMLInputElement;
          cb.addEventListener('change', () => { if (cb.checked) sel.add(g.id); else sel.delete(g.id); });
          list.appendChild(el('label', {
            style: 'display:flex;align-items:center;gap:8px;padding:4px 6px;font-size:var(--fs-sm);cursor:pointer',
          }, [cb, el('span', {}, [g.title])]));
        }
      };
      search.addEventListener('input', paintList);
      paintList();
      // 決定を押したときだけ確定。× / Esc / 背景クリックは onClose で null にする。
      let decided = false;
      openModal(rootEl, {
        title,
        body: el('div', {}, [el('p', { class: 'mikke-note', style: 'margin:0 0 var(--s-3)' }, [note]), search, list]),
        primaryLabel: '決定',
        onPrimary: () => { decided = true; resolve([...sel]); },
        onClose: () => { if (!decided) resolve(null); },
      });
    });
  }

  // ── 事業会社の一括登録 (1 行 1 件。Excel から貼り付け可) ────────────────────
  function openBulkModal(): void {
    const current = registeredCompanies(perms);
    // まだ登録していないが連携用リストに出てくる会社を下に足しておく (取りこぼし防止)
    const missing = inUse.filter((c) => !current.includes(c));
    const ta = el('textarea', {
      class: 'mikke-input', rows: '14', spellcheck: 'false', wrap: 'off',
      style: 'width:100%;font-family:var(--font-mono, monospace);font-size:var(--fs-sm);line-height:1.7',
    }) as HTMLTextAreaElement;
    ta.value = [...current, ...missing].join('\n');
    openModal(rootEl, {
      title: '事業会社の一括登録',
      body: el('div', {}, [
        el('p', { class: 'mikke-note', style: 'margin:0 0 var(--s-3)' }, [
          '1 行 1 件で入力します。Excel の列をそのまま貼り付けられます（タブ区切りは先頭列だけ使います）。',
        ]),
        el('p', { class: 'mikke-note', style: 'margin:0 0 var(--s-3)' }, [
          'ここに書いた会社が一覧になります。行を消すとその会社の割当も消えます。'
          + '既に割当がある会社を残しておけば、割当はそのままです。',
        ]),
        ...(missing.length ? [el('p', { class: 'mikke-note', style: 'margin:0 0 var(--s-3);color:var(--warn,var(--ink-2))' }, [
          `連携用リストにあって未登録だった ${missing.length} 件を末尾に足してあります: ${missing.slice(0, 5).join(' / ')}${missing.length > 5 ? ' …' : ''}`,
        ])] : []),
        ta,
      ]),
      primaryLabel: '登録する',
      onPrimary: async () => {
        const names = parseCompanyList(ta.value);
        perms = mergeCompanies(perms, names);
        await save();
        toast(rootEl, `事業会社を ${names.length} 件登録しました。`, 'ok');
        paint();
      },
    });
  }

  // ── 反映 ────────────────────────────────────────────────────────────────
  async function applyAll(): Promise<void> {
    if (busy) return;
    busy = true;
    paint();
    const line = el('div', { class: 'mikke-note' }, ['準備中…']);
    clear(resultBox); resultBox.appendChild(line);
    try {
      const targets = await getRepo().listVulnResponsePermTargets();
      if (!targets.length) {
        clear(resultBox);
        resultBox.appendChild(el('div', { class: 'mikke-note' }, ['連携用リストにアイテムがありません。']));
        return;
      }
      const r = await getRepo().applyVulnResponseItemPerms(targets, (done, total) => {
        line.textContent = `権限を反映中… (${done}/${total})`;
      });
      clear(resultBox);
      resultBox.appendChild(el('div', { class: r.errors.length ? 'mikke-error' : 'mikke-note' }, [
        `反映しました: 割当あり ${r.applied} 件 / 管理者のみ ${r.adminOnly} 件`
        + (r.errors.length ? ` / 失敗 ${r.errors.length} 件 — ${r.errors[0]}` : ''),
      ]));
      toast(rootEl, `アクセス権を反映しました (${r.applied + r.adminOnly} 件)`, r.errors.length ? 'warn' : 'ok');
    } catch (e) {
      clear(resultBox);
      resultBox.appendChild(el('div', { class: 'mikke-error' }, [`反映に失敗しました: ${(e as Error).message}`]));
    } finally {
      busy = false;
      paint();
    }
  }

  const resultBox = el('div', { style: 'margin-top:var(--s-4)' });

  // ── 描画 ────────────────────────────────────────────────────────────────
  function paint(): void {
    const companies = registeredCompanies(perms);
    const unregistered = inUse.filter((c) => !companies.includes(c));

    clear(subbar);
    subbar.append(
      el('span', { class: 'mikke-subbar-title' }, ['アクセス権']),
      el('span', { class: 'mikke-subbar-count' }, [`事業会社 ${companies.length} 件`]),
    );

    clear(toolbar);
    toolbar.append(
      el('button', {
        class: 'mikke-btn mikke-btn--secondary', style: 'height:30px;font-size:var(--fs-sm)',
        ...(busy ? { disabled: 'disabled' } : {}),
        onclick: () => openBulkModal(),
        html: icon('list') + '<span>事業会社を一括登録</span>',
      }),
      el('button', {
        class: 'mikke-btn mikke-btn--primary', style: 'height:30px;font-size:var(--fs-sm)',
        title: '連携用リストの全アイテムに、ここで決めたアクセス権を適用します',
        ...(busy ? { disabled: 'disabled' } : {}),
        onclick: () => void applyAll(),
        html: icon('shield') + '<span>権限を反映</span>',
      }),
    );

    clear(bodyWrap);
    bodyWrap.append(
      el('p', { class: 'mikke-note', style: 'margin:var(--s-4) 0' }, [
        '連携用リスト (MikkeVulnResponse) のアイテムごとに、参照・更新できる SharePoint 権限グループを決めます。',
        el('br'),
        '管理者グループは全アイテムにフルコントロール、事業会社ごとの割当はその事業会社のアイテムに参照・更新 (投稿) を付けます。',
        el('br'),
        '反映するとアイテムの権限継承が解除され、ここで選んだグループだけがアクセスできます。',
      ]),

      // 管理者グループ
      el('div', { style: 'margin:var(--s-5) 0;padding:var(--s-4);border:1px solid var(--line);border-radius:var(--r-2)' }, [
        el('div', { style: 'display:flex;align-items:center;gap:var(--s-4);margin-bottom:var(--s-2)' }, [
          el('div', { style: 'font-weight:600' }, ['管理者グループ']),
          el('span', { class: 'mikke-note' }, ['全アイテムにフルコントロール']),
          el('button', {
            class: 'mikke-btn mikke-btn--secondary', style: 'height:26px;font-size:var(--fs-sm);margin-left:auto',
            ...(busy ? { disabled: 'disabled' } : {}),
            onclick: () => void (async () => {
              const picked = await openGroupPicker('管理者グループ',
                '連携用リストの全アイテムにフルコントロールを付けるグループです。ここが空だと反映できません。',
                perms.adminGroupIds);
              if (!picked) return;
              perms = { ...perms, adminGroupIds: picked };
              await save();
              paint();
            })(),
          }, ['グループを選ぶ']),
        ]),
        perms.adminGroupIds.length
          ? el('div', { style: 'font-size:var(--fs-sm)' }, [perms.adminGroupIds.map(groupTitle).join(' / ')])
          : el('div', { class: 'mikke-error', style: 'margin:0' }, [
              '未設定です。管理者グループを 1 つ以上選んでください（空のまま反映すると、誰も見られないアイテムができます）。',
            ]),
      ]),

      // 未登録の事業会社の注意
      ...(unregistered.length ? [el('div', { class: 'mikke-error', style: 'margin:var(--s-4) 0' }, [
        `連携用リストにあるが未登録の事業会社が ${unregistered.length} 件あります`
        + `（${unregistered.slice(0, 5).join(' / ')}${unregistered.length > 5 ? ' …' : ''}）。`
        + 'このままだと管理者グループだけが見られます。「事業会社を一括登録」で追加してください。',
      ])] : []),

      // 事業会社ごとの割当
      el('div', { style: 'font-weight:600;margin:var(--s-6) 0 var(--s-2)' }, ['事業会社ごとの割当']),
      companies.length ? companyTable(companies) : el('div', { class: 'mikke-note' }, [
        '事業会社が登録されていません。「事業会社を一括登録」から登録してください。',
      ]),
      resultBox,
    );
  }

  function companyTable(companies: string[]): HTMLElement {
    const table = el('table', { class: 'mikke-table' }) as HTMLTableElement;
    table.style.tableLayout = 'auto';
    table.style.width = '100%';
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { style: 'width:280px' }, ['事業会社']),
      el('th', {}, ['参照・更新できるグループ']),
      el('th', { style: 'width:140px' }, ['']),
    ])]));
    const tbody = el('tbody');
    for (const c of companies) {
      const assigned = groupIdsFor(c, perms);
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [c]),
        el('td', { style: assigned.length ? '' : 'color:var(--ink-4)' }, [
          assigned.length ? assigned.map(groupTitle).join(' / ') : '未割当（管理者のみ）',
        ]),
        el('td', {}, [
          el('button', {
            class: 'mikke-btn mikke-btn--secondary', style: 'height:26px;font-size:var(--fs-sm)',
            ...(busy ? { disabled: 'disabled' } : {}),
            onclick: () => void (async () => {
              const picked = await openGroupPicker(`グループの割当 — ${c}`,
                `「${c}」のアイテムを参照・更新できるグループを選びます（投稿のアクセス権。更新には参照が含まれます）。`,
                assigned);
              if (!picked) return;
              perms = {
                ...perms,
                byBusinessCompany: { ...perms.byBusinessCompany, [c]: picked },
              };
              await save();
              paint();
            })(),
          }, ['グループを選ぶ']),
        ]),
      ]));
    }
    table.appendChild(tbody);
    return table;
  }

  void load();
  return root;
}
