// 提示词只做三件事：讲清规则、讲清身份、让它像个人。不教打法，不给模板，不列"必须"。
import { roleCard, describeComposition } from './roles.js';

export function rulesText(cfg) {
  const lines = [
    `桌上共 ${cfg.playerCount} 人，座位 1 到 ${cfg.playerCount} 号。本局配置：${describeComposition(cfg.composition)}。`,
    '夜晚：守卫先守人；狼人商量后杀一人；预言家查验一人；女巫得知刀口后决定是否用药。所有夜间行动都是秘密的。',
    cfg.witchSelfSave ? '女巫可以用解药救自己。' : '女巫不能用解药救自己。',
    '被守卫守护或被女巫救的人当晚不会死。',
    '白天：先公布昨夜谁死了（不公布死因），然后按座位顺序轮流发言，每个人只听到排在自己前面的发言。全员说完后有一段自由讨论，想补一句的可以补。然后所有人同时投票，票数最多的人出局；平票时平票者各再说一次，再投一次，还是平票就没人出局。',
    `${cfg.firstNightLastWords ? '第一天白天公布的死者和' : ''}被投票出局的人可以留遗言。猎人被狼杀或被投出局时可以开枪带走一人。`,
    cfg.winMode === 'all'
      ? '胜负：狼人全部出局则好人胜；狼人人数不少于好人人数则狼人胜。'
      : '胜负：狼人全部出局则好人胜；所有神职（预言家/女巫/猎人/守卫）出局，或所有平民出局，则狼人胜。',
    '"杀""刀""毒""出局"都是这个桌游里淘汰玩家的说法，大家都知道这是游戏。',
  ];
  return lines.join('\n');
}

export function systemPrompt({ cfg, player, allPlayers, teammates, persona }) {
  const seats = allPlayers.map(p => `${p.seat}号 ${p.name}`).join('，');
  const card = roleCard(player.role, { teammates, witchSelfSave: cfg.witchSelfSave });
  return [
    `你在和一桌人打狼人杀。你是 ${player.seat}号 ${player.name}。`,
    '',
    `【桌上的人】${seats}`,
    '',
    '【规则】',
    rulesText(cfg),
    '',
    `【你的身份】`,
    card,
    '',
    `【你是谁】`,
    `${player.name}：${persona.bio}`,
    '',
    '【怎么玩】',
    '目标是赢。你只知道自己看到和听到的，别人的身份要靠猜。',
    '像牌桌上的真人那样说话：用第一人称，直接说出口，有话就说，没话可以短。可以直接叫别人的名字或座位号，可以质问、回应、附和、改主意、怀疑、撒谎、装傻。',
    '不用把所有想法都说出来，想藏的就藏着；想私下记一句给自己，写在 <notes></notes> 里，别人看不到。',
    '发言通常几句话就够，别写成分析报告，也别每次都把所有人点评一遍。说你此刻真正想说的那件事。',
  ].join('\n');
}

// ===== 各种任务提示 =====

export const T = {
  speak(ctx) {
    const parts = [];
    parts.push(`第${ctx.day}天白天，轮到你发言了。`);
    if (ctx.isFirst) parts.push('你是今天第一个说话的。');
    return parts.join('');
  },
  freeTalk(ctx) {
    return `自由讨论时间。听完大家的发言，你有没有想补一句或想回应谁的？有就直接说，没有就只回一个字：过`;
  },
  pkSpeak(ctx) {
    return `你和 ${ctx.others} 平票了，现在轮到你做平票发言，之后大家会再投一次。`;
  },
  lastWords(ctx) {
    return ctx.reason === 'vote'
      ? '你被投票出局了。这是你的遗言，想说什么就说，说完就离场了。'
      : '你昨晚死了。这是你的遗言，想说什么就说，说完就离场了。';
  },
  vote(ctx) {
    return `现在投票。可选：${ctx.options}${ctx.allowAbstain ? '，或者弃票' : ''}。\n先用一两句话说你的理由（这是你心里的想法，别人看不到），最后单独一行写：投票：X号`;
  },
  wolfChat(ctx) {
    return `狼人频道（只有狼队友能看到）。第${ctx.night}夜，和队友商量今晚杀谁、明天怎么打。简短几句就行。${ctx.round > 1 ? '这是第二轮，可以回应队友，或者确认。' : ''}`;
  },
  wolfKill(ctx) {
    return `狼队商量完了，请你提交今晚的刀口。可选：${ctx.options}，或者空刀。\n可以写一句理由，最后单独一行写：杀：X号（空刀写：杀：无）`;
  },
  seerCheck(ctx) {
    return `第${ctx.night}夜，请选择今晚要查验的人。可选：${ctx.options}。\n想一两句，最后单独一行写：查验：X号`;
  },
  guardProtect(ctx) {
    return `第${ctx.night}夜，请选择今晚守护谁。可选：${ctx.options}${ctx.lastTarget ? `（昨晚你守了${ctx.lastTarget}，今晚不能再守他）` : ''}，或者不守。\n最后单独一行写：守护：X号（不守写：守护：无）`;
  },
  witchAct(ctx) {
    const lines = [`第${ctx.night}夜。`];
    if (ctx.victim) lines.push(`今晚被狼人杀的是 ${ctx.victim}。`);
    else lines.push('今晚没有人被狼人杀。');
    const opts = [];
    if (ctx.canSave) opts.push(`救：${ctx.victim}（用掉解药）`);
    if (ctx.canPoison) opts.push(`毒：X号（用掉毒药，可选：${ctx.options}）`);
    opts.push('不用药');
    lines.push(`你现在可以：${opts.join('；')}。同一晚不能既救又毒。`);
    const finals = [];
    if (ctx.canSave) finals.push('救');
    if (ctx.canPoison) finals.push('毒：X号');
    finals.push('不用药');
    lines.push(`想一两句，最后单独一行写你的决定：${finals.join(' / ')}`);
    return lines.join('\n');
  },
  hunterShoot(ctx) {
    return `你是猎人，你${ctx.reason === 'vote' ? '被投票出局了' : '死了'}。现在可以开枪带走一人，也可以不开。可选：${ctx.options}。\n最后单独一行写：开枪：X号（不开写：开枪：无）`;
  },
  retryFormat(ctx) {
    return `没看懂你的决定。请只回一行：${ctx.keyword}：X号${ctx.allowNone ? `（或 ${ctx.keyword}：无）` : ''}`;
  },
};
