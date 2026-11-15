// 角色定义：只放经典角色。玩法越简单，模型越能把精力花在"人"上而不是"规则"上。
export const ROLES = {
  wolf:     { id: 'wolf',     name: '狼人',   team: 'wolf',    kind: 'wolf',     icon: '🐺' },
  villager: { id: 'villager', name: '村民',   team: 'village', kind: 'villager', icon: '🧑‍🌾' },
  seer:     { id: 'seer',     name: '预言家', team: 'village', kind: 'god',      icon: '🔮' },
  witch:    { id: 'witch',    name: '女巫',   team: 'village', kind: 'god',      icon: '🧪' },
  hunter:   { id: 'hunter',   name: '猎人',   team: 'village', kind: 'god',      icon: '🏹' },
  guard:    { id: 'guard',    name: '守卫',   team: 'village', kind: 'god',      icon: '🛡️' },
};

// 不同人数的默认板子
export const PRESETS = {
  6:  { wolf: 2, seer: 1, witch: 1, hunter: 0, guard: 0, villager: 2 },
  7:  { wolf: 2, seer: 1, witch: 1, hunter: 1, guard: 0, villager: 2 },
  8:  { wolf: 3, seer: 1, witch: 1, hunter: 1, guard: 0, villager: 2 },
  9:  { wolf: 3, seer: 1, witch: 1, hunter: 1, guard: 0, villager: 3 },
  10: { wolf: 3, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 3 },
  11: { wolf: 3, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 },
  12: { wolf: 4, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 },
};

export function presetFor(n) {
  return PRESETS[n] || PRESETS[9];
}

export function expandComposition(comp) {
  const out = [];
  for (const [id, count] of Object.entries(comp)) {
    for (let i = 0; i < (count | 0); i++) out.push(id);
  }
  return out;
}

export function describeComposition(comp) {
  return Object.entries(comp)
    .filter(([, c]) => c > 0)
    .map(([id, c]) => `${ROLES[id].name}×${c}`)
    .join('、');
}

// 角色卡：只说这个身份能做什么，不教怎么打。
export function roleCard(roleId, ctx = {}) {
  const r = ROLES[roleId];
  switch (roleId) {
    case 'wolf':
      return `你的身份是【狼人】。${ctx.teammates && ctx.teammates.length
        ? `你的狼队友：${ctx.teammates.join('、')}。` : '这局你是唯一的狼人。'}\n每晚狼人可以私下商量并选择一名玩家杀死。白天你们和其他人一样发言、投票，谁都不知道你是狼，除非你自己暴露。`;
    case 'villager':
      return '你的身份是【村民】。你没有特殊能力，白天靠发言、提问和投票来找出狼人。';
    case 'seer':
      return '你的身份是【预言家】。每晚你可以查验一名玩家，得知他是"狼人"还是"好人"。查验结果只有你自己知道，要不要说、怎么说、什么时候说，全看你。';
    case 'witch':
      return `你的身份是【女巫】。你有一瓶解药和一瓶毒药，整局各只能用一次。每晚你会得知今晚谁被狼人杀了，可以用解药救他${ctx.witchSelfSave ? '（包括救自己）' : '（但不能救自己）'}，也可以用毒药毒死一名玩家。同一晚不能既救又毒。`;
    case 'hunter':
      return '你的身份是【猎人】。当你被狼人杀死或被投票出局时，可以开枪带走一名玩家；但如果你是被女巫毒死的，就不能开枪。';
    case 'guard':
      return '你的身份是【守卫】。每晚你可以守护一名玩家（可以守自己），使他当晚不会被狼人杀死；不能连续两晚守同一个人。';
    default:
      return `你的身份是【${r ? r.name : roleId}】。`;
  }
}
