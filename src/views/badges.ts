// ステータス / 深刻度のバッジ生成。UI 設計書 §2 の色割当に準拠。
import { el } from '../utils/dom';
import type { DetectionStatus, MgmtStatus } from '../types';
import type { NotifyStatus } from '../lib/notifyStatus';

function detectionVariant(s: DetectionStatus): string {
  switch (s) {
    case '新規':
    case '再検知': return 'accent';
    case '継続': return '';
    case '未検出(New)':
    case '未検出': return 'muted';
    default: return '';
  }
}

function mgmtVariant(s: MgmtStatus): string {
  switch (s) {
    case '対応済み': return 'ok';
    case '対応中':
    case '通知': return 'warn';
    case '未通知': return 'danger';
    default: return 'muted'; // リスク受容 / 過検出 / 対象外
  }
}

function severityVariant(sev?: string): string {
  switch ((sev ?? '').toLowerCase()) {
    case 'critical': return 'danger';
    case 'high': return 'warn';
    case 'medium': return '';
    default: return 'muted';
  }
}

function badge(text: string, variant: string): HTMLElement {
  const cls = variant ? `mikke-badge mikke-badge--${variant}` : 'mikke-badge';
  return el('span', { class: cls }, [text]);
}

export function detectionBadge(s: DetectionStatus): HTMLElement { return badge(s, detectionVariant(s)); }
export function mgmtBadge(s: MgmtStatus): HTMLElement { return badge(s, mgmtVariant(s)); }
export function severityBadge(sev?: string): HTMLElement { return badge(sev || '—', severityVariant(sev)); }

/** 通知ステータス (連携用リストとの比較結果)。手当てが要るものほど強い色にする。 */
export function notifyBadge(s: NotifyStatus): HTMLElement {
  const v = s === '未通知' ? 'danger' : s === '差分あり' ? 'warn' : 'ok';
  return badge(s, v);
}
