// 列の型推定。テンプレCSV (ヘッダ + サンプル1行) の各値から、管理項目の
// データ型を推定する。F6 (管理項目の選択) のテンプレート読込で使う。
//
// 注: 推定型は「管理メタdata」として settings.columnTypes に保持する。SP の
//   動的列 (Scan_*) 自体は Note(文字列) で作る方針 (型付き列に生 CSV 文字列を
//   書くと SP が 400 になるため)。型は表示整形・バリデーション・将来用途に使う。
import type { ColumnType } from '../types';

export const COLUMN_TYPES: { value: ColumnType; label: string }[] = [
  { value: 'text',     label: 'テキスト' },
  { value: 'longtext', label: '長文' },
  { value: 'number',   label: '数値' },
  { value: 'date',     label: '日付' },
  { value: 'datetime', label: '日時' },
  { value: 'boolean',  label: '真偽' },
];

const TYPE_LABELS: Record<ColumnType, string> = Object.fromEntries(
  COLUMN_TYPES.map((t) => [t.value, t.label]),
) as Record<ColumnType, string>;

export function columnTypeLabel(t: ColumnType): string {
  return TYPE_LABELS[t] ?? t;
}

/** 1 つのサンプル値から列の型を推定する。空文字は推定不能として 'text'。 */
export function inferColumnType(sample: string): ColumnType {
  const v = (sample ?? '').trim();
  if (!v) return 'text';

  // 真偽 (誤検出を避け true/false/yes/no のみ。0/1 は数値扱い)
  if (/^(true|false|yes|no)$/i.test(v)) return 'boolean';

  // 日時 (日付 + 時刻)。区切りは - か /、T か空白。
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?/.test(v)) return 'datetime';

  // 日付のみ (YYYY-MM-DD / YYYY/M/D / M/D/YYYY)
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(v)) return 'date';
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(v)) return 'date';

  // 数値 (整数 / 小数、符号 / 桁区切りカンマ許容)
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v) || /^-?\d+(\.\d+)?$/.test(v)) return 'number';

  // 長文 (SP の 1 行テキスト上限を超える長さは長文扱い)
  if (v.length > 255) return 'longtext';

  return 'text';
}

export interface TemplateColumn {
  /** 列名 (CSV ヘッダ、Scan_ 接頭辞なし)。 */
  name: string;
  /** サンプル値 (テンプレ 1 行目)。 */
  sample: string;
  /** 推定型。 */
  type: ColumnType;
}

/** ヘッダ + サンプル行から、テンプレート列定義を作る。 */
export function inferTemplate(
  headers: string[],
  sampleRow: Record<string, string> | undefined,
): TemplateColumn[] {
  return headers
    .map((h) => h.trim())
    .filter(Boolean)
    .map((name) => {
      const sample = (sampleRow?.[name] ?? '').trim();
      return { name, sample, type: inferColumnType(sample) };
    });
}
