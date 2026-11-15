// 一个 AI 玩家 = 一段持续的对话。
// 系统提示只讲规则、身份、性格；之后发生的每件事都作为"用户消息"追加进来，
// 它自己说过的话就是对话里的 assistant 轮。它不是每轮重读全局卷宗的旁观者，而是在桌上坐着的那个人。

export class AIAgent {
  constructor({ provider, label, temperature }) {
    this.provider = provider;        // { chat({system, messages, temperature}) => Promise<string> }
    this.label = label || 'AI';
    this.temperature = temperature ?? 0.9;
    this.system = '';
    this.history = [];               // [{role:'user'|'assistant', content}]
    this.pending = [];               // 还没发给它的事件
    this.notes = '';
    this.calls = 0;
    this.lastError = null;
  }

  init(system) {
    this.system = system;
    this.history = [];
    this.pending = [];
  }

  notify(text) {
    if (text) this.pending.push(text);
  }

  // 把积压的事件和这次的任务合成一条用户消息
  _compose(task) {
    const chunks = [];
    if (this.pending.length) {
      chunks.push(this.pending.join('\n'));
      this.pending = [];
    }
    if (task) chunks.push(task);
    return chunks.join('\n\n');
  }

  async ask(task, { temperature, maxTokens } = {}) {
    const content = this._compose(task);
    const messages = this.history.concat([{ role: 'user', content }]);
    this.calls++;
    let reply;
    try {
      reply = await this.provider.chat({
        system: this.system,
        messages,
        temperature: temperature ?? this.temperature,
        maxTokens: maxTokens ?? 600,
      });
    } catch (e) {
      this.lastError = e;
      // 请求失败：把这条用户消息留在 pending 里，别丢事件
      this.pending.unshift(content);
      throw e;
    }
    reply = String(reply || '').trim();
    this.history.push({ role: 'user', content });
    this.history.push({ role: 'assistant', content: reply });
    const notes = extractNotes(reply);
    if (notes) this.notes = notes;
    return reply;
  }
}

// 人类玩家：所有任务都交给外部回调（UI）来回答
export class HumanAgent {
  constructor({ onAsk }) {
    this.onAsk = onAsk;
    this.pending = [];
    this.history = [];
    this.label = '你';
    this.system = '';
  }
  init(system) { this.system = system; this.pending = []; }
  notify(text) { if (text) this.pending.push(text); }
  async ask(task, meta = {}) {
    const events = this.pending.slice();
    this.pending = [];
    const reply = await this.onAsk({ task, events, ...meta });
    this.history.push({ role: 'user', content: events.concat([task]).join('\n\n') });
    this.history.push({ role: 'assistant', content: reply });
    return String(reply || '');
  }
}

// ===== 文本处理 =====

export function extractNotes(text) {
  const m = /<notes>([\s\S]*?)<\/notes>/i.exec(text);
  return m ? m[1].trim() : '';
}

// 公开发言：去掉私密笔记、思考标签、多余引号
export function cleanSpeech(text, selfNames = []) {
  let s = String(text || '');
  s = s.replace(/<notes>[\s\S]*?<\/notes>/gi, '');
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  s = s.replace(/\[笔记\][\s\S]*?\[\/笔记\]/g, '');
  s = s.replace(/^\s*(发言|我说)[:：]\s*/i, '');
  s = s.trim();
  // 模型有时会把自己的名字当前缀："老周：……" / "3号 老周：……"
  for (const nm of selfNames) {
    if (!nm) continue;
    const re = new RegExp('^\\s*(?:\\d{1,2}号\\s*)?' + nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[：:]\\s*');
    s = s.replace(re, '');
  }
  s = s.replace(/^\s*\d{1,2}号\s*[：:]\s*(?=\S)/, '');
  // 去掉首尾成对引号
  if (/^[「“"].*[」”"]$/s.test(s)) s = s.slice(1, -1).trim();
  return s;
}

export function isPass(text) {
  const s = cleanSpeech(text, []).replace(/[。.．!！~～\s]/g, '');
  return s === '' || s === '过' || s === 'pass' || s === 'PASS' || s === '没有' || s === '不补了' || /^过[了吧]?$/.test(s);
}

// 从回复里解析决定。keyword 如 "投票"、"杀"、"查验"；options 是 [{seat, name}]。
// 返回 { seat } | { none: true } | null
export function parseDecision(text, keyword, options, { allowNone = true } = {}) {
  const s = String(text || '').replace(/<notes>[\s\S]*?<\/notes>/gi, '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
  const kwRe = new RegExp(`(?:^|[\\s*#>】\\]])${escapeRe(keyword)}\\s*[:：]\\s*(.+)$`);
  // 1. 从后往前找 "关键词：X"
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = kwRe.exec(lines[i]);
    if (m) {
      const r = matchTarget(m[1], options);
      if (r) return r;
      if (allowNone && /^(无|不|没|空|弃|none|skip|不开|不用|不守|空刀|弃票|不用药)/i.test(m[1].trim())) return { none: true };
    }
  }
  // 2. 最后一行里有唯一的座位号或名字
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 2); i--) {
    const r = matchTarget(lines[i], options, true);
    if (r) return r;
    if (allowNone && /^(无|不开枪|不用药|不守|空刀|弃票|过|pass)[。.!！]?$/i.test(lines[i])) return { none: true };
  }
  return null;
}

function matchTarget(str, options, unique = false) {
  const s = String(str).trim();
  const hits = [];
  // 座位号
  const nums = [...s.matchAll(/(\d{1,2})\s*号/g)].map(m => parseInt(m[1], 10));
  for (const n of nums) {
    const o = options.find(x => x.seat === n);
    if (o && !hits.includes(o)) hits.push(o);
  }
  if (!hits.length) {
    const bare = /^\s*(\d{1,2})\s*[。.!！]?\s*$/.exec(s);
    if (bare) {
      const o = options.find(x => x.seat === parseInt(bare[1], 10));
      if (o) hits.push(o);
    }
  }
  // 名字
  for (const o of options) {
    if (o.name && s.includes(o.name) && !hits.includes(o)) hits.push(o);
  }
  if (!hits.length) return null;
  if (unique && hits.length > 1) return null;
  return { seat: hits[0].seat };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
