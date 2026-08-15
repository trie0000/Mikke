// 設定 → 取込 → 旧略称の読み替え。
//
// ★ 国内・海外どちらの移行データでも同じ表を使う (同じ会社の話なので、
//   表を 2 つ持つと必ず食い違う)。独立した画面にして 1 か所で持つ。
// ★ ここで直した内容は保存後、移行の画面でファイルを読み直したときに効く。
import { el, clear } from '../utils/dom';
import { getRepo } from '../api/repo';
import { toast } from '../components/toast';
import { normalizeAliasRemap, remapConflicts, type AliasRemapRow } from '../lib/migration';
import { normalizePerms, registeredCompanies, aliasesFor, parseAliases } from '../lib/itemPerms';
import type { MikkeSettings } from '../types';

export interface AliasRemapPanelParts { body: HTMLElement; save: () => Promise<void> }

export async function renderAliasRemapPanel(root: HTMLElement): Promise<AliasRemapPanelParts> {
  const settings: MikkeSettings = await getRepo().getSettings();
  const perms = normalizePerms(settings.vulnResponsePerms);
  /** 「現在の略称」の入力候補 (アクセス権画面で登録済みの略称と事業会社名)。 */
  const knownAliases = [...new Set(
    registeredCompanies(perms).flatMap((c) => [...aliasesFor(c, perms), c]),
  )];
  const aliasListId = `mikke-remap-alias-${Math.random().toString(36).slice(2, 8)}`;

  let remapRows: AliasRemapRow[] = normalizeAliasRemap(settings.migrationAliasRemap);
  if (!remapRows.length) remapRows = [{ to: '', from: [] }];
  const remapBody = el('tbody', {});
  const remapNote = el('div', { style: 'margin-top:var(--s-2)' });

  /** 画面の入力値を読み替え表に取り込む (保存にも注意書きにもこれを使う)。 */
  const collectRemap = (): AliasRemapRow[] => normalizeAliasRemap(remapRows);

  function paintRemap(): void {
    clear(remapBody);
    remapRows.forEach((row, i) => {
      const toInput = el('input', {
        type: 'text', class: 'mikke-input', value: row.to, list: aliasListId,
        placeholder: '例: ENG', style: 'width:100%',
      }) as HTMLInputElement;
      toInput.addEventListener('input', () => { row.to = toInput.value; paintRemapNote(); });
      const fromTa = el('textarea', {
        class: 'mikke-input', rows: '3', spellcheck: 'false',
        placeholder: '旧略称を 1 行 1 件',
        style: 'width:100%;font-size:var(--fs-sm);line-height:1.6',
      }, [row.from.join('\n')]) as HTMLTextAreaElement;
      fromTa.addEventListener('input', () => { row.from = parseAliases(fromTa.value); paintRemapNote(); });
      const del = el('button', { class: 'mikke-btn mikke-btn--ghost', type: 'button', title: 'この行を削除' }, ['削除']);
      del.addEventListener('click', () => {
        remapRows.splice(i, 1);
        if (!remapRows.length) remapRows.push({ to: '', from: [] });
        paintRemap(); paintRemapNote();
      });
      remapBody.appendChild(el('tr', {}, [
        el('td', { style: 'vertical-align:top;width:16em' }, [toInput]),
        el('td', { style: 'vertical-align:top' }, [fromTa]),
        el('td', { style: 'vertical-align:top;width:5em;text-align:right' }, [del]),
      ]));
    });
  }

  /** 表の下に出す注意書き。読み替え先が未登録・旧略称の重複はここで気づく。 */
  function paintRemapNote(): void {
    clear(remapNote);
    const rows = collectRemap();
    const lower = new Set(knownAliases.map((a) => a.toLowerCase()));
    const unknownTo = [...new Set(
      rows.filter((r) => r.from.length && !lower.has(r.to.toLowerCase())).map((r) => r.to),
    )];
    const conflicts = remapConflicts(rows);
    if (unknownTo.length) {
      remapNote.appendChild(el('div', { class: 'mikke-error' }, [
        `読み替え先がアクセス権画面に無い略称です: ${unknownTo.join(' / ')}`,
        el('br'),
        'このままだと読み替えても事業会社を引けません。アクセス権画面で略称を登録してください。',
      ]));
    }
    if (conflicts.length) {
      remapNote.appendChild(el('div', { class: 'mikke-error', style: 'margin-top:var(--s-2)' }, [
        `同じ旧略称が複数の読み替え先に書かれています (先に書いた行が使われます): ${
          conflicts.map((c) => `${c.from} → ${c.to.join(' / ')}`).join('、')}`,
      ]));
    }
  }

  const addRemapBtn = el('button', { class: 'mikke-btn', type: 'button' }, ['行を追加']);
  addRemapBtn.addEventListener('click', () => {
    remapRows.push({ to: '', from: [] });
    paintRemap();
  });

  const body = el('div', {}, [
    el('div', { class: 'mikke-note', style: 'margin-bottom:var(--s-4)' }, [
      '移行データに組織再編前の略称で書かれている行があるときに、現在の略称へ読み替えます。',
      el('br'),
      '1 行につき、現在の略称 1 件に対して旧略称を何件でも書けます。',
      el('br'),
      '★ 国内の「データ移行 (Excel)」と「海外データ移行 (Excel)」の両方で、この表を使います。',
    ]),
    el('ul', { style: 'margin:0 0 var(--s-5);padding-left:1.2em;font-size:var(--fs-sm);color:var(--ink-2);line-height:1.8' }, [
      el('li', {}, ['大文字・小文字は区別しません。']),
      el('li', {}, ['読み替えは 1 段だけです (A→B と B→C を書いても A は B までで止まります)。']),
      el('li', {}, ['同じ旧略称を複数行に書いた場合は、先に書いた行が使われます。']),
      el('li', {}, ['読み替え先の略称は、アクセス権画面で事業会社に登録しておいてください。']),
      el('li', {}, ['「保存」で保存します。直したあとは、移行の画面で Excel を読み直してください。']),
    ]),
    el('datalist', { id: aliasListId }, knownAliases.map((a) => el('option', { value: a }))),
    el('table', { class: 'mikke-table', style: 'width:100%;table-layout:fixed' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', {}, ['現在の略称']),
        el('th', {}, ['旧略称 (1 行 1 件)']),
        el('th', {}, ['']),
      ])]),
      remapBody,
    ]),
    el('div', { style: 'margin-top:var(--s-3)' }, [addRemapBtn]),
    remapNote,
  ]);

  paintRemap();
  paintRemapNote();

  return {
    body,
    save: async () => {
      const rows = collectRemap();
      // ★ 保存直前に読み直す。移行画面など他の画面で保存された内容を巻き戻さない。
      const latest = await getRepo().getSettings();
      await getRepo().saveSettings({ ...latest, migrationAliasRemap: rows });
      toast(root, `旧略称の読み替えを保存しました (${rows.filter((r) => r.from.length).length} 件)`, 'ok');
    },
  };
}
