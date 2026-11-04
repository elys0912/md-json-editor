// UC9：拡張子 .json の GeoJSON を開いて図形と properties を見る。構造の誤りと注意を見つける（基本 10）

import { describe, expect, it } from 'vitest';

import { chooseFiles, fixture, query, start, texts } from './app.ts';

describe('UC9 GeoJSON を開いて図形と properties を見る', () => {
  it('種別が geojson になり、誤りと注意をパスつきで出し、誤りの Feature は描かず、クリックで properties を出す', async () => {
    const root = await start();

    await chooseFiles(root, [fixture('shapes.json')]);

    expect(query(root, '.doc-kind-badge').textContent).toBe('geojson');
    expect(query(root, '.body').dataset.view).toBe('shape');
    expect(texts(root, '.issue-link')).toEqual([
      '$.features[0].geometry.coordinates[0]：リングの最初と最後の位置が違います',
      '注意 $.features[1].geometry.coordinates：範囲外の位置 1 個（経度 -180〜180、緯度 -90〜90）',
      '注意 $.features[2].geometry.coordinates：ポリゴンの向きが右手則と逆です（外側は反時計回り、穴は時計回り）',
    ]);

    const drawnPaths = [...root.querySelectorAll('svg g')].map((group) => group.getAttribute('data-path'));

    expect(drawnPaths).toEqual(['$.features[1]', '$.features[2]']);

    query(root, 'svg g[data-path="$.features[2]"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(query(root, '.properties-path').textContent).toBe('$.features[2]');
    expect(texts(root, '.properties-table th')).toEqual(['name']);
    expect(texts(root, '.properties-table td')).toEqual(['時計回り']);
  });

  it('構造の誤りの項目のクリックで、ツリーの該当のノードを開く', async () => {
    const root = await start();

    await chooseFiles(root, [fixture('shapes.json')]);
    query(root, '.issue-link').click();

    expect(query(root, '.body').dataset.view).toBe('tree');
    expect(query(root, '.tree-row.is-current .tree-key').textContent).toBe('0');
  });
});
