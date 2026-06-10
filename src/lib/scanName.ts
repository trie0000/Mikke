// Scan_* 動的列の「SP 列名」生成。
//
// ★ 背景 (実機で判明した罠): SP は列作成時、表示名のスペース・日本語等を
//   内部名 (_x0020_ 等) に自動エンコードする。REST の POST/MERGE の JSON キーは
//   内部名でなければならず、表示名キー (例 "Scan_First Seen") で送ると 400 になり、
//   取込の新規追加が全件失敗 →「取り込んだのに一覧に出ない」symptom になる。
//
// 対策: SP に作る列は表示名・内部名とも「安全な ASCII 名」に統一する
//   (Scan_<ascii抜粋>_<決定的ハッシュ4桁>)。決定的なのでどの端末・いつ生成しても
//   同名になり、設定 (managedColumns の "Scan_<元名>") から常に導出できる。
//   Mikke UI 上の表示は従来どおり元の列名を使う。

/** FNV-1a 32bit ハッシュ (決定的・依存なし)。 */
export function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 元の CSV 列名 (または "Scan_<元名>") から、SP に作る安全な列名を決定的に導出する。
 * 例: "First Seen" → "Scan_FirstSeen_1a2b" / "深刻度" → "Scan__c3d4"
 */
export function scanFieldName(col: string): string {
  const base = col.replace(/^Scan_/, '');
  const ascii = base.replace(/[^A-Za-z0-9]/g, '').slice(0, 18);
  return `Scan_${ascii}_${fnv1aHex(base).slice(0, 4)}`;
}

/**
 * 列名リスト ("Scan_<元名>" でも元名そのままでも可) から、SP 列名 → 表示名 (元名)
 * の逆引きマップを作る。詳細画面などで SP から来た安全名キーを元名で表示する用。
 */
export function scanDisplayMap(columns: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of columns) {
    out[scanFieldName(c)] = c.replace(/^Scan_/, '');
  }
  return out;
}

/**
 * SP 内部名のエンコード (_x0020_ 等) を文字に戻す。
 * 旧形式 (表示名のまま作成され内部名がエンコードされた列) のキーを、
 * 人が読めるラベルとして表示するための救済用。
 * 例: "x005F_First_x0020_Seen" → "_First Seen"
 */
export function decodeSpInternalName(s: string): string {
  return s.replace(/_?x([0-9a-fA-F]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
