// 游戏引擎：一个 async 状态机。不碰 DOM，浏览器和 Node 都能跑。
import { ROLES } from './roles.js';
import { systemPrompt, T } from './prompts.js';
import { cleanSpeech, isPass, parseDecision } from './agent.js';

export const DEFAULT_CFG = {
  playerCount: 9,
  composition: null,          // 由 roles.presetFor 填
  witchSelfSave: false,
  firstNightLastWords: true,
  winMode: 'side',            // 'side' 屠边 | 'all' 屠城
  freeTalk: true,
  wolfChatRounds: 1,
  concurrency: 3,             // 同时投票时并发请求数
  maxRetries: 2,
};

export class Game {
  /**
   * players: [{ seat, name, role, persona, agent, modelLabel }]
   * hooks:  { onEvent(evt), onPhase(info), onBusy(seat, bool), gate() => Promise }  都可选
   */
  constructor({ cfg, players, hooks = {}, rng = Math.random }) {
    this.cfg = { ...DEFAULT_CFG, ...cfg };
    this.players = players.map(p => ({ ...p, alive: true, deathReason: null, deathDay: null }));
    this.hooks = hooks;
    this.rng = rng;
    this.log = [];
    this.day = 0;
    this.phase = 'init';
    this.winner = null;
    this.aborted = false;
    this.state = {
      witch: { antidote: true, poison: true },
      guardLast: null,
      seerResults: [],
      votes: [],
    };
  }

  // ===== 工具 =====
  tag(p) { return `${p.seat}号 ${p.name}`; }
  bySeat(seat) { return this.players.find(p => p.seat === seat); }
  alive() { return this.players.filter(p => p.alive); }
  aliveWolves() { return this.alive().filter(p => p.role === 'wolf'); }
  opts(list) { return list.map(p => ({ seat: p.seat, name: p.name })); }
  optText(list) { return list.map(p => this.tag(p)).join('、'); }
  shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  async gate() { if (this.aborted) throw new AbortError(); if (this.hooks.gate) await this.hooks.gate(); if (this.aborted) throw new AbortError(); }

  emit(evt) {
    const e = { day: this.day, phase: this.phase, visibility: 'public', ts: Date.now(), ...evt };
    this.log.push(e);
    try { this.hooks.onEvent && this.hooks.onEvent(e); } catch (err) { console.error(err); }
    return e;
  }
  setPhase(phase) {
    this.phase = phase;
    try { this.hooks.onPhase && this.hooks.onPhase({ phase, day: this.day }); } catch (err) { console.error(err); }
  }

  // 把一条消息送进一群玩家的"耳朵"
  tell(targets, text) { for (const p of targets) p.agent.notify(text); }
  tellAlive(text, except = null) { this.tell(this.alive().filter(p => p !== except), text); }

  // 公开事件：记日志 + 告诉所有活人
  announce(text, extra = {}) {
    this.emit({ type: 'system', text, ...extra });
    this.tellAlive(text);
  }

  // ===== 对模型的两种请求：说话 / 做决定 =====

  async askSpeech(p, task, { visibility = 'public', channel = null, kind = 'speech' } = {}) {
    await this.gate();
    const raw = await this.withRetry(p, () => p.agent.ask(task, { temperature: 0.9, maxTokens: 500 }));
    if (raw == null) return null;
    const text = cleanSpeech(raw, [p.name, `${p.seat}号 ${p.name}`]);
    return { raw, text };
  }

  async decide(p, task, keyword, options, { allowNone = true, kind = 'decision', visibility = 'private' } = {}) {
    await this.gate();
    let raw = await this.withRetry(p, () => p.agent.ask(task, { temperature: 0.6, maxTokens: 400 }));
    let r = raw == null ? null : parseDecision(raw, keyword, options, { allowNone });
    if (!r && raw != null) {
      await this.gate();
      const raw2 = await this.withRetry(p, () => p.agent.ask(T.retryFormat({ keyword, allowNone }), { temperature: 0.2, maxTokens: 60 }));
      if (raw2 != null) { r = parseDecision(raw2, keyword, options, { allowNone }); raw = raw + '\n' + raw2; }
    }
    let fallback = false;
    if (!r) {
      fallback = true;
      r = (allowNone && this.rng() < 0.3) || !options.length ? { none: true } : { seat: options[Math.floor(this.rng() * options.length)].seat };
    }
    const target = r.none ? null : this.bySeat(r.seat);
    this.emit({
      type: kind, visibility, seat: p.seat, keyword,
      target: target ? target.seat : null,
      text: `${keyword}：${target ? this.tag(target) : '无'}`,
      reasoning: raw ? String(raw).trim() : '',
      fallback,
    });
    return target;
  }

  busy(p, on) { try { this.hooks.onBusy && this.hooks.onBusy(p.seat, on); } catch (err) { console.error(err); } }

  async withRetry(p, fn) {
    this.busy(p, true);
    try { return await this._withRetry(p, fn); }
    finally { this.busy(p, false); }
  }

  async _withRetry(p, fn) {
    let lastErr = null;
    for (let i = 0; i <= this.cfg.maxRetries; i++) {
      try { return await fn(); }
      catch (e) {
        if (e instanceof AbortError) throw e;
        lastErr = e;
        this.emit({ type: 'error', visibility: 'god', seat: p.seat, text: `${this.tag(p)}（${p.modelLabel || 'AI'}）请求失败：${e.message}${i < this.cfg.maxRetries ? '，重试中' : '，放弃'}` });
        if (i < this.cfg.maxRetries) await sleep(1500 * (i + 1));
        await this.gate();
      }
    }
    return null;
  }

  // ===== 主流程 =====

  async run() {
    try {
      this.setup();
      let night = 1;
      while (!this.winner) {
        this.day = night;
        await this.night(night);
        if (this.checkWin()) break;
        await this.dayPhase(night);
        if (this.checkWin()) break;
        night++;
        if (night > 30) { this.winner = 'draw'; break; }
      }
      this.setPhase('end');
      const text = this.winner === 'wolf' ? '狼人阵营获胜' : this.winner === 'village' ? '好人阵营获胜' : '平局';
      this.emit({ type: 'end', text, winner: this.winner, roles: this.players.map(p => ({ seat: p.seat, name: p.name, role: p.role, alive: p.alive })) });
      this.tell(this.players, `游戏结束。${text}。各人身份：${this.players.map(p => `${this.tag(p)}=${ROLES[p.role].name}`).join('，')}`);
      return this.winner;
    } catch (e) {
      if (e instanceof AbortError) { this.setPhase('aborted'); this.emit({ type: 'system', text: '对局已终止' }); return null; }
      this.emit({ type: 'error', visibility: 'god', text: `引擎错误：${e.message}` });
      throw e;
    }
  }

  setup() {
    this.setPhase('setup');
    for (const p of this.players) {
      const teammates = p.role === 'wolf' ? this.players.filter(q => q.role === 'wolf' && q !== p).map(q => this.tag(q)) : [];
      const sys = systemPrompt({ cfg: this.cfg, player: p, allPlayers: this.players, teammates, persona: p.persona || { bio: '' } });
      p.agent.init(sys);
    }
    this.emit({ type: 'start', text: `游戏开始。${this.players.length} 人局。`, players: this.players.map(p => ({ seat: p.seat, name: p.name, role: p.role, modelLabel: p.modelLabel, persona: p.persona?.bio })) });
  }

  // ---------- 夜 ----------
  async night(n) {
    this.setPhase('night');
    this.announce(`—— 第${n}夜，天黑了 ——`);
    const alive = this.alive();
    const night = { guard: null, kill: null, saved: false, poison: null, deaths: [] };

    // 守卫
    const guard = alive.find(p => p.role === 'guard');
    if (guard) {
      const last = this.state.guardLast;
      const options = alive.filter(p => p.seat !== last);
      const t = await this.decide(guard, T.guardProtect({ night: n, options: this.optText(options), lastTarget: last ? this.tag(this.bySeat(last)) : null }), '守护', this.opts(options), { kind: 'night-guard' });
      night.guard = t ? t.seat : null;
      this.state.guardLast = night.guard;
      guard.agent.notify(t ? `你今晚守护了 ${this.tag(t)}。` : '你今晚没有守人。');
    }

    // 狼人
    const wolves = alive.filter(p => p.role === 'wolf');
    if (wolves.length) {
      const victims = alive.filter(p => p.role !== 'wolf');
      if (wolves.length > 1) {
        for (let round = 1; round <= this.cfg.wolfChatRounds; round++) {
          for (const w of wolves) {
            const r = await this.askSpeech(w, T.wolfChat({ night: n, round }), { kind: 'wolf-chat' });
            if (!r || !r.text) continue;
            this.emit({ type: 'wolf-chat', visibility: 'wolf', seat: w.seat, text: r.text, raw: r.raw });
            this.tell(wolves.filter(x => x !== w), `狼人频道 · ${this.tag(w)}：${r.text}`);
          }
        }
      }
      const picks = new Map();
      for (const w of wolves) {
        const t = await this.decide(w, T.wolfKill({ options: this.optText(victims) }), '杀', this.opts(victims), { kind: 'night-wolf' });
        const key = t ? t.seat : 0;
        picks.set(key, (picks.get(key) || 0) + 1);
      }
      let best = null, bestN = -1;
      for (const [seat, c] of this.shuffle([...picks.entries()])) if (c > bestN) { best = seat; bestN = c; }
      night.kill = best || null;
      const victim = night.kill ? this.bySeat(night.kill) : null;
      this.tell(wolves, victim ? `狼队今晚的刀口：${this.tag(victim)}。` : '狼队今晚空刀。');
      this.emit({ type: 'night-result', visibility: 'god', text: victim ? `狼队刀口：${this.tag(victim)}` : '狼队空刀' });
    }

    // 预言家
    const seer = alive.find(p => p.role === 'seer');
    if (seer) {
      const options = alive.filter(p => p !== seer);
      const t = await this.decide(seer, T.seerCheck({ night: n, options: this.optText(options) }), '查验', this.opts(options), { allowNone: false, kind: 'night-seer' });
      if (t) {
        const res = t.role === 'wolf' ? '狼人' : '好人';
        this.state.seerResults.push({ night: n, seat: t.seat, result: res });
        seer.agent.notify(`查验结果：${this.tag(t)} 是【${res}】。`);
        this.emit({ type: 'night-result', visibility: 'god', text: `预言家查验 ${this.tag(t)}：${res}` });
      }
    }

    // 女巫
    const witch = alive.find(p => p.role === 'witch');
    const victim = night.kill ? this.bySeat(night.kill) : null;
    if (witch) {
      const canSave = !!(victim && this.state.witch.antidote && (this.cfg.witchSelfSave || victim !== witch));
      const canPoison = this.state.witch.poison;
      const options = alive.filter(p => p !== witch);
      if (canSave || canPoison) {
        await this.gate();
        const task = T.witchAct({ night: n, victim: victim ? this.tag(victim) : null, canSave, canPoison, options: this.optText(options) });
        const raw = await this.withRetry(witch, () => witch.agent.ask(task, { temperature: 0.6, maxTokens: 400 }));
        const d = parseWitch(raw, this.opts(options), { canSave, canPoison });
        if (d.save) { night.saved = true; this.state.witch.antidote = false; witch.agent.notify(`你用解药救了 ${this.tag(victim)}。解药已用完。`); }
        else if (d.poison) { night.poison = d.poison; this.state.witch.poison = false; witch.agent.notify(`你毒了 ${this.tag(this.bySeat(d.poison))}。毒药已用完。`); }
        else witch.agent.notify('你今晚没有用药。');
        this.emit({ type: 'night-witch', visibility: 'private', seat: witch.seat, text: d.save ? `女巫救了 ${this.tag(victim)}` : d.poison ? `女巫毒了 ${this.tag(this.bySeat(d.poison))}` : '女巫没有用药', reasoning: raw ? String(raw).trim() : '' });
      } else {
        witch.agent.notify(victim ? `今晚被狼人杀的是 ${this.tag(victim)}。你已经没有药可用了。` : '今晚没有人被狼人杀，你也没有药可用了。');
      }
    }

    // 结算
    if (victim && !night.saved && night.guard !== victim.seat) night.deaths.push({ p: victim, reason: 'wolf' });
    if (night.poison) night.deaths.push({ p: this.bySeat(night.poison), reason: 'poison' });
    for (const d of night.deaths) this.kill(d.p, d.reason);
    if (victim && (night.saved || night.guard === victim.seat)) this.emit({ type: 'night-result', visibility: 'god', text: `${this.tag(victim)} 被${night.saved ? '女巫救' : '守卫守'}住了` });
    this.lastNight = night;
  }

  kill(p, reason) {
    if (!p.alive) return;
    p.alive = false;
    p.deathReason = reason;
    p.deathDay = this.day;
    this.emit({ type: 'death', visibility: 'god', seat: p.seat, reason, text: `${this.tag(p)}（${ROLES[p.role].name}）出局：${DEATH_TEXT[reason] || reason}` });
  }

  // ---------- 昼 ----------
  async dayPhase(n) {
    this.setPhase('day');
    const deaths = this.lastNight.deaths.map(d => d.p);
    const deathText = deaths.length ? `—— 第${n}天，天亮了。昨晚死亡的是：${deaths.map(p => this.tag(p)).join('、')} ——` : `—— 第${n}天，天亮了。昨晚是平安夜，没有人死亡 ——`;
    this.emit({ type: 'system', text: deathText, deaths: deaths.map(p => p.seat) });
    this.tell(this.alive().concat(deaths), deathText);

    // 遗言与猎人
    for (const p of deaths) {
      if (n === 1 && this.cfg.firstNightLastWords) await this.lastWords(p, 'night');
      if (p.role === 'hunter' && p.deathReason === 'wolf') await this.hunterShoot(p, 'night');
    }
    if (this.checkWin()) return;

    // 轮流发言
    this.setPhase('speech');
    const alive = this.alive();
    let startIdx = 0;
    if (deaths.length) {
      const firstDead = Math.min(...deaths.map(p => p.seat));
      startIdx = alive.findIndex(p => p.seat > firstDead);
      if (startIdx < 0) startIdx = 0;
    } else startIdx = Math.floor(this.rng() * alive.length);
    const order = alive.slice(startIdx).concat(alive.slice(0, startIdx));
    this.announce(`发言顺序：${order.map(p => `${p.seat}号`).join(' → ')}`);
    for (let i = 0; i < order.length; i++) {
      const p = order[i];
      if (!p.alive) continue;
      const r = await this.askSpeech(p, T.speak({ day: n, isFirst: i === 0 }));
      const text = r && r.text ? r.text : '（沉默）';
      this.emit({ type: 'speech', seat: p.seat, text, raw: r ? r.raw : '' });
      this.tellAlive(`${this.tag(p)}：${text}`, p);
    }

    // 自由讨论
    if (this.cfg.freeTalk && this.alive().length > 2) {
      this.setPhase('freetalk');
      this.announce('—— 自由讨论 ——');
      for (const p of this.shuffle(this.alive())) {
        const r = await this.askSpeech(p, T.freeTalk({}));
        if (!r || isPass(r.raw)) { this.emit({ type: 'pass', visibility: 'god', seat: p.seat, text: '（没有补充）' }); continue; }
        this.emit({ type: 'speech', seat: p.seat, text: r.text, raw: r.raw, free: true });
        this.tellAlive(`${this.tag(p)}（补充）：${r.text}`, p);
      }
    }

    // 投票
    this.setPhase('vote');
    let candidates = this.alive();
    let lynched = await this.voteRound(candidates, 1);
    if (lynched === 'tie') {
      // 平票 PK
      const tied = this.lastTie;
      this.announce(`平票：${tied.map(p => this.tag(p)).join('、')}。平票者依次发言后再投一次。`);
      for (const p of tied) {
        const r = await this.askSpeech(p, T.pkSpeak({ others: tied.filter(q => q !== p).map(q => this.tag(q)).join('、') }));
        const text = r && r.text ? r.text : '（沉默）';
        this.emit({ type: 'speech', seat: p.seat, text, raw: r ? r.raw : '', pk: true });
        this.tellAlive(`${this.tag(p)}（平票发言）：${text}`, p);
      }
      lynched = await this.voteRound(tied, 2);
      if (lynched === 'tie') { this.announce('再次平票，今天没有人出局。'); lynched = null; }
    }
    if (lynched) {
      this.announce(`${this.tag(lynched)} 被投票出局。`);
      this.kill(lynched, 'vote');
      await this.lastWords(lynched, 'vote');
      if (lynched.role === 'hunter') await this.hunterShoot(lynched, 'vote');
    }
  }

  async voteRound(candidates, round) {
    const voters = this.alive().filter(p => round === 1 || !candidates.includes(p));
    const options = this.opts(candidates);
    const optText = this.optText(candidates);
    const results = new Map();
    await runLimited(voters, this.cfg.concurrency, async p => {
      const own = candidates.filter(q => q !== p);
      const t = await this.decide(p, T.vote({ options: this.optText(own), allowAbstain: true }), '投票', this.opts(own), { kind: 'vote-reason' });
      results.set(p.seat, t ? t.seat : null);
    });
    const tally = new Map();
    for (const [, tgt] of results) if (tgt) tally.set(tgt, (tally.get(tgt) || 0) + 1);
    const lines = voters.map(p => `${p.seat}号→${results.get(p.seat) ? results.get(p.seat) + '号' : '弃票'}`);
    const summary = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s}号 ${c}票`).join('，') || '全部弃票';
    this.state.votes.push({ day: this.day, round, votes: Object.fromEntries(results) });
    this.emit({ type: 'vote', text: `投票结果：${summary}`, detail: lines.join('  '), votes: Object.fromEntries(results) });
    this.tellAlive(`投票结果（${lines.join('，')}）：${summary}`);
    if (!tally.size) return null;
    const max = Math.max(...tally.values());
    const top = [...tally.entries()].filter(([, c]) => c === max).map(([s]) => this.bySeat(s));
    if (top.length > 1) { this.lastTie = top; return 'tie'; }
    return top[0];
  }

  async lastWords(p, reason) {
    const r = await this.askSpeech(p, T.lastWords({ reason }));
    const text = r && r.text ? r.text : '（没有遗言）';
    this.emit({ type: 'speech', seat: p.seat, text, raw: r ? r.raw : '', lastWords: true });
    this.tellAlive(`${this.tag(p)}（遗言）：${text}`);
  }

  async hunterShoot(hunter, reason) {
    const options = this.alive().filter(p => p !== hunter);
    if (!options.length) return;
    const t = await this.decide(hunter, T.hunterShoot({ reason, options: this.optText(options) }), '开枪', this.opts(options), { kind: 'hunter', visibility: 'god' });
    if (t) {
      this.announce(`${this.tag(hunter)} 是猎人，开枪带走了 ${this.tag(t)}。`);
      this.kill(t, 'shot');
      t.agent.notify(`你被猎人 ${this.tag(hunter)} 开枪带走了。`);
    } else this.announce(`${this.tag(hunter)} 是猎人，选择不开枪。`);
  }

  checkWin() {
    if (this.winner) return true;
    const alive = this.alive();
    const wolves = alive.filter(p => p.role === 'wolf');
    const good = alive.filter(p => p.role !== 'wolf');
    if (!wolves.length) { this.winner = 'village'; return true; }
    if (this.cfg.winMode === 'all') {
      if (wolves.length >= good.length) { this.winner = 'wolf'; return true; }
    } else {
      const hasGods = this.players.some(p => ROLES[p.role].kind === 'god');
      const hasVill = this.players.some(p => p.role === 'villager');
      const gods = good.filter(p => ROLES[p.role].kind === 'god');
      const vill = good.filter(p => p.role === 'villager');
      if ((hasGods && !gods.length) || (hasVill && !vill.length) || wolves.length >= good.length) { this.winner = 'wolf'; return true; }
    }
    return false;
  }

  abort() { this.aborted = true; }

  // 导出：公开记录 + 上帝视角 + 每个 AI 的完整对话
  export() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      cfg: this.cfg,
      winner: this.winner,
      players: this.players.map(p => ({ seat: p.seat, name: p.name, role: p.role, alive: p.alive, deathReason: p.deathReason, modelLabel: p.modelLabel, persona: p.persona, system: p.agent.system, history: p.agent.history })),
      log: this.log,
    };
  }
}

const DEATH_TEXT = { wolf: '被狼人杀死', poison: '被女巫毒死', vote: '被投票出局', shot: '被猎人带走' };

export class AbortError extends Error { constructor() { super('aborted'); this.name = 'AbortError'; } }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runLimited(items, limit, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) { const it = queue.shift(); await fn(it); }
  });
  await Promise.all(workers);
}

function parseWitch(raw, options, { canSave, canPoison }) {
  const s = String(raw || '').replace(/<notes>[\s\S]*?<\/notes>/gi, '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^(决定|我的决定)?\s*[:：]?\s*不用药/.test(l) || /^不用药/.test(l)) return {};
    if (canPoison) {
      const m = /(?:^|[\s*#>】])毒\s*[:：]?\s*(.+)$/.exec(l);
      if (m) { const r = parseDecision(`毒：${m[1]}`, '毒', options, { allowNone: false }); if (r && r.seat) return { poison: r.seat }; }
    }
    if (canSave && /^(决定|我的决定)?\s*[:：]?\s*救/.test(l)) return { save: true };
  }
  // 没有明确行：在最后两行里找关键词
  const tail = lines.slice(-2).join(' ');
  if (canSave && /救/.test(tail) && !/不救/.test(tail)) return { save: true };
  return {};
}
