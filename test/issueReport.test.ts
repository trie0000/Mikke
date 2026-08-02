import { describe, it, expect } from 'vitest';
import { isAdapterMissing, ISSUE_REPORT_SUBFOLDER } from '../src/lib/issueReport';

describe('issueReport: アダプタ未配置の判定', () => {
  it('501 は未配置 (レポート取得だけスキップして情報更新は続ける)', () => {
    const e = Object.assign(new Error('adapter_not_implemented'), { status: 501 });
    expect(isAdapterMissing(e)).toBe(true);
  });

  it('メッセージに「未配置」「未実装」「adapter」があれば未配置扱い', () => {
    expect(isAdapterMissing(new Error('mikke-scanner-adapter.ps1 が未配置です'))).toBe(true);
    expect(isAdapterMissing(new Error('個別レポート取得は未実装'))).toBe(true);
    expect(isAdapterMissing(new Error('adapter_error'))).toBe(true);
  });

  it('通常のエラー (502/タイムアウト等) は未配置ではない = 件数を失敗に数える', () => {
    expect(isAdapterMissing(Object.assign(new Error('timeout'), { status: 502 }))).toBe(false);
    expect(isAdapterMissing(new Error('HTTP 500'))).toBe(false);
    expect(isAdapterMissing(undefined)).toBe(false);
  });
});

describe('issueReport: 保存先', () => {
  it('一括ダウンロードと混ざらないサブフォルダに保存する', () => {
    expect(ISSUE_REPORT_SUBFOLDER).toBe('issues');
  });
});
