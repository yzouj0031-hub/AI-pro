// 三种接口：OpenAI 兼容（OpenAI/DeepSeek/Qwen/Grok/OpenRouter/各种中转）、Anthropic、Gemini。
// 外加一个离线的"假模型"，用来不花钱跑通流程和跑测试。

export function createProvider(cfg) {
  switch (cfg.type) {
    case 'anthropic': return new AnthropicProvider(cfg);
    case 'gemini': return new GeminiProvider(cfg);
    case 'mock': return new MockProvider(cfg);
    case 'openai':
    default: return new OpenAIProvider(cfg);
  }
}

export function detectType(baseUrl) {
  const u = String(baseUrl || '').toLowerCase();
  if (u.includes('anthropic.com')) return 'anthropic';
  if (u.includes('generativelanguage.googleapis.com') && !u.includes('/openai')) return 'gemini';
  return 'openai';
}

export const PROVIDER_PRESETS = [
  { label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { label: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '通义千问', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: 'Moonshot / Kimi', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: 'xAI Grok', type: 'openai', baseUrl: 'https://api.x.ai/v1', model: 'grok-3' },
  { label: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { label: 'Anthropic Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  { label: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash' },
];

async function fetchJSON(url, init, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok) {
      const msg = (data && (data.error?.message || data.message)) || text.slice(0, 300);
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

export class OpenAIProvider {
  constructor(cfg) { this.cfg = cfg; this.label = cfg.label || cfg.model; }
  async chat({ system, messages, temperature, maxTokens }) {
    let base = trimSlash(this.cfg.baseUrl || 'https://api.openai.com/v1');
    if (!/\/v\d+(\/|$)/.test(base) && !/\/openai$/.test(base) && !this.cfg.rawUrl) base += '/v1';
    const body = {
      model: this.cfg.model,
      messages: [{ role: 'system', content: system }].concat(messages),
      max_tokens: maxTokens,
    };
    // 推理模型（o 系列、部分 reasoner）不接受 temperature；其余正常传
    if (!/^o\d|reason|think/i.test(this.cfg.model) || this.cfg.forceTemperature) body.temperature = temperature;
    const headers = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    if (this.cfg.extraHeaders) Object.assign(headers, this.cfg.extraHeaders);
    const data = await fetchJSON(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('接口没有返回 choices');
    let content = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '';
    if (!content && msg.reasoning_content) content = '';
    return content;
  }
}

export class AnthropicProvider {
  constructor(cfg) { this.cfg = cfg; this.label = cfg.label || cfg.model; }
  async chat({ system, messages, temperature, maxTokens }) {
    const base = trimSlash(this.cfg.baseUrl || 'https://api.anthropic.com');
    const url = /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
    // Anthropic 要求 user/assistant 严格交替，且首条是 user
    const msgs = [];
    for (const m of messages) {
      const last = msgs[msgs.length - 1];
      if (last && last.role === m.role) last.content += '\n\n' + m.content;
      else msgs.push({ role: m.role, content: m.content });
    }
    if (msgs[0]?.role !== 'user') msgs.unshift({ role: 'user', content: '（开始）' });
    const body = { model: this.cfg.model, system, messages: msgs, max_tokens: maxTokens, temperature: Math.min(1, temperature) };
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.cfg.apiKey || '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (this.cfg.extraHeaders) Object.assign(headers, this.cfg.extraHeaders);
    const data = await fetchJSON(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    if (data.stop_reason === 'refusal' && !text) throw new Error('模型拒绝回答');
    return text;
  }
}

export class GeminiProvider {
  constructor(cfg) { this.cfg = cfg; this.label = cfg.label || cfg.model; }
  async chat({ system, messages, temperature, maxTokens }) {
    const base = trimSlash(this.cfg.baseUrl || 'https://generativelanguage.googleapis.com');
    const url = `${base}/v1beta/models/${encodeURIComponent(this.cfg.model)}:generateContent?key=${encodeURIComponent(this.cfg.apiKey || '')}`;
    const contents = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts[0].text += '\n\n' + m.content;
      else contents.push({ role, parts: [{ text: m.content }] });
    }
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature, maxOutputTokens: maxTokens },
      safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
        .map(category => ({ category, threshold: 'BLOCK_NONE' })),
    };
    const data = await fetchJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const cand = data.candidates?.[0];
    if (!cand) throw new Error(data.promptFeedback?.blockReason ? `被安全策略拦截：${data.promptFeedback.blockReason}` : '接口没有返回候选');
    return (cand.content?.parts || []).map(p => p.text || '').join('');
  }
}

// 假模型：按任务关键词给出格式正确的随机回答。用于离线演示和自动化测试。
export class MockProvider {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.label = cfg.label || '假模型';
    this.delay = cfg.delay ?? 0;
    this.rng = cfg.rng || Math.random;
  }
  pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }
  async chat({ messages }) {
    if (this.delay) await new Promise(r => setTimeout(r, this.delay));
    const last = messages[messages.length - 1]?.content || '';
    const task = last.split('\n\n').pop();
    const seats = [...task.matchAll(/(\d{1,2})号/g)].map(m => m[1]);
    const seat = seats.length ? this.pick(seats) : null;
    const line = kw => (seat ? `${kw}：${seat}号` : `${kw}：无`);
    if (/^现在投票/.test(task)) return `我觉得${seat}号今天说话有点飘。\n${line('投票')}`;
    if (/提交今晚的刀口/.test(task)) return this.rng() < 0.1 ? '今晚空刀吧。\n杀：无' : `先刀${seat}号。\n${line('杀')}`;
    if (/要查验的人/.test(task)) return line('查验');
    if (/守护谁/.test(task)) return this.rng() < 0.2 ? '守护：无' : line('守护');
    if (/你现在可以：/.test(task)) {
      const r = this.rng();
      if (/救：/.test(task) && r < 0.5) return '救吧。\n救';
      if (/毒：/.test(task) && r < 0.7) return `毒${seat}号。\n毒：${seat}号`;
      return '先不用药。\n不用药';
    }
    if (/开枪带走一人/.test(task)) return this.rng() < 0.8 ? line('开枪') : '开枪：无';
    if (/狼人频道/.test(task)) return this.pick([`今晚刀${seat || '随便'}号吧，他看着像神。`, '我明天装村民，你们别带我。', `${seat || '2'}号那家伙白天肯定会跳预言家，先刀他。`]);
    if (/自由讨论/.test(task)) return this.rng() < 0.6 ? '过' : this.pick([`我补一句，${seat || '3'}号刚才那个理由我没听懂。`, '我还是那个意思，不改。']);
    if (/遗言/.test(task)) return this.pick(['我是好人，你们好好查。', `盯住${seat || '5'}号，他有问题。`, '算了，不说了。']);
    const speeches = [
      `我先说我的想法，${seat || '3'}号刚才那句话有点奇怪，为什么突然转移话题？`,
      '我没什么信息，先听大家的。',
      `我是预言家，昨晚查了${seat || '4'}号，他是狼。`,
      '昨晚死的人之前站边很明确，狼可能是怕他带节奏。',
      `${seat || '6'}号你别笑，说说你的看法。`,
      '我感觉今天节奏不太对，大家别急着投。<notes>先盯着3号</notes>',
    ];
    return this.pick(speeches);
  }
}
