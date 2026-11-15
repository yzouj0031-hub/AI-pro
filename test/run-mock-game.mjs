// 用假模型跑完整局，检查流程不卡死、胜负判定正确、死人不再行动。
import { buildGame } from './helpers.mjs';
import assert from 'node:assert/strict';

let games = 0;
for (const n of [6, 7, 8, 9, 10, 12]) {
  for (let seed = 1; seed <= 6; seed++) {
    const g = buildGame({ n, seed, cfg: { winMode: seed % 2 ? 'side' : 'all' } });
    const winner = await g.run();
    assert.ok(['wolf', 'village', 'draw'].includes(winner), `winner=${winner}`);
    // 死人不说话、不投票
    const deadAt = new Map();
    for (const e of g.log) {
      if (e.type === 'speech' && !e.lastWords) {
        const p = g.players.find(x => x.seat === e.seat);
        assert.ok(p, 'speaker exists');
      }
    }
    const dead = new Set();
    for (const e of g.log) {
      if (e.type === 'death') dead.add(e.seat);
      if (e.type === 'vote') for (const voter of Object.keys(e.votes)) assert.ok(!dead.has(+voter), `dead player ${voter} voted on day ${e.day}`);
      if (e.type === 'speech' && !e.lastWords) assert.ok(!dead.has(e.seat), `dead player ${e.seat} spoke on day ${e.day}`);
      if (e.type === 'wolf-chat') assert.ok(!dead.has(e.seat), `dead wolf ${e.seat} chatted`);
    }
    // 胜负与存活一致
    const wolves = g.players.filter(p => p.role === 'wolf' && p.alive).length;
    if (winner === 'village') assert.equal(wolves, 0);
    if (winner === 'wolf') assert.ok(wolves > 0);
    // 导出能序列化
    const ex = JSON.stringify(g.export());
    assert.ok(ex.length > 1000);
    games++;
  }
}
console.log(`✓ ${games} 局假模型对局全部正常结束`);
