// 検知ステータス (DetectionStatus) の遷移ロジック。
// 機能設計書 §2-6 に準拠。取込が自動で設定する。
import type { DetectionStatus } from '../types';

/** CSV に存在する既存 Issue の検知ステータスを更新 (継続検知 / 再検知)。
 *  - 前回が未検出系 → 「再検知」
 *  - それ以外 (新規/継続/再検知) → 「継続」 */
export function nextDetectionWhenPresent(prev: DetectionStatus): DetectionStatus {
  if (prev === '未検出(New)' || prev === '未検出') return '再検知';
  return '継続';
}

/** CSV から消えた既存 Issue の検知ステータスを更新 (未検出化)。
 *  - 前回が検知系 (新規/継続/再検知) → 「未検出(New)」 (消えた初月)
 *  - 前回が未検出系 → 「未検出」 (翌月以降) */
export function nextDetectionWhenAbsent(prev: DetectionStatus): DetectionStatus {
  if (prev === '未検出(New)' || prev === '未検出') return '未検出';
  return '未検出(New)';
}

/** 未検出系か (デフォルト一覧で隠す判定に使う)。 */
export function isUndetected(s: DetectionStatus): boolean {
  return s === '未検出(New)' || s === '未検出';
}

/** 検知系か (新規 / 継続 / 再検知)。 */
export function isDetected(s: DetectionStatus): boolean {
  return s === '新規' || s === '継続' || s === '再検知';
}

/** 固定モードで CSV から消えた既存 Issue の検知ステータスを更新。
 *  - 検知系 (新規/継続/再検知) → 「未検出(New)」
 *  - 未検出系 (未検出(New)/未検出) → 据え置き (変化なし)
 *  固定モードでは present 側はステータス据え置き (呼び出し側で detectionStatus を触らない)。 */
export function fixedNextDetectionWhenAbsent(prev: DetectionStatus): DetectionStatus {
  return isDetected(prev) ? '未検出(New)' : prev;
}
