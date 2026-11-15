// 信息边界：每个 AI 只能看到自己该看到的。
import { buildGame } from './helpers.mjs';
import assert from 'node:assert/strict';

for (let seed = 1; seed <= 10; seed++) {
  const g = buildGame({ n: 12, seed });
  await g.run();
  for (const p of g.players) {
    const seen = p.agent.system + '\n' + p.agent.history.filter(m => m.role === 'user').map(m => m.content).join('\n');
    const own = p.agent.history.filter(m => m.role === 'assistant').map(m => m.content).join('\n');
    if (p.role !== 'wolf') {
      assert.ok(!seen.includes('狼人频道'), `${p.seat} ${p.role} saw wolf chat`);
      assert.ok(!seen.includes('狼队今晚的刀口'), `${p.seat} ${p.role} saw wolf kill`);
      assert.ok(!/你的狼队友/.test(seen), `${p.seat} saw teammates`);
    } else {
      // 狼看不到查验结果、守卫、女巫的私密信息
      assert.ok(!seen.includes('查验结果'), `wolf ${p.seat} saw seer result`);
      assert.ok(!/你今晚守护了/.test(seen), `wolf ${p.seat} saw guard`);
      assert.ok(!/你用解药救了|你毒了/.test(seen), `wolf ${p.seat} saw witch`);
    }
    if (p.role !== 'seer') assert.ok(!seen.includes('查验结果'), `${p.seat} ${p.role} saw seer result`);
    if (p.role !== 'witch') assert.ok(!/今晚被狼人杀的是/.test(seen), `${p.seat} ${p.role} saw witch info`);
    // 系统提示只出现一次身份
    assert.equal((p.agent.system.match(/你的身份是/g) || []).length, 1);
  }
  // 每个人的事件里不应该出现自己的发言被重复转述
  for (const p of g.players) {
    const users = p.agent.history.filter(m => m.role === 'user').map(m => m.content).join('\n');
    assert.ok(!users.includes(`${p.seat}号 ${p.name}：`), `${p.seat} heard own speech echoed`);
  }
}
console.log('✓ 信息边界检查通过');
