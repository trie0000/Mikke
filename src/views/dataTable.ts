// 汎用データテーブル。管理対象一覧・資産管理など複数の表で共用する。
// 機能: 列ヘッダの Excel 風フィルタ (除外セット) / 並べ替え / 全文表示トグル /
//       仮想スクロール / 列幅リサイズ / 列のドラッグ並び替え。
// 端末ごとの状態 (列順・列幅・列フィルタ・全文表示・並べ替え) は storeKey 別に
// localStorage へ保存する。UI 骨格は el/icon に依存。
import { el, clear } from '../utils/dom';
import { icon } from '../icons';

export interface DataColumn<T> {
  id: string;
  label: string;
  width?: number;
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
  text: (row: T) => string;
  render?: (row: T) => HTMLElement | string;
  cellStyle?: string;
  filterable?: boolean;
}

export interface DataTableSelection<T> {
  checked: (row: T) => boolean;
  onToggle: (row: T, on: boolean) => void;
  onToggleAll: (on: boolean, visible: T[]) => void;
}

export interface DataTableOptions<T> {
  /** localStorage キーの接頭辞 (表ごとに一意)。 */
  storeKey: string;
  columns: DataColumn<T>[];
  rowId: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  rowSelected?: (row: T) => boolean;
  selection?: DataTableSelection<T>;
  onVisibleChange?: (visible: T[]) => void;
  virtualMin?: number;
  emptyText?: string;
}

const VBUF = 12;
const ROW_H_DEFAULT = 40;

function lsGet<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function lsSet(key: string, val: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* noop */ }
}

export class DataTable<T> {
  private container: HTMLElement;
  private opts: DataTableOptions<T>;
  private rows: T[] = [];
  private visible: T[] = [];

  private colWidths: Record<string, number>;
  private colExcluded: Record<string, string[]>;
  private colOrder: string[];
  private wrapOn: boolean;
  private sortId: string | null;
  private sortDir: 'asc' | 'desc';

  // 仮想スクロール
  private vWin: T[] = [];
  private vCols: DataColumn<T>[] = [];
  private vRowH = ROW_H_DEFAULT;
  private vVirtual = false;
  private vTop: HTMLElement | null = null;
  private vBot: HTMLElement | null = null;
  private vTbody: HTMLElement | null = null;
  private vLastStart = -1;
  private rafPending = false;

  private headCheck: HTMLInputElement | null = null;
  private openMenu: HTMLElement | null = null;
  private openMenuCol: string | null = null;
  private keepMenuOnRender = false;   // フィルタ適用時に列メニューを閉じない
  private menuDocHandler: (() => void) | null = null;

  constructor(container: HTMLElement, opts: DataTableOptions<T>) {
    this.container = container;
    this.opts = opts;
    const k = opts.storeKey;
    this.colWidths = lsGet(`${k}.colWidths`, {} as Record<string, number>);
    this.colExcluded = lsGet(`${k}.colFilters`, {} as Record<string, string[]>);
    this.colOrder = lsGet(`${k}.colOrder`, [] as string[]);
    this.wrapOn = lsGet(`${k}.wrap`, false);
    const sort = lsGet<{ id: string | null; dir: 'asc' | 'desc' }>(`${k}.sort`, { id: null, dir: 'asc' });
    this.sortId = sort.id;
    this.sortDir = sort.dir;

    container.addEventListener('scroll', () => {
      if (!this.vVirtual) return;
      if (this.rafPending) return;
      this.rafPending = true;
      requestAnimationFrame(() => {
        this.rafPending = false;
        const start = Math.max(0, Math.floor(this.container.scrollTop / this.vRowH) - VBUF);
        if (start !== this.vLastStart) this.paintWindow();
      });
    });
  }

  // ── 公開 API ────────────────────────────────────────────────────────────────
  setRows(rows: T[]): void { this.rows = rows; }
  setColumns(cols: DataColumn<T>[]): void { this.opts.columns = cols; }
  getVisible(): T[] { return this.visible; }
  isWrap(): boolean { return this.wrapOn; }
  toggleWrap(): void { this.wrapOn = !this.wrapOn; lsSet(`${this.opts.storeKey}.wrap`, this.wrapOn); this.render(); }
  hasActiveFilters(): boolean { return Object.values(this.colExcluded).some((a) => a.length); }
  clearFilters(): void {
    this.colExcluded = {};
    lsSet(`${this.opts.storeKey}.colFilters`, this.colExcluded);
    this.render();
  }
  updateHeaderCheckbox(): void {
    if (!this.headCheck || !this.opts.selection) return;
    const sel = this.opts.selection;
    const total = this.visible.length;
    const on = this.visible.filter((r) => sel.checked(r)).length;
    this.headCheck.checked = total > 0 && on === total;
    this.headCheck.indeterminate = on > 0 && on < total;
  }

  // ── 列順 ────────────────────────────────────────────────────────────────────
  private orderedColumns(): DataColumn<T>[] {
    const byId = new Map(this.opts.columns.map((c) => [c.id, c]));
    const out: DataColumn<T>[] = [];
    for (const id of this.colOrder) { const c = byId.get(id); if (c) { out.push(c); byId.delete(id); } }
    for (const c of this.opts.columns) if (byId.has(c.id)) out.push(c); // 未登録(新規)列は末尾
    return out;
  }

  // ── フィルタ・ソート ──────────────────────────────────────────────────────────
  private computeVisible(columns: DataColumn<T>[]): T[] {
    const active = columns.filter((c) => (this.colExcluded[c.id]?.length ?? 0) > 0);
    let rows = active.length
      ? this.rows.filter((r) => !active.some((c) => this.colExcluded[c.id]!.includes(c.text(r))))
      : this.rows.slice();
    if (this.sortId) {
      const col = columns.find((c) => c.id === this.sortId);
      if (col) {
        const dir = this.sortDir === 'asc' ? 1 : -1;
        const val = col.sortValue ?? ((r: T) => col.text(r));
        rows = rows.slice().sort((a, b) => {
          const ka = val(a), kb = val(b);
          if (ka < kb) return -1 * dir;
          if (ka > kb) return 1 * dir;
          return 0;
        });
      }
    }
    return rows;
  }
  private setSort(id: string, dir: 'asc' | 'desc'): void {
    this.sortId = id; this.sortDir = dir;
    lsSet(`${this.opts.storeKey}.sort`, { id, dir });
    this.render();
  }

  // ── 描画 ────────────────────────────────────────────────────────────────────
  render(): void {
    // フィルタ適用による再描画では列メニューを閉じない (QAM 挙動)。
    if (this.keepMenuOnRender) this.keepMenuOnRender = false;
    else this.closeMenu();
    clear(this.container);
    this.vVirtual = false; this.vTop = this.vBot = this.vTbody = null;

    const columns = this.orderedColumns();
    this.visible = this.computeVisible(columns);
    this.opts.onVisibleChange?.(this.visible);

    if (this.rows.length === 0) {
      this.container.appendChild(el('div', { class: 'mikke-empty' }, [this.opts.emptyText ?? 'データがありません。']));
      return;
    }

    const table = el('table', { class: 'mikke-table' + (this.wrapOn ? ' mikke-wrap' : '') }) as HTMLTableElement;
    const widthList: { th: HTMLElement; key: string; width: number }[] = [];
    const headCells: HTMLElement[] = [];

    if (this.opts.selection) {
      const sel = this.opts.selection;
      this.headCheck = el('input', {
        type: 'checkbox', 'aria-label': '表示中の全行を選択',
        onchange: (e: Event) => { sel.onToggleAll((e.target as HTMLInputElement).checked, this.visible); },
      }) as HTMLInputElement;
      const checkTh = el('th', { class: 'mikke-check-col' }, [this.headCheck]);
      widthList.push({ th: checkTh, key: '_check', width: 40 });
      headCells.push(checkTh);
    }

    for (const col of columns) {
      const activeSort = this.sortId === col.id;
      const arrow = activeSort ? (this.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      const hasFilter = (this.colExcluded[col.id]?.length ?? 0) > 0;
      const th = el('th', { title: 'クリックで並べ替え/絞り込み・ドラッグで列移動' }, [
        col.label + arrow,
        el('span', {
          class: 'mikke-th-caret' + (hasFilter ? ' mikke-th-active' : ''),
          html: hasFilter ? icon('filter') : icon('chevronDown'),
        }),
      ]);
      this.attachColResize(th, col.id, table);
      this.attachColDrag(th, col, table, columns);
      widthList.push({ th, key: col.id, width: col.width ?? 140 });
      headCells.push(th);
    }
    table.appendChild(el('thead', {}, [el('tr', {}, headCells)]));

    const tbody = el('tbody');
    this.vCols = columns; this.vWin = this.visible; this.vTbody = tbody;
    const leadCount = this.opts.selection ? 1 : 0;
    this.vVirtual = this.visible.length > (this.opts.virtualMin ?? 40) && !this.wrapOn;
    if (!this.vVirtual) {
      for (const r of this.visible) tbody.appendChild(this.buildRow(r, columns));
    } else {
      const colspan = String(columns.length + leadCount);
      this.vTop = el('tr', { class: 'mikke-vspacer' }, [el('td', { colspan }, [el('div', {})])]);
      this.vBot = el('tr', { class: 'mikke-vspacer' }, [el('td', { colspan }, [el('div', {})])]);
      tbody.append(this.vTop, this.vBot);
      this.vLastStart = -1; this.vRowH = ROW_H_DEFAULT;
      this.paintWindow();
    }
    table.appendChild(tbody);
    this.container.appendChild(table);
    this.applyWidths(table, widthList);
    this.updateHeaderCheckbox();

    if (this.visible.length === 0) {
      this.container.appendChild(el('div', { class: 'mikke-empty', style: 'padding-top:var(--s-8)' }, [
        el('div', {}, ['条件に一致する行がありません（フィルタ解除で全件表示）。']),
      ]));
    }

    if (this.vVirtual) {
      requestAnimationFrame(() => {
        if (!this.vVirtual || !table.isConnected) return;
        const probe = tbody.querySelector('tr.mikke-drow') as HTMLElement | null;
        const h = probe?.offsetHeight ?? 0;
        if (h > 0 && Math.abs(h - this.vRowH) > 1) { this.vRowH = h; this.vLastStart = -1; this.paintWindow(); }
      });
    }
  }

  private buildRow(row: T, columns: DataColumn<T>[]): HTMLElement {
    const cells: HTMLElement[] = [];
    if (this.opts.selection) {
      const sel = this.opts.selection;
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = sel.checked(row);
      cb.addEventListener('change', () => { sel.onToggle(row, cb.checked); this.updateHeaderCheckbox(); });
      cells.push(el('td', { class: 'mikke-check-col', onclick: (e: Event) => e.stopPropagation() }, [cb]));
    }
    for (const col of columns) {
      cells.push(el('td', col.cellStyle ? { style: col.cellStyle } : {}, [col.render ? col.render(row) : col.text(row) || '—']));
    }
    const selectedCls = this.opts.rowSelected?.(row) ? ' is-selected' : '';
    return el('tr', {
      class: 'mikke-drow' + selectedCls,
      onclick: () => {
        const s = window.getSelection();
        if (s && s.toString()) return;
        this.opts.onRowClick?.(row);
      },
    }, cells);
  }

  // ── 仮想スクロール ──────────────────────────────────────────────────────────
  private windowRange(): [number, number] {
    const n = this.vWin.length;
    const vh = this.container.clientHeight || window.innerHeight || 800;
    let start = Math.floor(this.container.scrollTop / this.vRowH) - VBUF;
    if (start < 0) start = 0;
    let end = start + Math.ceil(vh / this.vRowH) + VBUF * 2;
    if (end > n) end = n;
    return [start, end];
  }
  private paintWindow(): void {
    if (!this.vTbody || !this.vTop || !this.vBot) return;
    const [start, end] = this.windowRange();
    this.vLastStart = start;
    (this.vTop.firstElementChild as HTMLElement).style.height = `${start * this.vRowH}px`;
    (this.vBot.firstElementChild as HTMLElement).style.height = `${(this.vWin.length - end) * this.vRowH}px`;
    let node = this.vTop.nextSibling;
    while (node && node !== this.vBot) { const next = node.nextSibling; this.vTbody.removeChild(node); node = next; }
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.append(this.buildRow(this.vWin[i]!, this.vCols));
    this.vTbody.insertBefore(frag, this.vBot);
  }

  // ── 列幅リサイズ ──────────────────────────────────────────────────────────
  private applyWidths(table: HTMLTableElement, ths: { th: HTMLElement; key: string; width: number }[]): void {
    let total = 0;
    for (const { th, key, width } of ths) {
      const w = this.colWidths[key] ?? width;
      th.style.width = `${w}px`;
      total += w;
    }
    table.style.tableLayout = 'fixed';
    table.style.width = `${total}px`;
  }
  private attachColResize(th: HTMLElement, key: string, table: HTMLTableElement): void {
    const grip = el('span', { class: 'mikke-col-grip', 'aria-hidden': 'true' });
    grip.addEventListener('click', (e) => e.stopPropagation());
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      const startTableW = table.getBoundingClientRect().width;
      const move = (ev: PointerEvent): void => {
        const w = Math.max(48, Math.round(startW + (ev.clientX - startX)));
        th.style.width = `${w}px`;
        table.style.width = `${Math.round(startTableW + (w - startW))}px`;
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.colWidths[key] = Math.round(th.getBoundingClientRect().width);
        lsSet(`${this.opts.storeKey}.colWidths`, this.colWidths);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    th.appendChild(grip);
  }

  // ── 列ドラッグ並び替え + クリックでメニュー ────────────────────────────────────
  // native draggable は all:initial オーバーレイで効かないため pointer で実装。
  // 閾値未満の移動で離したら「クリック=メニュー」、超えたら「並び替え」。
  private attachColDrag(th: HTMLElement, col: DataColumn<T>, table: HTMLTableElement, columns: DataColumn<T>[]): void {
    th.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).classList.contains('mikke-col-grip')) return;
      const startX = e.clientX;
      let dragging = false;
      let marker: HTMLElement | null = null;
      const thead = table.querySelector('thead') as HTMLElement;
      const move = (ev: PointerEvent): void => {
        if (!dragging && Math.abs(ev.clientX - startX) < 5) return;
        if (!dragging) {
          dragging = true;
          th.classList.add('mikke-th-dragging');
          marker = el('div', { class: 'mikke-col-dropline' });
          this.container.closest('#mikke-root')!.appendChild(marker);
        }
        const target = this.thUnderX(table, ev.clientX);
        if (marker && target) {
          const r = target.th.getBoundingClientRect();
          const tr = thead.getBoundingClientRect();
          const after = ev.clientX > r.left + r.width / 2;
          marker.style.left = `${after ? r.right : r.left}px`;
          marker.style.top = `${tr.top}px`;
          marker.style.height = `${tr.height}px`;
        }
      };
      const up = (ev: PointerEvent): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        th.classList.remove('mikke-th-dragging');
        marker?.remove();
        if (!dragging) { this.openColMenu(th, col); return; }
        const target = this.thUnderX(table, ev.clientX);
        if (target && target.col.id !== col.id) {
          const r = target.th.getBoundingClientRect();
          const after = ev.clientX > r.left + r.width / 2;
          this.reorder(columns, col.id, target.col.id, after);
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
  private thUnderX(table: HTMLTableElement, x: number): { th: HTMLElement; col: DataColumn<T> } | null {
    const ths = [...table.querySelectorAll('thead th')] as HTMLElement[];
    const cols = this.orderedColumns();
    const lead = this.opts.selection ? 1 : 0;
    for (let i = lead; i < ths.length; i++) {
      const r = ths[i]!.getBoundingClientRect();
      if (x >= r.left && x <= r.right) return { th: ths[i]!, col: cols[i - lead]! };
    }
    return null;
  }
  private reorder(columns: DataColumn<T>[], fromId: string, toId: string, after: boolean): void {
    const ids = columns.map((c) => c.id).filter((id) => id !== fromId);
    let idx = ids.indexOf(toId);
    if (idx < 0) return;
    if (after) idx += 1;
    ids.splice(idx, 0, fromId);
    this.colOrder = ids;
    lsSet(`${this.opts.storeKey}.colOrder`, ids);
    this.render();
  }

  // ── 列メニュー (並べ替え + Excel 風フィルタ) ──────────────────────────────────
  private closeMenu(): void {
    if (this.menuDocHandler) { document.removeEventListener('mousedown', this.menuDocHandler); this.menuDocHandler = null; }
    if (this.openMenu) { this.openMenu.remove(); this.openMenu = null; }
    this.openMenuCol = null;
  }
  private openColMenu(th: HTMLElement, col: DataColumn<T>): void {
    if (this.openMenuCol === col.id) { this.closeMenu(); return; }
    this.closeMenu();
    this.openMenuCol = col.id;
    const rect = th.getBoundingClientRect();
    const ex = new Set(this.colExcluded[col.id] ?? []);
    const filterable = col.filterable !== false;
    const values = filterable ? [...new Set(this.rows.map((r) => col.text(r)))].sort((a, b) => a.localeCompare(b)) : [];
    const capped = values.slice(0, 2000);

    const menu = el('div', { class: 'mikke-colmenu' });
    if (col.sortable !== false) {
      menu.append(
        el('button', { class: 'mikke-colmenu-act', onclick: () => { this.closeMenu(); this.setSort(col.id, 'asc'); } },
          [el('span', { html: icon('chevronDown'), style: 'display:inline-flex;transform:rotate(180deg)' }), el('span', {}, ['昇順で並べ替え'])]),
        el('button', { class: 'mikke-colmenu-act', onclick: () => { this.closeMenu(); this.setSort(col.id, 'desc'); } },
          [el('span', { html: icon('chevronDown'), style: 'display:inline-flex' }), el('span', {}, ['降順で並べ替え'])]),
      );
      if (filterable) menu.appendChild(el('div', { class: 'mikke-colmenu-sep' }));
    }
    if (filterable) {
      const search = el('input', { class: 'mikke-colmenu-search', type: 'text', placeholder: '値を検索' }) as HTMLInputElement;
      const allCb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      const listWrap = el('div', { class: 'mikke-colmenu-vlist' });
      if (values.length > 2000) menu.appendChild(el('div', { class: 'mikke-colmenu-note' }, [`先頭 2000 件のみ表示 (全 ${values.length} 件)`]));
      // フィルタ適用: 表を再描画するが、メニューは開いたままにする (QAM 挙動)。
      const apply = (): void => {
        const arr = [...ex];
        if (arr.length) this.colExcluded[col.id] = arr; else delete this.colExcluded[col.id];
        lsSet(`${this.opts.storeKey}.colFilters`, this.colExcluded);
        this.keepMenuOnRender = true;
        this.render();
      };
      const label = (v: string): string => (v === '' ? '(空白)' : v);
      const renderList = (q: string): void => {
        const scroll = listWrap.scrollTop;
        clear(listWrap);
        const ql = q.trim().toLowerCase();
        const shown = capped.filter((v) => !ql || label(v).toLowerCase().includes(ql));
        allCb.checked = shown.length > 0 && shown.every((v) => !ex.has(v));
        allCb.indeterminate = shown.some((v) => !ex.has(v)) && shown.some((v) => ex.has(v));
        for (const v of shown) {
          const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
          cb.checked = !ex.has(v);
          cb.addEventListener('change', () => { if (cb.checked) ex.delete(v); else ex.add(v); apply(); renderList(search.value); });
          listWrap.appendChild(el('label', { class: 'mikke-colmenu-item' }, [cb, el('span', {}, [label(v)])]));
        }
        listWrap.scrollTop = scroll;
      };
      allCb.addEventListener('change', () => {
        const ql = search.value.trim().toLowerCase();
        const shown = capped.filter((v) => !ql || label(v).toLowerCase().includes(ql));
        if (allCb.checked) shown.forEach((v) => ex.delete(v)); else shown.forEach((v) => ex.add(v));
        apply(); renderList(search.value);
      });
      // 値検索: 入力に合致する値だけを「選択(チェック)」状態にして即フィルタ (QAM 挙動)。
      //  一致しない値を除外セットに入れる。空にすると全解除。Enter は確定してメニューを閉じる。
      search.addEventListener('input', () => {
        const ql = search.value.trim().toLowerCase();
        ex.clear();
        if (ql) for (const v of values) if (!label(v).toLowerCase().includes(ql)) ex.add(v);
        apply();
        renderList(search.value);
      });
      search.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); this.closeMenu(); } });
      menu.append(
        search,
        el('div', { style: 'padding:0 var(--s-2)' }, [el('label', { class: 'mikke-colmenu-item mikke-colmenu-all' }, [allCb, el('span', {}, ['(すべて選択)'])])]),
        listWrap,
      );
      renderList('');
    }

    const width = 260;
    menu.style.left = `${Math.max(6, Math.min(rect.left, window.innerWidth - width - 6))}px`;
    menu.style.top = `${Math.min(rect.bottom + 2, window.innerHeight - 120)}px`;
    menu.addEventListener('mousedown', (e) => e.stopPropagation());
    this.container.closest('#mikke-root')!.appendChild(menu);
    this.openMenu = menu;
    this.menuDocHandler = (): void => this.closeMenu();
    setTimeout(() => document.addEventListener('mousedown', this.menuDocHandler!), 0);
  }
}
