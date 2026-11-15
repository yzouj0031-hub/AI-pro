import { Game } from './engine.js';
import { ROLES, presetFor, expandComposition } from './roles.js';
import { pickPersonas } from './personas.js';
import { AIAgent, HumanAgent } from './agent.js';
import { createProvider, PROVIDER_PRESETS, detectType, MockProvider } from './providers.js';

const $ = id => document.getElementById(id);
const LS_MODELS = 'aiwolf.models.v1';
const LS_SETTINGS = 'aiwolf.settings.v1';

// ===== 持久化 =====
function loadJSON(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } }
function saveJSON(key, v) { localStorage.setItem(key, JSON.stringify(v)); }

let models = loadJSON(LS_MODELS, []);
let settings = Object.assign({
  playerCount: 9, composition: null, humanSeat: false, assignMode: 'random', seatModels: {},
  witchSelfSave: false, firstNightLastWords: true, freeTalk: true, winMode: 'side', wolfChatRounds: 1, speed: 2000, god: true,
}, loadJSON(LS_SETTINGS, {}));
function persist() { saveJSON(LS_MODELS, models); saveJSON(LS_SETTINGS, settings); }

// ===== 模型库 UI =====
function renderModels() {
  const ul = $('model-list');
  ul.innerHTML = '';
  if (!models.length) { ul.innerHTML = '<li class="empty">还没有模型。点「添加」填一个接口，或者先用假模型试跑。</li>'; }
  for (const m of models) {
    const li = document.createElement('li');
    li.className = m.enabled === false ? 'disabled' : '';
    li.innerHTML = `<input type="checkbox" ${m.enabled !== false ? 'checked' : ''} title="参与本局">
      <span class="name">${esc(m.label)}<span class="meta">${esc(m.type)} · ${esc(m.model)}</span></span>
      <button class="small" data-act="edit">编辑</button><button class="small" data-act="del">删</button>`;
    li.querySelector('input').onchange = e => { m.enabled = e.target.checked; persist(); renderModels(); renderSeatAssign(); };
    li.querySelector('[data-act=edit]').onclick = () => openModelDialog(m);
    li.querySelector('[data-act=del]').onclick = () => { if (confirm(`删除「${m.label}」？`)) { models = models.filter(x => x !== m); persist(); renderModels(); renderSeatAssign(); } };
    ul.appendChild(li);
  }
}
function enabledModels() { return models.filter(m => m.enabled !== false); }

const dlg = $('model-dialog');
let editing = null;
function openModelDialog(m) {
  editing = m || null;
  $('model-dialog-title').textContent = m ? '编辑模型' : '添加模型';
  $('mf-preset').value = '';
  $('mf-label').value = m?.label || '';
  $('mf-type').value = m?.type || 'openai';
  $('mf-url').value = m?.baseUrl || '';
  $('mf-model').value = m?.model || '';
  $('mf-key').value = m?.apiKey || '';
  $('mf-test-result').textContent = '';
  dlg.showModal();
}
for (const p of PROVIDER_PRESETS) { const o = document.createElement('option'); o.value = p.label; o.textContent = p.label; $('mf-preset').appendChild(o); }
$('mf-preset').onchange = () => {
  const p = PROVIDER_PRESETS.find(x => x.label === $('mf-preset').value);
  if (!p) return;
  $('mf-type').value = p.type; $('mf-url').value = p.baseUrl; $('mf-model').value = p.model;
  if (!$('mf-label').value) $('mf-label').value = p.model;
};
$('mf-url').onchange = () => { const t = detectType($('mf-url').value); if (t !== 'openai' || !$('mf-url').value) $('mf-type').value = t; };
$('mf-cancel').onclick = () => dlg.close();
$('btn-add-model').onclick = () => openModelDialog(null);
function readModelForm() {
  return { label: $('mf-label').value.trim() || $('mf-model').value.trim(), type: $('mf-type').value, baseUrl: $('mf-url').value.trim(), model: $('mf-model').value.trim(), apiKey: $('mf-key').value.trim() };
}
$('model-form').onsubmit = e => {
  e.preventDefault();
  const v = readModelForm();
  if (editing) Object.assign(editing, v); else models.push({ id: 'm' + Date.now(), enabled: true, ...v });
  persist(); renderModels(); renderSeatAssign(); dlg.close();
};
$('mf-test').onclick = async () => {
  const out = $('mf-test-result');
  out.textContent = '测试中…';
  try {
    const p = createProvider(readModelForm());
    const r = await p.chat({ system: '你是一个测试助手。', messages: [{ role: 'user', content: '只回复两个字：收到' }], temperature: 0, maxTokens: 20 });
    out.textContent = `✓ 返回：${String(r).slice(0, 40)}`;
  } catch (err) { out.textContent = `✗ ${err.message}`; }
};

// ===== 对局设置 UI =====
const pc = $('player-count');
for (let n = 6; n <= 12; n++) { const o = document.createElement('option'); o.value = n; o.textContent = `${n} 人`; pc.appendChild(o); }
pc.value = settings.playerCount;
pc.onchange = () => { settings.playerCount = +pc.value; settings.composition = { ...presetFor(settings.playerCount) }; persist(); renderComposition(); renderSeatAssign(); };
if (!settings.composition) settings.composition = { ...presetFor(settings.playerCount) };

function renderComposition() {
  const box = $('composition');
  box.innerHTML = '';
  for (const id of ['wolf', 'seer', 'witch', 'hunter', 'guard', 'villager']) {
    const l = document.createElement('label');
    l.innerHTML = `${ROLES[id].icon} ${ROLES[id].name}<input type="number" min="0" max="${id === 'wolf' || id === 'villager' ? 6 : 1}" value="${settings.composition[id] || 0}">`;
    l.querySelector('input').onchange = e => { settings.composition[id] = Math.max(0, +e.target.value | 0); persist(); renderComposition(); };
    box.appendChild(l);
  }
  const total = expandComposition(settings.composition).length;
  if (total !== settings.playerCount) {
    const d = document.createElement('div'); d.className = 'bad';
    d.textContent = `角色总数 ${total}，和人数 ${settings.playerCount} 不一致`;
    box.appendChild(d);
  }
}
function renderSeatAssign() {
  const box = $('seat-assign');
  box.hidden = settings.assignMode !== 'manual';
  box.innerHTML = '';
  if (box.hidden) return;
  const ms = enabledModels();
  for (let s = 1; s <= settings.playerCount; s++) {
    const l = document.createElement('label');
    const sel = document.createElement('select');
    sel.innerHTML = `<option value="">随机</option>` + ms.map(m => `<option value="${m.id}" ${settings.seatModels[s] === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
    sel.onchange = () => { settings.seatModels[s] = sel.value; persist(); };
    l.textContent = `${s}号 `; l.appendChild(sel); box.appendChild(l);
  }
}
$('assign-mode').value = settings.assignMode;
$('assign-mode').onchange = e => { settings.assignMode = e.target.value; persist(); renderSeatAssign(); };
$('human-seat').checked = settings.humanSeat;
$('human-seat').onchange = e => { settings.humanSeat = e.target.checked; persist(); };
bindCheck('opt-selfsave', 'witchSelfSave'); bindCheck('opt-lastwords', 'firstNightLastWords'); bindCheck('opt-freetalk', 'freeTalk');
$('opt-winmode').value = settings.winMode; $('opt-winmode').onchange = e => { settings.winMode = e.target.value; persist(); };
$('opt-wolfrounds').value = settings.wolfChatRounds; $('opt-wolfrounds').onchange = e => { settings.wolfChatRounds = +e.target.value; persist(); };
$('speed').value = String(settings.speed); $('speed').onchange = e => { settings.speed = +e.target.value; persist(); $('btn-step').disabled = settings.speed !== -1 || !game; if (settings.speed !== -1) stepResolve(); };
$('god-view').checked = settings.god; applyGod();
$('god-view').onchange = e => { settings.god = e.target.checked; persist(); applyGod(); renderSeats(); };
function applyGod() { document.body.classList.toggle('god', !!settings.god); }
function bindCheck(id, key) { $(id).checked = !!settings[key]; $(id).onchange = e => { settings[key] = e.target.checked; persist(); }; }
$('btn-settings').onclick = () => $('settings').classList.toggle('collapsed');

// ===== 对局 =====
let game = null;
let paused = false;
let pauseWaiters = [];
let stepWaiter = null;
let humanResolver = null;
let selectedSeat = null;

function stepResolve() { if (stepWaiter) { const w = stepWaiter; stepWaiter = null; w(); } }

async function gate() {
  if (paused) await new Promise(r => pauseWaiters.push(r));
  if (settings.speed === -1) await new Promise(r => { stepWaiter = r; });
  else if (settings.speed > 0) await new Promise(r => setTimeout(r, settings.speed));
}

function buildPlayers() {
  const n = settings.playerCount;
  const roles = expandComposition(settings.composition);
  if (roles.length !== n) throw new Error('角色总数和人数不一致，请先调整配置');
  shuffle(roles);
  const personas = pickPersonas(n);
  const ms = enabledModels();
  const humanSeat = settings.humanSeat ? 1 + Math.floor(Math.random() * n) : 0;
  if (!ms.length && !(humanSeat && n === 1)) throw new Error('至少勾选一个模型，或者用假模型试跑');
  const players = [];
  for (let s = 1; s <= n; s++) {
    const persona = personas[s - 1];
    if (s === humanSeat) {
      players.push({ seat: s, name: '你', role: roles[s - 1], persona: { name: '你', bio: '真人玩家。' }, modelLabel: '真人', agent: new HumanAgent({ onAsk: humanAsk }), human: true });
      continue;
    }
    let m = null;
    if (settings.assignMode === 'manual' && settings.seatModels[s]) m = ms.find(x => x.id === settings.seatModels[s]) || null;
    if (!m) m = ms[Math.floor(Math.random() * ms.length)];
    players.push({ seat: s, name: persona.name, role: roles[s - 1], persona, modelLabel: m.label, agent: new AIAgent({ provider: createProvider(m), label: m.label }) });
  }
  return players;
}

function buildMockPlayers() {
  const n = settings.playerCount;
  const roles = expandComposition(settings.composition);
  if (roles.length !== n) throw new Error('角色总数和人数不一致，请先调整配置');
  shuffle(roles);
  const personas = pickPersonas(n);
  return roles.map((role, i) => ({ seat: i + 1, name: personas[i].name, role, persona: personas[i], modelLabel: '假模型', agent: new AIAgent({ provider: new MockProvider({ delay: 50 }), label: '假模型' }) }));
}

async function startGame(mock = false) {
  let players;
  try { players = mock ? buildMockPlayers() : buildPlayers(); } catch (e) { alert(e.message); return; }
  $('log').innerHTML = ''; $('mind-content').innerHTML = '';
  paused = false; stepWaiter = null;
  game = new Game({
    cfg: { playerCount: settings.playerCount, composition: settings.composition, witchSelfSave: settings.witchSelfSave, firstNightLastWords: settings.firstNightLastWords, freeTalk: settings.freeTalk, winMode: settings.winMode, wolfChatRounds: settings.wolfChatRounds },
    players,
    hooks: { onEvent, onPhase, gate },
  });
  window.game = game;
  renderSeats();
  setControls(true);
  try { await game.run(); }
  catch (e) { console.error(e); appendSystem(`出错了：${e.message}`, 'error'); }
  setControls(false);
  $('btn-export').disabled = false;
  $('status').textContent = game.winner ? ($('status').textContent) : '已结束';
}

function setControls(running) {
  $('btn-start').disabled = running; $('btn-demo').disabled = running;
  $('btn-pause').disabled = !running; $('btn-stop').disabled = !running;
  $('btn-step').disabled = !running || settings.speed !== -1;
  $('btn-pause').textContent = '暂停';
  $('btn-export').disabled = !game;
}
$('btn-start').onclick = () => startGame(false);
$('btn-demo').onclick = () => startGame(true);
$('btn-pause').onclick = () => {
  paused = !paused;
  $('btn-pause').textContent = paused ? '继续' : '暂停';
  if (!paused) { const ws = pauseWaiters; pauseWaiters = []; ws.forEach(f => f()); }
};
$('btn-stop').onclick = () => { if (game && confirm('终止这局？')) { game.abort(); stepResolve(); if (paused) $('btn-pause').onclick(); } };
$('btn-step').onclick = () => stepResolve();
$('btn-export').onclick = () => {
  if (!game) return;
  const data = game.export();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `aiwolf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click();
};
$('btn-import').onclick = () => $('file-import').click();
$('file-import').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { const data = JSON.parse(await f.text()); await replay(data); } catch (err) { alert('读取失败：' + err.message); }
  e.target.value = '';
};

// ===== 事件渲染 =====
let seatEls = new Map();
let viewPlayers = []; // 当前展示用的玩家列表（对局或回放）

function onPhase({ phase, day }) {
  const t = $('table');
  t.classList.toggle('night', phase === 'night');
  t.classList.toggle('day', ['day', 'speech', 'freetalk', 'vote'].includes(phase));
  const icons = { setup: '🎲', night: '🌙', day: '☀️', speech: '🗣️', freetalk: '💬', vote: '🗳️', end: '🏁', aborted: '⏹️' };
  const names = { setup: '分发身份', night: `第${day}夜`, day: `第${day}天`, speech: `第${day}天 · 轮流发言`, freetalk: `第${day}天 · 自由讨论`, vote: `第${day}天 · 投票`, end: '结束', aborted: '已终止' };
  $('phase-icon').textContent = icons[phase] || '🐺';
  $('phase-text').textContent = names[phase] || phase;
  $('status').textContent = names[phase] || phase;
  clearActive();
}

function onEvent(e) {
  const log = $('log');
  const el = renderEvent(e);
  if (el) { log.appendChild(el); log.scrollTop = log.scrollHeight; }
  if (e.type === 'start') { viewPlayers = e.players.map(p => ({ ...p, alive: true })); renderSeats(); }
  if (e.type === 'death') { const p = viewPlayers.find(x => x.seat === e.seat); if (p) p.alive = false; renderSeats(); }
  if (e.type === 'speech' || e.type === 'wolf-chat') { setActive(e.seat, e.text); }
  if (e.type === 'end') { $('status').textContent = e.text; }
  if (selectedSeat && game) renderMind(selectedSeat);
}

function renderEvent(e) {
  const d = document.createElement('div');
  const p = viewPlayers.find(x => x.seat === e.seat);
  const who = p ? `${p.seat}号 ${p.name}` : e.seat ? `${e.seat}号` : '';
  switch (e.type) {
    case 'start': d.className = 'evt system strong'; d.textContent = e.text; return d;
    case 'system': d.className = 'evt system' + (/^——/.test(e.text) ? ' strong' : ''); d.textContent = e.text; return d;
    case 'speech': {
      d.className = 'evt speech' + (e.free ? ' free' : '') + (e.lastWords ? ' last' : '') + (e.pk ? ' pk' : '');
      const label = e.lastWords ? '遗言' : e.free ? '补充' : e.pk ? '平票发言' : '';
      d.innerHTML = `<div class="who">${esc(who)}${label ? `<span class="tagx">${label}</span>` : ''}<span class="model">${esc(p?.modelLabel || '')}</span></div><div class="text">${esc(e.text)}</div>`;
      return d;
    }
    case 'wolf-chat': d.className = 'evt wolf god-only'; d.innerHTML = `<div class="who">🐺 狼人频道 · ${esc(who)}</div><div class="text">${esc(e.text)}</div>`; return d;
    case 'vote': d.className = 'evt vote'; d.innerHTML = `<div>🗳️ ${esc(e.text)}</div><div class="detail">${esc(e.detail)}</div>`; return d;
    case 'death': d.className = 'evt death god-only'; d.textContent = '✝ ' + e.text; return d;
    case 'end': d.className = 'evt end'; d.innerHTML = `${esc(e.text)}<div class="roles">${e.roles.map(r => `${r.seat}号 ${esc(r.name)}=${ROLES[r.role].icon}${ROLES[r.role].name}`).join('　')}</div>`; return d;
    case 'error': d.className = 'evt error god-only'; d.textContent = '⚠️ ' + e.text; return d;
    case 'pass': return null;
    default: {
      // 决定类：vote-reason / night-* / hunter
      d.className = 'evt private god-only' + (e.fallback ? ' fallback' : '');
      const icon = { 'vote-reason': '🗳️', 'night-wolf': '🐺', 'night-seer': '🔮', 'night-guard': '🛡️', 'night-witch': '🧪', hunter: '🏹' }[e.type] || '•';
      const reason = e.reasoning ? stripFinal(e.reasoning, e.keyword) : '';
      d.innerHTML = `${icon} ${esc(who)} ${esc(e.text)}${e.fallback ? '（没解析出决定，系统代选）' : ''}${reason ? `<span class="reason">${esc(reason)}</span>` : ''}`;
      return d;
    }
  }
}
function stripFinal(text, keyword) {
  let s = String(text).replace(/<notes>[\s\S]*?<\/notes>/gi, '').trim();
  const lines = s.split('\n');
  while (lines.length && (!lines[lines.length - 1].trim() || (keyword && new RegExp(`^\\W*${keyword}\\s*[:：]`).test(lines[lines.length - 1].trim())) || /^(救|毒|不用药)/.test(lines[lines.length - 1].trim()))) lines.pop();
  return lines.join('\n').trim().slice(0, 400);
}
function appendSystem(text, cls = 'system') { const d = document.createElement('div'); d.className = 'evt ' + cls; d.textContent = text; $('log').appendChild(d); }

// ===== 座位 =====
function renderSeats() {
  const table = $('table');
  for (const el of seatEls.values()) el.remove();
  seatEls = new Map();
  const list = viewPlayers;
  if (!list.length) return;
  const n = list.length;
  list.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'seat' + (p.alive ? '' : ' dead') + (p.seat === selectedSeat ? ' selected' : '');
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    el.style.left = `${50 + 42 * Math.cos(ang)}%`;
    el.style.top = `${50 + 42 * Math.sin(ang)}%`;
    const r = ROLES[p.role];
    const showRole = settings.god || p.human || !p.alive && game?.phase === 'end';
    el.innerHTML = `<div class="avatar">${p.human ? '🙂' : AVATARS[i % AVATARS.length]}</div><div class="name"><small>${p.seat}号</small>${esc(p.name)}</div><div class="model">${esc(p.modelLabel || '')}</div>${showRole && r ? `<div class="role ${r.team}">${r.icon} ${r.name}</div>` : ''}`;
    el.title = p.persona?.bio || p.persona || '';
    el.onclick = () => { selectedSeat = p.seat; renderSeats(); showTab('mind'); renderMind(p.seat); };
    table.appendChild(el);
    seatEls.set(p.seat, el);
  });
}
const AVATARS = ['🧔', '👩', '👨‍🦳', '👧', '🧑', '👩‍🦰', '👨', '👵', '🧓', '👱', '👩‍🦱', '🧑‍🦲'];
let bubbleTimer = null;
function setActive(seat, text) {
  clearActive();
  const el = seatEls.get(seat);
  if (!el) return;
  el.classList.add('active');
  if (text) { const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text.length > 70 ? text.slice(0, 70) + '…' : text; el.appendChild(b); }
  bubbleTimer = setTimeout(clearActive, Math.max(1500, settings.speed > 0 ? settings.speed : 2500));
}
function clearActive() {
  clearTimeout(bubbleTimer);
  for (const el of seatEls.values()) { el.classList.remove('active'); el.querySelector('.bubble')?.remove(); }
}

// ===== 心里话 =====
function showTab(name) {
  for (const t of document.querySelectorAll('.log-tabs .tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('log').hidden = name !== 'log'; $('mind').hidden = name !== 'mind';
}
for (const t of document.querySelectorAll('.log-tabs .tab')) t.onclick = () => showTab(t.dataset.tab);
function renderMind(seat) {
  const box = $('mind-content');
  const p = (game ? game.players : replayPlayers).find(x => x.seat === seat);
  if (!p) { box.innerHTML = ''; return; }
  if (!settings.god && !p.human) { box.innerHTML = '<p class="hint">关闭上帝视角时不能偷看 AI 的心里话。</p>'; return; }
  const system = p.agent ? p.agent.system : p.system;
  const history = p.agent ? p.agent.history : p.history;
  const parts = [`<h3>${p.seat}号 ${esc(p.name)} · ${ROLES[p.role].icon}${ROLES[p.role].name} · ${esc(p.modelLabel || '')}</h3>`];
  parts.push(`<div class="msg system"><span class="lbl">系统提示</span>${esc(system || '')}</div>`);
  for (const m of history || []) parts.push(`<div class="msg ${m.role}"><span class="lbl">${m.role === 'user' ? '它听到 / 被问到' : '它的回答'}</span>${esc(m.content)}</div>`);
  if (p.agent?.pending?.length) parts.push(`<div class="msg user"><span class="lbl">还没发给它的事件</span>${esc(p.agent.pending.join('\n'))}</div>`);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = parts.join('');
  if (atBottom) $('mind').scrollTop = $('mind').scrollHeight;
}

// ===== 真人 =====
function humanAsk({ task, events }) {
  return new Promise(resolve => {
    humanResolver = resolve;
    $('human-bar').hidden = false;
    $('human-task').textContent = (events.length ? events.join('\n') + '\n\n' : '') + task;
    const opts = $('human-options'); opts.innerHTML = '';
    const kwm = /写[:：]\s*([一-龥]{1,3})[:：]X号/.exec(task) || /最后单独一行写你的决定/.test(task) && { 1: null };
    const seats = [...new Set([...task.matchAll(/(\d{1,2})号 [^、，。；（）\s]+/g)].map(m => m[0]))];
    const isDecision = !!kwm;
    if (isDecision) {
      const kw = kwm[1];
      if (/救：/.test(task)) addOpt('救', '救');
      for (const s of seats) addOpt(s, kw ? `${kw}：${s}` : `毒：${s}`);
      if (/弃票|空刀|不守|不开|不用药/.test(task)) addOpt('不选 / 弃权', kw ? `${kw}：无` : '不用药');
    } else if (/自由讨论/.test(task)) addOpt('过（不补充）', '过');
    function addOpt(label, value) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => submitHuman(value); opts.appendChild(b); }
    $('human-text').value = '';
    $('human-text').focus();
    $('human-bar').scrollIntoView({ block: 'nearest' });
  });
}
function submitHuman(v) {
  if (!humanResolver) return;
  const r = humanResolver; humanResolver = null;
  $('human-bar').hidden = true;
  r(v);
}
$('human-send').onclick = () => submitHuman($('human-text').value.trim() || '（沉默）');
$('human-text').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('human-send').onclick(); } };

// ===== 回放 =====
let replayPlayers = [];
async function replay(data) {
  if (game && game.phase !== 'end' && game.phase !== 'aborted') { if (!confirm('当前有对局在进行，终止并回放？')) return; game.abort(); stepResolve(); }
  game = null;
  $('log').innerHTML = ''; $('mind-content').innerHTML = '';
  replayPlayers = data.players || [];
  viewPlayers = replayPlayers.map(p => ({ ...p, alive: true }));
  renderSeats();
  $('status').textContent = '回放中';
  setControls(false);
  $('btn-export').disabled = true;
  let lastPhase = null;
  for (const e of data.log || []) {
    if (e.phase !== lastPhase) { onPhase({ phase: e.phase, day: e.day }); lastPhase = e.phase; }
    onEvent(e);
    if (['speech', 'wolf-chat', 'vote', 'system', 'end'].includes(e.type)) {
      if (settings.speed > 0) await new Promise(r => setTimeout(r, Math.min(settings.speed, 2500)));
    }
  }
  $('status').textContent = '回放结束';
  // 回放里也能看心里话
  selectedSeat = null;
}

// ===== 工具 =====
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ===== 初始化 =====
renderModels(); renderComposition(); renderSeatAssign();
onPhase({ phase: 'idle', day: 0 });
$('phase-text').textContent = '等待开局';
$('status').textContent = '未开始';
if (location.search.includes('demo=1')) startGame(true);
