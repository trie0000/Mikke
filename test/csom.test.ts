import { describe, it, expect } from 'vitest';
import { buildReorderFieldsXml, processQueryError } from '../src/api/sp/csom';

describe('csom: 列の並べ替え (ProcessQuery)', () => {
  const xml = buildReorderFieldsXml('MyList', '0x0100ABC', ['ContentType', 'Title', 'Note']);

  it('Reorder は FieldLinks (ObjectPathId=10) に対して呼ぶ', () => {
    expect(xml).toContain('<Method Name="Reorder" Id="100" ObjectPathId="10">');
    expect(xml).toContain('<Property Id="10" ParentId="9" Name="FieldLinks" />');
  });

  it('Reorder のあとに ContentType.Update(false) を呼ぶ (呼ばないと保存されない)', () => {
    const reorderAt = xml.indexOf('Name="Reorder"');
    const updateAt = xml.indexOf('Name="Update"');
    expect(reorderAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(reorderAt);
    expect(xml).toContain('<Method Name="Update" Id="101" ObjectPathId="9">');
    expect(xml).toContain('<Parameter Type="Boolean">false</Parameter>');
  });

  it('ObjectPaths は Current → Web → Lists → ContentTypes と辿る (Identity 不要)', () => {
    expect(xml).toContain('TypeId="{3747adcd-a3c3-41b9-bfab-4a64dd2f1e0a}" Name="Current"');
    expect(xml).toContain('<Property Id="5" ParentId="4" Name="Web" />');
    expect(xml).toContain('<Property Id="6" ParentId="5" Name="Lists" />');
    expect(xml).toContain('<Property Id="8" ParentId="7" Name="ContentTypes" />');
    expect(xml).not.toContain('<Identity');
  });

  it('列名は指定した順に並ぶ', () => {
    const names = [...xml.matchAll(/<Object Type="String">([^<]*)<\/Object>/g)].map((m) => m[1]);
    expect(names).toEqual(['ContentType', 'Title', 'Note']);
  });

  it('リスト名・列名の記号をエスケープする', () => {
    const s = buildReorderFieldsXml('A&B<C', '0x01', ['x"y']);
    expect(s).toContain('<Parameter Type="String">A&amp;B&lt;C</Parameter>');
    expect(s).toContain('<Object Type="String">x&quot;y</Object>');
  });
});

describe('csom: ProcessQuery の応答判定', () => {
  it('ErrorInfo が null なら成功', () => {
    expect(processQueryError('[{"SchemaVersion":"15.0.0.0","ErrorInfo":null}]')).toBeNull();
  });

  it('ErrorInfo があればメッセージを返す', () => {
    const body = '[{"ErrorInfo":{"ErrorMessage":"Field not found."}}]';
    expect(processQueryError(body)).toBe('Field not found.');
  });

  it('JSON でない応答はエラー扱い (握りつぶさない)', () => {
    expect(processQueryError('<html>error</html>')).not.toBeNull();
  });
});
