import { Game } from './engine.js';
import { ROLES, presetFor, expandComposition, describeComposition, roleCard } from './roles.js';
import { PERSONAS, pickPersonas } from './personas.js';
import { AIAgent, HumanAgent } from './agent.js';
import { createProvider, PROVIDER_PRESETS, detectType, MockProvider } from './providers.js';

const $ = id => document.getElementById(id);
const LS_MODELS = 'aiwolf.models.v1';
const LS_SETTINGS = 'aiwolf.settings.v1';
const MAX_SEATS = 12;

// ===== 持久化 =====
function loadJSON(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } }
function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { console.warn('保存失败', e); } }

let models = loadJSON(LS_MODELS, []);
let settings = Object.assign({
  playerCount: 9, composition: null, roster: null,
  witchSelfSave: false, firstNightLastWords: true, freeTalk: true, winMode: 'side', wolfChatRounds: 1,
  speed: 800, god: true, auto: true,
}, loadJSON(LS_SETTINGS, {}));
if (!settings.composition) settings.composition = { ...presetFor(settings.playerCount) };
if (settings.speed < 0) { settings.speed = 800; settings.auto = false; } // 旧版的"逐步"档
// 名册：12 个座位各自的名字、人设、头像、指定模型、指定身份。只用前 N 个。
function freshSeat(p) { return { name: p.name, bio: p.bio, modelId: '', fixedRole: '', avatar: '' }; }
if (!Array.isArray(settings.roster) || settings.roster.length !== MAX_SEATS) settings.roster = pickPersonas(MAX_SEATS).map(freshSeat);
function persist() { saveJSON(LS_MODELS, models); saveJSON(LS_SETTINGS, settings); }
persist();

const isPhone = () => window.matchMedia('(max-width: 720px)').matches;
const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const enabledModels = () => models.filter(m => m.enabled !== false);
const modelById = id => models.find(m => m.id === id);

// ===== 对局状态 =====
let game = null;            // 进行中或刚结束的对局
let session = 'idle';       // idle | running | ended | replay
let viewPlayers = [];       // 当前展示的玩家（对局或回放）
let replayPlayers = [];
let stepWaiters = [];
let humanResolver = null;
let mindSeat = null;
let seatMeta = new Map();   // seat -> { avatar, human }

// ===== 设置面板 =====
function settingsSummary() {
  const n = settings.playerCount;
  const ms = enabledModels().length;
  $('settings-summary-text').textContent = `${n} 人 · ${describeComposition(settings.composition)} · 模型 ${ms} 个`;
}
function setSettingsOpen(open) {
  $('settings-body').hidden = !open;
  $('settings-summary-toggle').textContent = open ? '收起' : '展开';
}
$('settings-summary').onclick = () => setSettingsOpen($('settings-body').hidden);
$('btn-toggle-settings').onclick = () => {
  const panel = $('settings-panel');
  const collapsed = panel.classList.toggle('collapsed');
  $('btn-toggle-settings').textContent = collapsed ? '▼ 展开设置' : '▲ 收起设置';
  if (!collapsed) setSettingsOpen(true);
};
function collapseSettings() { $('settings-panel').classList.add('collapsed'); $('btn-toggle-settings').textContent = '▼ 展开设置'; }

function renderModels() {
  const ul = $('model-list');
  ul.innerHTML = '';
  if (!models.length) ul.innerHTML = '<li class="empty">还没有模型。点「添加」填一个接口，或者在「更多功能」里先用假模型试跑。</li>';
  for (const m of models) {
    const li = document.createElement('li');
    li.className = m.enabled === false ? 'disabled' : '';
    li.innerHTML = `<input type="checkbox" ${m.enabled !== false ? 'checked' : ''} title="参与随机分配">
      <span class="mname">${esc(m.label)}<span class="meta">${esc(m.type)} · ${esc(m.model)}</span></span>
      <button class="btn small" data-act="edit">编辑</button><button class="btn small" data-act="del">删</button>`;
    li.querySelector('input').onchange = e => { m.enabled = e.target.checked; persist(); refreshAll(); };
    li.querySelector('[data-act=edit]').onclick = () => openModelDialog(m);
    li.querySelector('[data-act=del]').onclick = () => {
      if (!confirm(`删除「${m.label}」？`)) return;
      models = models.filter(x => x !== m);
      for (const s of settings.roster) if (s.modelId === m.id) s.modelId = '';
      persist(); refreshAll();
    };
    ul.appendChild(li);
  }
}

const pc = $('player-count');
for (let n = 6; n <= MAX_SEATS; n++) { const o = document.createElement('option'); o.value = n; o.textContent = `${n} 人`; pc.appendChild(o); }
pc.value = settings.playerCount;
pc.onchange = () => { settings.playerCount = +pc.value; settings.composition = { ...presetFor(settings.playerCount) }; persist(); refreshAll(); };

function renderComposition() {
  const box = $('composition');
  box.innerHTML = '';
  for (const id of ['wolf', 'seer', 'witch', 'hunter', 'guard', 'villager']) {
    const l = document.createElement('label');
    l.innerHTML = `${ROLES[id].icon} ${ROLES[id].name}<input type="number" inputmode="numeric" min="0" max="${id === 'wolf' || id === 'villager' ? 6 : 1}" value="${settings.composition[id] || 0}">`;
    l.querySelector('input').onchange = e => { settings.composition[id] = Math.max(0, +e.target.value | 0); persist(); refreshAll(); };
    box.appendChild(l);
  }
  const total = expandComposition(settings.composition).length;
  if (total !== settings.playerCount) {
    const d = document.createElement('div'); d.className = 'bad';
    d.textContent = `角色总数 ${total}，和人数 ${settings.playerCount} 不一致`;
    box.appendChild(d);
  }
}
function bindCheck(id, key, after) { $(id).checked = !!settings[key]; $(id).onchange = e => { settings[key] = e.target.checked; persist(); after && after(); }; }
bindCheck('opt-selfsave', 'witchSelfSave'); bindCheck('opt-lastwords', 'firstNightLastWords'); bindCheck('opt-freetalk', 'freeTalk');
bindCheck('god-view', 'god', () => { applyGod(); renderSeats(); });
$('opt-winmode').value = settings.winMode; $('opt-winmode').onchange = e => { settings.winMode = e.target.value; persist(); };
$('opt-wolfrounds').value = settings.wolfChatRounds; $('opt-wolfrounds').onchange = e => { settings.wolfChatRounds = +e.target.value; persist(); };
$('speed').value = String(settings.speed); $('speed').onchange = e => { settings.speed = +e.target.value; persist(); };
function applyGod() { document.body.classList.toggle('god', !!settings.god); $('god-view').checked = !!settings.god; }
$('btn-more').onclick = () => { $('more-body').hidden = !$('more-body').hidden; };
$('btn-reroll').onclick = () => {
  if (!confirm('把所有座位的名字和人设换成一批随机的？头像、指定的模型和身份会保留。')) return;
  const ps = pickPersonas(MAX_SEATS);
  settings.roster.forEach((s, i) => { s.name = ps[i].name; s.bio = ps[i].bio; });
  persist(); refreshAll();
};

function refreshAll() { renderModels(); renderComposition(); settingsSummary(); renderSeats(); }

// ===== 模型库弹窗 =====
const modelDlg = $('model-dialog');
let editingModel = null;
let afterModelSave = null;
function openModelDialog(m, after = null) {
  editingModel = m || null; afterModelSave = after;
  $('model-dialog-title').textContent = m ? '编辑模型' : '添加模型';
  $('mf-preset').value = '';
  $('mf-label').value = m?.label || '';
  $('mf-type').value = m?.type || 'openai';
  $('mf-url').value = m?.baseUrl || '';
  $('mf-model').value = m?.model || '';
  $('mf-key').value = m?.apiKey || '';
  $('mf-test-result').textContent = '';
  modelDlg.showModal();
}
for (const p of PROVIDER_PRESETS) { const o = document.createElement('option'); o.value = p.label; o.textContent = p.label; $('mf-preset').appendChild(o); }
$('mf-preset').onchange = () => {
  const p = PROVIDER_PRESETS.find(x => x.label === $('mf-preset').value);
  if (!p) return;
  $('mf-type').value = p.type; $('mf-url').value = p.baseUrl; $('mf-model').value = p.model;
  if (!$('mf-label').value) $('mf-label').value = p.label;
};
$('mf-url').onchange = () => { const t = detectType($('mf-url').value); if (t !== 'openai') $('mf-type').value = t; };
$('mf-cancel').onclick = () => modelDlg.close();
$('btn-add-model').onclick = () => openModelDialog(null);
function readModelForm() {
  return { label: $('mf-label').value.trim() || $('mf-model').value.trim(), type: $('mf-type').value, baseUrl: $('mf-url').value.trim(), model: $('mf-model').value.trim(), apiKey: $('mf-key').value.trim() };
}
$('model-form').onsubmit = e => {
  e.preventDefault();
  const v = readModelForm();
  let m = editingModel;
  if (m) Object.assign(m, v); else { m = { id: 'm' + Date.now(), enabled: true, ...v }; models.push(m); }
  persist(); refreshAll(); modelDlg.close();
  if (afterModelSave) afterModelSave(m);
};
async function testModel(cfg, out) {
  out.textContent = '测试中…';
  try {
    const r = await createProvider(cfg).chat({ system: '你是一个测试助手。', messages: [{ role: 'user', content: '只回复两个字：收到' }], temperature: 0, maxTokens: 20 });
    out.textContent = `✓ 返回：${String(r).slice(0, 40)}`;
  } catch (err) { out.textContent = `✗ ${err.message}`; }
}
$('mf-test').onclick = () => testModel(readModelForm(), $('mf-test-result'));

// ===== 座位弹窗 =====
const seatDlg = $('seat-dialog');
let editingSeat = -1;
let draftAvatar = '';
function fillSeatModelSelect(selected) {
  const sel = $('sf-model');
  sel.innerHTML = `<option value="">随机（从模型库里勾选的模型中抽）</option>` +
    models.map(m => `<option value="${m.id}">${esc(m.label)} · ${esc(m.model)}</option>`).join('') +
    `<option value="human">真人（我自己坐这个位置）</option>`;
  sel.value = selected && (selected === 'human' || modelById(selected)) ? selected : '';
}
function openSeatDialog(i) {
  editingSeat = i;
  const s = settings.roster[i];
  $('sf-title').textContent = `⚙ P${i + 1} ${s.name}`;
  $('sf-role').innerHTML = `<option value="">身份(随机)</option>` + Object.values(ROLES).map(r => `<option value="${r.id}">${r.icon} ${r.name}</option>`).join('');
  $('sf-role').value = s.fixedRole || '';
  $('sf-name').value = s.name;
  $('sf-bio').value = s.bio;
  fillSeatModelSelect(s.modelId);
  draftAvatar = s.avatar || '';
  paintAvatar($('sf-avatar'), draftAvatar, '?');
  $('sf-test-result').textContent = '';
  seatDlg.showModal();
}
$('sf-cancel').onclick = () => seatDlg.close();
$('sf-random').onclick = () => {
  const used = new Set(settings.roster.map((s, i) => (i === editingSeat ? '' : s.name)));
  const pool = PERSONAS.filter(p => !used.has(p.name) && p.name !== $('sf-name').value);
  const p = pool[Math.floor(Math.random() * pool.length)];
  if (p) { $('sf-name').value = p.name; $('sf-bio').value = p.bio; }
};
$('sf-new-model').onclick = () => openModelDialog(null, m => fillSeatModelSelect(m.id));
$('sf-test').onclick = () => {
  const id = $('sf-model').value;
  const out = $('sf-test-result');
  if (id === 'human') { out.textContent = '真人不用测试。'; return; }
  const m = id ? modelById(id) : enabledModels()[0];
  if (!m) { out.textContent = '模型库里还没有可用的模型。'; return; }
  testModel(m, out);
};
$('sf-upload').onclick = () => $('sf-file').click();
$('sf-clear-avatar').onclick = () => { draftAvatar = ''; paintAvatar($('sf-avatar'), '', '?'); };
$('sf-file').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { draftAvatar = await shrinkImage(f, 128); paintAvatar($('sf-avatar'), draftAvatar, '?'); }
  catch (err) { alert('这张图读不了：' + err.message); }
};
$('seat-form').onsubmit = e => {
  e.preventDefault();
  const name = $('sf-name').value.trim();
  if (!name) return;
  if (settings.roster.some((s, i) => i !== editingSeat && s.name === name)) { alert(`已经有一个座位叫「${name}」了，名字不能重复。`); return; }
  const s = settings.roster[editingSeat];
  const modelId = $('sf-model').value;
  if (modelId === 'human') for (const o of settings.roster) if (o !== s && o.modelId === 'human') o.modelId = ''; // 只有一个真人位
  Object.assign(s, { name, bio: $('sf-bio').value.trim(), modelId, fixedRole: $('sf-role').value, avatar: draftAvatar });
  persist(); refreshAll(); seatDlg.close();
};
// 头像缩到 128px 再存，避免把 localStorage 撑爆
function shrinkImage(file, size) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('不是有效的图片')); };
    img.src = url;
  });
}
function paintAvatar(el, src, fallback) {
  el.textContent = '';
  if (src) { const im = document.createElement('img'); im.src = src; im.alt = ''; el.appendChild(im); }
  else el.textContent = fallback;
}

// ===== 座位栏 =====
let seatEls = new Map();
function seatModelLabel(s) {
  if (s.modelId === 'human') return '真人';
  const m = s.modelId && modelById(s.modelId);
  return m ? m.label : '随机模型';
}
function showRole(p) { return !!p.role && (settings.god || p.human || session === 'ended'); }
function renderSeats() {
  const left = $('seats-left'), right = $('seats-right');
  left.innerHTML = ''; right.innerHTML = '';
  seatEls = new Map();
  const inGame = viewPlayers.length > 0;
  const list = inGame ? viewPlayers
    : settings.roster.slice(0, settings.playerCount).map((s, i) => ({ seat: i + 1, name: s.name, modelLabel: seatModelLabel(s), avatar: s.avatar, alive: true, human: s.modelId === 'human', fixedRole: s.fixedRole }));
  const half = Math.ceil(list.length / 2);
  list.forEach((p, i) => {
    const el = document.createElement('button');
    el.className = 'seat' + (p.alive ? '' : ' dead') + (p.human ? ' human' : '');
    const r = ROLES[p.role];
    const reveal = inGame && showRole(p) && r;
    let tag = '未知', tagCls = '';
    if (reveal) { tag = `${r.icon} ${r.name}`; tagCls = r.team; }
    else if (!inGame && p.fixedRole) tag = `指定：${ROLES[p.fixedRole].name}`;
    if (inGame && !p.alive) tag = reveal ? `${r.name} · 出局` : '出局';
    el.innerHTML = `<span class="avatar"></span><span class="info"><span class="name">${esc(p.name)}</span><span class="pid">P${p.seat} · ${esc(p.modelLabel || '')}</span></span><span class="tag ${tagCls}">${esc(tag)}</span>`;
    paintAvatar(el.querySelector('.avatar'), p.avatar, reveal ? r.icon : '?');
    el.onclick = () => (inGame ? openMind(p.seat) : openSeatDialog(i));
    (i < half ? left : right).appendChild(el);
    seatEls.set(p.seat, el);
  });
}
function setActive(seat) {
  for (const el of seatEls.values()) el.classList.remove('active');
  seatEls.get(seat)?.classList.add('active');
}
const busySeats = new Set();
function onBusy(seat, on) {
  if (on) busySeats.add(seat); else busySeats.delete(seat);
  seatEls.get(seat)?.classList.toggle('thinking', on);
}

// ===== 开局 / 继续 / 自动 =====
async function gate() {
  if (!settings.auto) await new Promise(r => stepWaiters.push(r));
  else if (settings.speed > 0) await new Promise(r => setTimeout(r, settings.speed));
}
function releaseSteps() { const ws = stepWaiters; stepWaiters = []; ws.forEach(f => f()); }
function paintControls() {
  const running = session === 'running';
  $('btn-start').disabled = running;
  $('btn-start').textContent = session === 'ended' || session === 'replay' ? '▷ 再开一局' : '▷ 开局';
  $('btn-step').disabled = !running || settings.auto;
  $('btn-auto').classList.toggle('off', !settings.auto);
  $('btn-auto').textContent = settings.auto ? '⟳ 自动' : '⟳ 手动';
  $('btn-demo').disabled = running;
  $('btn-export').disabled = !game;
  $('btn-back').disabled = session === 'idle';
}
$('btn-step').onclick = () => releaseSteps();
$('btn-auto').onclick = () => { settings.auto = !settings.auto; persist(); paintControls(); if (settings.auto) releaseSteps(); };
$('btn-start').onclick = () => startGame(false);
$('btn-demo').onclick = () => startGame(true);
$('btn-back').onclick = () => {
  if (session === 'running') {
    if (!confirm('终止这一局？')) return;
    game.abort(); releaseSteps(); if (humanResolver) submitHuman('（沉默）');
    return;
  }
  resetToIdle();
};
function resetToIdle() {
  session = 'idle'; game = null; viewPlayers = []; replayPlayers = [];
  $('log').innerHTML = ''; $('human-bar').hidden = true;
  setStatus('第0回', '等待中', '存活:0');
  paintControls(); renderSeats();
}
function setStatus(round, phase, alive) {
  if (round != null) $('stat-round').textContent = round;
  if (phase != null) $('stat-phase').textContent = phase;
  if (alive != null) $('stat-alive').textContent = alive;
}

function assignRoles(n) {
  const pool = expandComposition(settings.composition);
  if (pool.length !== n) throw new Error('角色总数和人数不一致，请先在设置里调整');
  const out = new Array(n).fill(null);
  settings.roster.slice(0, n).forEach((s, i) => {
    const k = s.fixedRole ? pool.indexOf(s.fixedRole) : -1;
    if (k >= 0) { out[i] = s.fixedRole; pool.splice(k, 1); }
  });
  shuffle(pool);
  for (let i = 0; i < n; i++) if (!out[i]) out[i] = pool.pop();
  return out;
}
function buildPlayers(mock) {
  const n = settings.playerCount;
  const seats = settings.roster.slice(0, n);
  const names = seats.map(s => s.name);
  if (new Set(names).size !== n) throw new Error('有座位重名了，请先改成不同的名字');
  const roles = assignRoles(n);
  const ms = enabledModels();
  seatMeta = new Map();
  return seats.map((s, i) => {
    const seat = i + 1;
    const persona = { name: s.name, bio: s.bio || '（没有写人设）' };
    const base = { seat, name: s.name, role: roles[i], persona };
    if (s.modelId === 'human' && !mock) {
      seatMeta.set(seat, { avatar: s.avatar, human: true });
      return { ...base, persona: { name: s.name, bio: '真人玩家。' }, modelLabel: '真人', agent: new HumanAgent({ onAsk: humanAsk }), human: true };
    }
    seatMeta.set(seat, { avatar: s.avatar, human: false });
    if (mock) return { ...base, modelLabel: '假模型', agent: new AIAgent({ provider: new MockProvider({ delay: 40 }), label: '假模型' }) };
    const m = (s.modelId && modelById(s.modelId)) || ms[Math.floor(Math.random() * ms.length)];
    if (!m) throw new Error(`P${seat} ${s.name} 没有可用的模型。请先在「设置 → 模型库」里添加，或者在「更多功能」里用假模型试跑。`);
    return { ...base, modelLabel: m.label, agent: new AIAgent({ provider: createProvider(m), label: m.label }) };
  });
}

async function startGame(mock = false) {
  let players;
  try { players = buildPlayers(mock); }
  catch (e) {
    alert(e.message);
    $('settings-panel').classList.remove('collapsed'); setSettingsOpen(true);
    return;
  }
  $('log').innerHTML = '';
  collapseSettings();
  stepWaiters = []; busySeats.clear();
  // 自己上桌时默认关掉上帝视角，不然等于看着答案玩
  if (players.some(p => p.human) && settings.god) { settings.god = false; persist(); applyGod(); }
  game = new Game({
    cfg: { playerCount: settings.playerCount, composition: settings.composition, witchSelfSave: settings.witchSelfSave, firstNightLastWords: settings.firstNightLastWords, freeTalk: settings.freeTalk, winMode: settings.winMode, wolfChatRounds: settings.wolfChatRounds },
    players,
    hooks: { onEvent, onPhase, onBusy, gate },
  });
  window.game = game;
  session = 'running';
  paintControls();
  const g = game;
  try { await g.run(); }
  catch (e) { console.error(e); appendNote(`出错了：${e.message}`, 'error'); }
  if (game !== g) return;
  session = 'ended';
  $('human-bar').hidden = true;
  paintControls(); renderSeats();
}

// ===== 事件 =====
const PHASE_NAMES = { setup: '分发身份', night: '夜晚行动', day: '天亮了', speech: '轮流发言', freetalk: '自由讨论', vote: '投票', end: '结束', aborted: '已终止' };
function onPhase({ phase, day }) {
  const night = phase === 'night';
  setStatus(day ? `第${day}${night ? '夜' : '天'}` : '第0回', PHASE_NAMES[phase] || phase, null);
  for (const el of seatEls.values()) el.classList.remove('active');
}
function aliveText() { return `存活:${viewPlayers.filter(p => p.alive).length}`; }

function onEvent(e) {
  if (e.type === 'start') {
    viewPlayers = e.players.map(p => ({ ...p, alive: true, avatar: seatMeta.get(p.seat)?.avatar || '', human: !!seatMeta.get(p.seat)?.human }));
    renderSeats(); setStatus(null, null, aliveText());
  }
  const log = $('log');
  const el = renderEvent(e);
  if (el) { log.appendChild(el); log.scrollTop = log.scrollHeight; }
  if (e.type === 'start' && game) tellHumanRole();
  if (e.type === 'death') { const p = viewPlayers.find(x => x.seat === e.seat); if (p) p.alive = false; renderSeats(); for (const s of busySeats) seatEls.get(s)?.classList.add('thinking'); setStatus(null, null, aliveText()); }
  if (e.type === 'speech' || e.type === 'wolf-chat') setActive(e.seat);
  if (e.type === 'end') { setStatus(null, e.winner === 'wolf' ? '狼人胜' : e.winner === 'village' ? '好人胜' : '平局', null); }
  if (mindSeat && $('mind-dialog').open) renderMind();
}
// 真人看不到系统提示，开局时把身份单独告诉他
function tellHumanRole() {
  const me = game.players.find(p => p.human);
  if (!me) return;
  const mates = me.role === 'wolf' ? game.players.filter(q => q.role === 'wolf' && q !== me).map(q => game.tag(q)) : [];
  appendNote(`你坐在 ${me.seat}号，名字是 ${me.name}。\n${roleCard(me.role, { teammates: mates, witchSelfSave: settings.witchSelfSave })}`, 'you');
}

function renderEvent(e) {
  const d = document.createElement('div');
  const p = viewPlayers.find(x => x.seat === e.seat);
  const who = p ? `${p.seat}号 ${p.name}` : e.seat ? `${e.seat}号` : '';
  switch (e.type) {
    case 'start': d.className = 'evt system strong'; d.textContent = e.text; return d;
    case 'system': d.className = 'evt system' + (/^——/.test(e.text) ? ' strong' : ''); d.textContent = e.text; return d;
    case 'speech': {
      d.className = 'evt speech' + (e.free ? ' free' : '') + (e.lastWords ? ' last' : '');
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
      d.className = 'evt private god-only' + (e.fallback ? ' fallback' : '');
      const icon = { 'vote-reason': '🗳️', 'night-wolf': '🐺', 'night-seer': '🔮', 'night-guard': '🛡️', 'night-witch': '🧪', hunter: '🏹' }[e.type] || '•';
      const reason = e.reasoning ? stripFinal(e.reasoning, e.keyword) : '';
      d.innerHTML = `${icon} ${esc(who)} ${esc(e.text)}${e.fallback ? '（没解析出决定，系统代选）' : ''}${reason ? `<span class="reason">${esc(reason)}</span>` : ''}`;
      return d;
    }
  }
}
function stripFinal(text, keyword) {
  const s = String(text).replace(/<notes>[\s\S]*?<\/notes>/gi, '').trim();
  const lines = s.split('\n');
  const isFinal = l => !l.trim() || (keyword && new RegExp(`^\\W*${keyword}\\s*[:：]`).test(l.trim())) || /^(救|毒|不用药)/.test(l.trim());
  while (lines.length && isFinal(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trim().slice(0, 400);
}
function appendNote(text, cls = 'system') { const d = document.createElement('div'); d.className = 'evt ' + cls; d.textContent = text; const log = $('log'); log.appendChild(d); log.scrollTop = log.scrollHeight; }

// ===== 心里话 =====
function openMind(seat) { mindSeat = seat; renderMind(); if (!$('mind-dialog').open) $('mind-dialog').showModal(); }
$('mind-close').onclick = () => $('mind-dialog').close();
function renderMind() {
  const box = $('mind-content');
  const p = (game ? game.players : replayPlayers).find(x => x.seat === mindSeat);
  if (!p) { box.innerHTML = ''; return; }
  const revealed = settings.god || p.human || session === 'ended';
  $('mind-title').textContent = `P${p.seat} ${p.name}${revealed ? ` · ${ROLES[p.role].icon}${ROLES[p.role].name}` : ''} · ${p.modelLabel || ''}`;
  if (!revealed) { box.innerHTML = '<p class="hint">对局进行中，而且没开上帝视角，不能偷看别人的心里话。打完之后可以看。</p>'; return; }
  const system = p.agent ? p.agent.system : p.system;
  const history = p.agent ? p.agent.history : p.history;
  const parts = [`<div class="msg system"><span class="lbl">系统提示（它开局时知道的全部）</span>${esc(system || '')}</div>`];
  for (const m of history || []) parts.push(`<div class="msg ${m.role}"><span class="lbl">${m.role === 'user' ? '它听到 / 被问到' : '它的回答'}</span>${esc(m.content)}</div>`);
  if (p.agent?.pending?.length) parts.push(`<div class="msg user"><span class="lbl">还没发给它的事件</span>${esc(p.agent.pending.join('\n'))}</div>`);
  box.innerHTML = parts.join('');
}

// ===== 真人 =====
function humanAsk({ task, events }) {
  return new Promise(resolve => {
    humanResolver = resolve;
    $('human-bar').hidden = false;
    $('human-task').textContent = (events.length ? events.join('\n') + '\n\n' : '') + task;
    $('human-task').scrollTop = $('human-task').scrollHeight;
    const opts = $('human-options'); opts.innerHTML = '';
    const kwm = /写[:：]\s*([一-龥]{1,3})[:：]X号/.exec(task) || (/最后单独一行写你的决定/.test(task) && { 1: null });
    const seats = [...new Set([...task.matchAll(/(\d{1,2})号 [^、，。；（）\s]+/g)].map(m => m[0]))];
    const addOpt = (label, value) => { const b = document.createElement('button'); b.className = 'btn small'; b.textContent = label; b.onclick = () => submitHuman(value); opts.appendChild(b); };
    if (kwm) {
      const kw = kwm[1];
      if (/救：/.test(task)) addOpt('救', '救');
      for (const s of seats) addOpt(kw ? s : `毒 ${s}`, kw ? `${kw}：${s}` : `毒：${s}`);
      if (/弃票|空刀|不守|不开|不用药/.test(task)) addOpt(kw ? '不选 / 弃权' : '不用药', kw ? `${kw}：无` : '不用药');
    } else if (/自由讨论/.test(task)) addOpt('过（不补充）', '过');
    $('human-text').value = '';
    $('human-text').focus();
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

// ===== 导出 / 回放 =====
$('btn-export').onclick = () => {
  if (!game) return;
  const data = game.export();
  if (isNativeApp()) {
    // 安卓壳里 <a download> 不生效：改成复制到剪贴板
    navigator.clipboard.writeText(JSON.stringify(data)).then(
      () => alert('整局记录已复制到剪贴板，粘贴到备忘录或发给自己就能保存。'),
      () => alert('复制失败，请在浏览器版里导出。'));
    return;
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `aiwolf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click();
};
$('btn-import').onclick = () => $('file-import').click();
$('file-import').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { await replay(JSON.parse(await f.text())); } catch (err) { alert('读取失败：' + err.message); }
};
async function replay(data) {
  if (session === 'running') { if (!confirm('当前有对局在进行，终止并回放？')) return; game.abort(); releaseSteps(); }
  game = null; session = 'replay';
  $('log').innerHTML = '';
  collapseSettings();
  replayPlayers = data.players || [];
  seatMeta = new Map();
  viewPlayers = replayPlayers.map(p => ({ ...p, alive: true }));
  renderSeats(); paintControls();
  let lastPhase = null;
  for (const e of data.log || []) {
    if (session !== 'replay') return;
    if (e.phase !== lastPhase) { onPhase({ phase: e.phase, day: e.day }); lastPhase = e.phase; }
    onEvent(e);
    if (['speech', 'wolf-chat', 'vote', 'system', 'end'].includes(e.type) && settings.speed > 0) await new Promise(r => setTimeout(r, Math.min(settings.speed, 2500)));
  }
  if (session === 'replay') { session = 'ended'; paintControls(); renderSeats(); }
}

// ===== 安卓版更新提醒 =====
// 包里的 build.json 是"我是第几版"，Release 里的 version.json 是"最新是第几版"。
// 只提醒、不自动装：点「下载新版」交给系统浏览器下载，覆盖安装后 key 和设置都在。
const UPDATE_URL = 'https://github.com/yzouj0031-hub/AI-pro/releases/download/android-latest/version.json';
const LS_SKIP = 'aiwolf.update.skip';
async function checkUpdate(manual = false) {
  const out = $('app-update-result');
  try {
    const local = await (await fetch('build.json', { cache: 'no-store' })).json();
    $('app-version').hidden = false;
    $('app-version-text').textContent = `当前版本 ${local.version}`;
    if (manual) out.textContent = '检查中…';
    const remote = await (await fetch(`${UPDATE_URL}?t=${Date.now()}`, { cache: 'no-store' })).json();
    if (!(remote.build > local.build)) { if (manual) out.textContent = '已经是最新版。'; return; }
    if (manual) out.textContent = `有新版本 ${remote.version}。`;
    if (!manual && Number(localStorage.getItem(LS_SKIP)) === remote.build) return;
    $('update-text').textContent = `有新版本 ${remote.version}${remote.notes ? '：' + remote.notes : ''}`;
    $('update-link').href = remote.apk;
    $('update-skip').onclick = () => { localStorage.setItem(LS_SKIP, String(remote.build)); $('update-bar').hidden = true; };
    $('update-bar').hidden = false;
  } catch (e) {
    if (manual) out.textContent = `检查失败：${e.message}`;
  }
}
$('btn-check-update').onclick = () => checkUpdate(true);
if (isNativeApp()) checkUpdate(false);

// ===== 工具 =====
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ===== 初始化 =====
applyGod();
refreshAll();
paintControls();
setStatus('第0回', '等待中', '存活:0');
// 已经配过模型就把设置收起来，直接看牌桌；没配过就摊开
if (enabledModels().length) { setSettingsOpen(false); if (isPhone()) collapseSettings(); } else setSettingsOpen(true);
if (location.search.includes('demo=1')) startGame(true);
// 浏览器里注册 service worker（可安装、断网可打开）；安卓壳里资源本来就在本地，不需要
if ('serviceWorker' in navigator && !isNativeApp() && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
