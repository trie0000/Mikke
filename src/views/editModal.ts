// F2: 既存管理対象の編集モーダル。MgmtStatus / 対象外 / 担当 / 期限 / メモ を編集。
// DetectionStatus は読み取り専用 (取込が管理)。
import { el } from '../utils/dom';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { diffManagedIssue } from '../lib/issueChangeLog';
import { MGMT_STATUSES } from '../types';
import type { ManagedIssue, MgmtStatus } from '../types';

export function openEditModal(root: HTMLElement, issue: ManagedIssue, onSaved: () => void): void {
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

  // 対象外チェックと MgmtStatus=対象外 を連動
  oosCheck.addEventListener('change', () => {
    if (oosCheck.checked) statusSel.value = '対象外';
  });

  const field = (label: string, control: HTMLElement) =>
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, [label]),
      control,
    ]);

  const body = el('div', {}, [
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, ['検知ステータス (取込が自動管理 / 編集不可)']),
      el('div', {}, [issue.detectionStatus]),
    ]),
    field('対応ステータス', statusSel),
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, [
        oosCheck, el('span', { style: 'margin-left:6px' }, ['管理対象外にする']),
      ]),
    ]),
    field('対象外の理由', oosReason),
    field('外部接続申請ID', extConnAppId),
    // 移行期間中だけの参考情報。将来この列ごと廃止する。
    field('旧管理番号 (Excel 運用時の暫定 ID。移行期間中のみ)', legacyMgmtNumber),
    field('担当者', assignee),
    field('対応期限', due),
    field('メモ', note),
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
        extConnAppId: extConnAppId.value.trim(),
        legacyMgmtNumber: legacyMgmtNumber.value.trim(),
        dueDate: due.value ? new Date(due.value).toISOString() : '',
        mgmtNote: note.value,
      };
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
