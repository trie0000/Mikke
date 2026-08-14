// F2: 既存管理対象の編集モーダル。
//
// ★ 並びは明細の「事業会社記入欄」タブと同じ (RESPONSE_FIELD_ORDER)。
//   同じ項目を画面ごとに違う順で並べると、記入漏れの原因になる。
// ★ 検知状況は読み取り専用 (取込が管理)。
import { el } from '../utils/dom';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { diffManagedIssue } from '../lib/issueChangeLog';
import { MGMT_STATUSES } from '../types';
import { normalizePerms, registeredCompanies } from '../lib/itemPerms';
import { LABEL, RESPONSE_SECTION } from '../lib/fieldLabels';
import type { ManagedIssue, MgmtStatus } from '../types';

export function openEditModal(root: HTMLElement, issue: ManagedIssue, onSaved: () => void): void {
  // ★ 事業会社は自由入力にしない。アクセス権 (連携用リストの権限) の割当キーなので、
  //   表記ゆれがあるとその会社のグループに権限が付かない。登録済みの一覧から選ぶ。
  const bizSel = el('select', {}, [
    el('option', { value: '' }, ['（未設定）']),
  ]) as HTMLSelectElement;
  void (async () => {
    let names: string[] = [];
    try { names = registeredCompanies(normalizePerms((await getRepo().getSettings()).vulnResponsePerms)); }
    catch { /* 取れなければ現在値だけ選べる状態にする */ }
    const cur = (issue.businessCompany ?? '').trim();
    // 一覧から消えた会社が入っている場合も選択を保てるようにしておく
    if (cur && !names.includes(cur)) names = [...names, cur];
    for (const n of names) {
      bizSel.appendChild(el('option', { value: n, ...(n === cur ? { selected: 'selected' } : {}) }, [n]));
    }
    if (!names.length) {
      bizSel.appendChild(el('option', { value: '', disabled: 'disabled' },
        ['（アクセス権画面で事業会社を登録してください）']));
    }
  })();
  const affiliateCompany = el('input', {
    type: 'text', value: issue.affiliateCompany ?? '', placeholder: '例: ABC株式会社',
  }) as HTMLInputElement;

  const statusSel = el('select', {}, MGMT_STATUSES.map((s) =>
    el('option', { value: s, ...(s === issue.mgmtStatus ? { selected: 'selected' } : {}) }, [s]),
  )) as HTMLSelectElement;

  const oosCheck = el('input', {
    type: 'checkbox', ...(issue.isOutOfScope ? { checked: 'checked' } : {}),
  }) as HTMLInputElement;

  const oosReason = el('textarea', { placeholder: '対象外の理由' }, [issue.outOfScopeReason ?? '']) as HTMLTextAreaElement;
  const assignee = el('input', { type: 'text', value: issue.assignee ?? '' }) as HTMLInputElement;
  const extConnAppId = el('input', {
    type: 'text', value: issue.extConnAppId ?? '', placeholder: '例: EXT-2026-045',
  }) as HTMLInputElement;
  const legacyMgmtNumber = el('input', {
    type: 'text', value: issue.legacyMgmtNumber ?? '', placeholder: '例: 事業会社名-2606-01',
  }) as HTMLInputElement;
  const due = el('input', { type: 'date', value: (issue.dueDate ?? '').slice(0, 10) }) as HTMLInputElement;
  const note = el('textarea', { style: 'min-height:120px' }, [issue.mgmtNote ?? '']) as HTMLTextAreaElement;

  // ── 事業会社記入欄 (連携用リストで事業会社が書く項目。ここからも直せる) ──
  const area = (v: string, ph = ''): HTMLTextAreaElement =>
    el('textarea', { style: 'min-height:72px', ...(ph ? { placeholder: ph } : {}) }, [v]) as HTMLTextAreaElement;
  const noAppReason = area(issue.noAppReason ?? '');
  const responsePlan = area(issue.responsePlan ?? '');
  const completionReason = area(issue.completionReason ?? '');
  const responseRemarks = area(issue.responseRemarks ?? '');
  // ★ 対応経緯は連携用リストではリッチテキスト。ここは素のテキストで編集する。
  //   タグを見せないよう本文だけ出し、**書き換えたときだけ** 保存する
  //   (開いて閉じただけで相手の書式を平文に潰さないため)。
  const noteHtml = issue.responseNote ?? '';
  const notePlain = noteHtml
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
  const responseNote = area(notePlain);

  // 対象外チェックと MgmtStatus=対象外 を連動
  oosCheck.addEventListener('change', () => {
    if (oosCheck.checked) statusSel.value = '対象外';
  });

  const field = (label: string, control: HTMLElement) =>
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, [label]),
      control,
    ]);

  const head = (title: string, desc = ''): HTMLElement =>
    el('div', { style: 'margin:var(--s-6) 0 var(--s-3);padding-bottom:var(--s-2);border-bottom:1px solid var(--line)' }, [
      el('div', { style: 'font-weight:700' }, [title]),
      ...(desc ? [el('div', { style: 'font-size:var(--fs-sm);color:var(--ink-3);margin-top:2px' }, [desc])] : []),
    ]);

  const body = el('div', {}, [
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, [`${LABEL.detectionStatus} (取込が自動管理 / 編集不可)`]),
      el('div', {}, [issue.detectionStatus]),
    ]),

    // ★ 並びは明細の「事業会社記入欄」タブと同じ。
    head(RESPONSE_SECTION, '連携用リストで事業会社が記入する項目です。ここで直すと次の反映で上書きできます。'),
    field(LABEL.responseStatus, statusSel),
    field(LABEL.responder, assignee),
    field(LABEL.extConnAppId, extConnAppId),
    field(LABEL.noAppReason, noAppReason),
    field(LABEL.responseDueDate, due),
    field(LABEL.responsePlan, responsePlan),
    field(LABEL.responseNote, responseNote),
    field(LABEL.completionReason, completionReason),
    field(LABEL.responseRemarks, responseRemarks),

    head('管理情報', 'Mikke の中だけで使う項目です。連携用リストには出ません。'),
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, [
        oosCheck, el('span', { style: 'margin-left:6px' }, ['管理対象外にする']),
      ]),
    ]),
    field('対象外の理由', oosReason),
    field(`${LABEL.businessCompany} (アクセス権画面で登録した一覧から選択)`, bizSel),
    field(LABEL.affiliateCompany, affiliateCompany),
    // 移行期間中だけの参考情報。将来この列ごと廃止する。
    field(`${LABEL.legacyMgmtNumber} (Excel 運用時の暫定 ID。移行期間中のみ)`, legacyMgmtNumber),
    field(LABEL.mgmtNote, note),
  ]);

  openModal(root, {
    title: `編集 — #${issue.id} ${issue.title}`,
    body,
    size: 'lg',
    primaryLabel: '保存',
    onPrimary: async () => {
      const isOos = oosCheck.checked;
      const patch: Partial<ManagedIssue> = {
        mgmtStatus: statusSel.value as MgmtStatus,
        isOutOfScope: isOos,
        outOfScopeReason: isOos ? oosReason.value.trim() : '',
        assignee: assignee.value.trim(),
        businessCompany: bizSel.value.trim(),
        affiliateCompany: affiliateCompany.value.trim(),
        extConnAppId: extConnAppId.value.trim(),
        legacyMgmtNumber: legacyMgmtNumber.value.trim(),
        dueDate: due.value ? new Date(due.value).toISOString() : '',
        mgmtNote: note.value,
        noAppReason: noAppReason.value.trim(),
        responsePlan: responsePlan.value.trim(),
        completionReason: completionReason.value.trim(),
        responseRemarks: responseRemarks.value.trim(),
      };
      // ★ 対応経緯は書き換えたときだけ送る。開いて閉じただけで、
      //   相手が書いたリッチテキストを平文に潰さないため。
      if (responseNote.value.trim() !== notePlain) patch.responseNote = responseNote.value.trim();
      if (isOos && !patch.outOfScopeReason) {
        toast(root, '対象外にする場合は理由を入力してください', 'warn');
        throw new Error('reason required');
      }
      // 実際に変わった管理項目 (項目名・更新前・更新後) を更新履歴に記録する。
      const changes = diffManagedIssue(issue, patch);
      try {
        await getRepo().updateIssue(issue.id, patch);
      } catch (e) {
        // モーダルは開いたまま (modal.ts が throw で残す) にして再試行できるよう、
        // ここで失敗理由をトースト表示してから rethrow する。
        toast(root, `保存に失敗しました: ${(e as Error).message}`, 'error');
        throw e;
      }
      if (changes.length) {
        try {
          await getRepo().createChangeLog({
            issueInstanceId: issue.issueInstanceId,
            changedAt: new Date().toISOString(),
            changes,
          });
        } catch { /* 履歴記録の失敗は保存自体を妨げない */ }
      }
      toast(root, '保存しました', 'ok');
      onSaved();
    },
  });
}
