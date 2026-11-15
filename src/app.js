import { Game } from './engine.js';
import { ROLES, presetFor, expandComposition } from './roles.js';
import { PERSONAS, pickPersonas, cleanPersonaName, namesClash } from './personas.js';
import { AIAgent, HumanAgent } from './agent.js';
import { createProvider, PROVIDER_PRESETS, detectType, MockProvider, listModels } from './providers.js';

const $ = id => document.getElementById(id);
const LS_MODELS = 'aiwolf.models.v1';
const LS_SETTINGS = 'aiwolf.settings.v1';
const LS_KEYS = 'aiwolf.keys.v1';
const LS_PERSONAS = 'aiwolf.personas.v1';
const LS_MODELCACHE = 'aiwolf.modelcache.v1';

// ===== 持久化 =====
function loadJSON(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } }
function saveJSON(key, v) { localStorage.setItem(key, JSON.stringify(v)); }
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

let keys = loadJSON(LS_KEYS, []);               // [{ id, name, type, baseUrl, apiKey }]
let models = loadJSON(LS_MODELS, []);           // [{ id, label, model, keyId, enabled }]
let customPersonas = loadJSON(LS_PERSONAS, []); // [{ id, name, bio, enabled }]
let modelCache = loadJSON(LS_MODELCACHE, {});   // { keyId: [模型名…] }，上次拉取到的列表
let settings = Object.assign({
  playerCount: 9, composition: null, humanSeat: false, assignMode: 'random', seatModels: {},
  witchSelfSave: false, firstNightLastWords: true, freeTalk: true, winMode: 'side', wolfChatRounds: 1, speed: 2000, god: true,
  personaMode: 'first',
}, loadJSON(LS_SETTINGS, {}));
function persist() { saveJSON(LS_KEYS, keys); saveJSON(LS_MODELS, models); saveJSON(LS_PERSONAS, customPersonas); saveJSON(LS_MODELCACHE, modelCache); saveJSON(LS_SETTINGS, settings); }

function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }
function uniqueKeyName(base, except) {
  let name = base, i = 2;
  while (keys.some(k => k !== except && k.name === name)) name = `${base} ${i++}`;
  return name;
}
// 旧版每个模型各存一份 key：搬进 key 库，相同的接口 + key 合并成一条。
(function migrateInlineKeys() {
  let changed = false;
  for (const m of models) {
    if (m.keyId || !('apiKey' in m || 'baseUrl' in m || 'type' in m)) continue;
    const type = m.type || 'openai', baseUrl = m.baseUrl || '', apiKey = m.apiKey || '';
    let k = keys.find(x => x.type === type && x.baseUrl === baseUrl && x.apiKey === apiKey);
    if (!k) {
      const preset = PROVIDER_PRESETS.find(p => p.type === type && hostOf(p.baseUrl) === hostOf(baseUrl));
      k = { id: newId('k'), name: uniqueKeyName(preset?.label || hostOf(baseUrl) || '未命名接口'), type, baseUrl, apiKey };
      keys.push(k);
    }
    m.keyId = k.id; delete m.type; delete m.baseUrl; delete m.apiKey;
    changed = true;
  }
  if (changed) persist();
})();

const keyOf = m => keys.find(k => k.id === m.keyId) || null;
// 模型 + 它用的 key = 能直接发请求的完整配置
function resolveModel(m) {
  const k = keyOf(m);
  if (!k) throw new Error(`「${m.label || m.model}」用的 key 已经不在了，先给它换一个`);
  return { label: m.label, model: m.model, type: k.type, baseUrl: k.baseUrl, apiKey: k.apiKey };
}
function maskKey(s) { s = String(s || ''); return !s ? '没填 key' : s.length > 10 ? `${s.slice(0, 3)}…${s.slice(-4)}` : '••••'; }

// ===== Key 库 UI =====
function renderKeys() {
  const ul = $('key-list');
  ul.innerHTML = '';
  if (!keys.length) { ul.innerHTML = '<li class="empty">还没有 key。点「添加」存一个。</li>'; }
  keys.forEach((k, i) => {
    const used = models.filter(m => m.keyId === k.id).length;
    const li = document.createElement('li');
    li.innerHTML = `<span class="no">K${i + 1}</span>
      <span class="name">${esc(k.name)}<span class="meta">${esc(hostOf(k.baseUrl) || k.type)} · ${esc(maskKey(k.apiKey))} · ${used} 个模型在用</span></span>
      <button class="small" data-act="edit">编辑</button><button class="small" data-act="del">删</button>`;
    li.querySelector('[data-act=edit]').onclick = () => openKeyDialog(k);
    li.querySelector('[data-act=del]').onclick = () => {
      if (!confirm(used ? `删除「${k.name}」？有 ${used} 个模型在用它，删掉后这些模型会停用，直到给它们换一个 key。` : `删除「${k.name}」？`)) return;
      keys = keys.filter(x => x !== k); delete modelCache[k.id];
      persist(); renderAllLists();
    };
    ul.appendChild(li);
  });
}
const keyNo = k => `K${keys.indexOf(k) + 1}`;

const keyDlg = $('key-dialog');
let editingKey = null, keySaved = null, keyTestList = null;
function openKeyDialog(k, onSaved) {
  editingKey = k || null; keySaved = onSaved || null; keyTestList = null;
  $('key-dialog-title').textContent = k ? '编辑 key' : '添加 key';
  $('kf-preset').value = '';
  $('kf-name').value = k?.name || '';
  $('kf-type').value = k?.type || 'openai';
  $('kf-url').value = k?.baseUrl || '';
  $('kf-key').value = k?.apiKey || '';
  $('kf-key').type = 'password'; $('kf-show').textContent = '显示';
  $('kf-test-result').textContent = '';
  keyDlg.showModal();
}
for (const p of PROVIDER_PRESETS) { const o = document.createElement('option'); o.value = p.label; o.textContent = p.label; $('kf-preset').appendChild(o); }
$('kf-preset').onchange = () => {
  const p = PROVIDER_PRESETS.find(x => x.label === $('kf-preset').value);
  if (!p) return;
  $('kf-type').value = p.type; $('kf-url').value = p.baseUrl;
  if (!$('kf-name').value) $('kf-name').value = uniqueKeyName(p.label, editingKey);
};
$('kf-url').onchange = () => { const t = detectType($('kf-url').value); if (t !== 'openai' || !$('kf-url').value) $('kf-type').value = t; };
$('kf-show').onclick = () => { const show = $('kf-key').type === 'password'; $('kf-key').type = show ? 'text' : 'password'; $('kf-show').textContent = show ? '隐藏' : '显示'; };
$('kf-cancel').onclick = () => keyDlg.close();
$('btn-add-key').onclick = () => openKeyDialog(null);
function readKeyForm() {
  return { name: $('kf-name').value.trim(), type: $('kf-type').value, baseUrl: $('kf-url').value.trim(), apiKey: $('kf-key').value.trim() };
}
const sameEndpoint = (a, b) => a.type === b.type && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey;
$('kf-test').onclick = async () => {
  const out = $('kf-test-result');
  out.textContent = '测试中…';
  const v = readKeyForm();
  try {
    const list = await listModels(v);
    keyTestList = { v, list };
    out.textContent = `能用，拉到 ${list.length} 个模型`;
  } catch (err) { out.textContent = `失败：${err.message}`; }
};
$('key-form').onsubmit = e => {
  e.preventDefault();
  const v = readKeyForm();
  let k = editingKey;
  if (k) {
    if (!sameEndpoint(k, v)) delete modelCache[k.id]; // 接口或 key 变了，旧的模型列表作废
    Object.assign(k, v);
  } else { k = { id: newId('k'), ...v }; keys.push(k); }
  if (keyTestList && sameEndpoint(keyTestList.v, v)) modelCache[k.id] = keyTestList.list;
  persist(); renderAllLists(); keyDlg.close();
  if (keySaved) keySaved(k);
};

// ===== 模型库 UI =====
function renderModels() {
  const ul = $('model-list');
  ul.innerHTML = '';
  if (!models.length) { ul.innerHTML = '<li class="empty">还没有模型。点「添加」选一个，或者先用假模型试跑。</li>'; }
  models.forEach((m, i) => {
    const k = keyOf(m);
    const li = document.createElement('li');
    li.className = (m.enabled === false ? 'disabled' : '') + (k ? '' : ' broken');
    li.innerHTML = `<input type="checkbox" ${m.enabled !== false ? 'checked' : ''} title="参与本局">
      <span class="no">M${i + 1}</span>
      <span class="name">${esc(m.label)}<span class="meta">${k ? esc(m.model) : 'key 已删除，换一个才能用'}</span></span>
      <button class="small" data-act="edit">编辑</button><button class="small" data-act="del">删</button>
      <label class="keysel">用的 key <select>${k ? '' : '<option value="">选一个</option>'}${keys.map(x => `<option value="${x.id}" ${x.id === m.keyId ? 'selected' : ''}>${keyNo(x)} ${esc(x.name)}</option>`).join('')}</select></label>`;
    li.querySelector('input').onchange = e => { m.enabled = e.target.checked; persist(); renderModels(); renderSeatAssign(); };
    li.querySelector('select').onchange = e => { if (e.target.value) { m.keyId = e.target.value; persist(); renderAllLists(); } };
    li.querySelector('[data-act=edit]').onclick = () => openModelDialog(m);
    li.querySelector('[data-act=del]').onclick = () => { if (confirm(`删除「${m.label}」？`)) { models = models.filter(x => x !== m); persist(); renderAllLists(); } };
    ul.appendChild(li);
  });
}
function enabledModels() { return models.filter(m => m.enabled !== false && keyOf(m)); }
function renderAllLists() { renderKeys(); renderModels(); renderSeatAssign(); }

const dlg = $('model-dialog');
let editing = null;
function fillKeySelect(selected) {
  const sel = $('mf-key');
  sel.innerHTML = keys.length ? keys.map(k => `<option value="${k.id}">${keyNo(k)} ${esc(k.name)}</option>`).join('') : '<option value="">还没有 key，点右边新建</option>';
  if (selected && keys.some(k => k.id === selected)) sel.value = selected;
}
function openModelDialog(m) {
  editing = m || null;
  $('model-dialog-title').textContent = m ? '编辑模型' : '添加模型';
  fillKeySelect(m?.keyId || settings.lastKeyId);
  $('mf-label').value = m && m.label !== m.model ? m.label : '';
  $('mf-model').value = m?.model || '';
  $('mf-test-result').textContent = '';
  $('mf-fetch-result').textContent = '';
  renderModelOptions();
  dlg.showModal();
}
// 拉取到的模型列表：输入框里打字就是筛选，点一下填进去
function renderModelOptions() {
  const box = $('mf-model-options');
  const list = modelCache[$('mf-key').value];
  box.hidden = !list;
  if (!list) return;
  const typed = $('mf-model').value.trim();
  const q = typed.toLowerCase();
  const hits = !q || list.includes(typed) ? list : list.filter(id => id.toLowerCase().includes(q));
  box.innerHTML = '';
  $('mf-fetch-result').textContent = `共 ${list.length} 个模型${hits.length < list.length ? `，筛出 ${hits.length} 个` : ''}。点一个填进去，在上面打字可以筛选。`;
  if (!hits.length) { box.innerHTML = '<div class="none">列表里没有匹配的，也可以直接用手填的名字。</div>'; return; }
  for (const id of hits.slice(0, 400)) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = id;
    if (id === typed) b.className = 'picked';
    b.onclick = () => { $('mf-model').value = id; renderModelOptions(); };
    box.appendChild(b);
  }
}
$('mf-model').oninput = renderModelOptions;
$('mf-key').onchange = () => { $('mf-fetch-result').textContent = ''; renderModelOptions(); };
$('mf-new-key').onclick = () => openKeyDialog(null, k => { fillKeySelect(k.id); $('mf-fetch-result').textContent = ''; renderModelOptions(); });
$('mf-fetch').onclick = async () => {
  const out = $('mf-fetch-result');
  const k = keys.find(x => x.id === $('mf-key').value);
  if (!k) { out.textContent = '先选一个 key，或者点「新 key」。'; return; }
  out.textContent = '拉取中…';
  try {
    modelCache[k.id] = await listModels(k);
    persist(); renderModelOptions();
  } catch (err) { out.textContent = `拉取失败：${err.message}（可以直接手填模型名）`; }
};
$('mf-cancel').onclick = () => dlg.close();
$('btn-add-model').onclick = () => openModelDialog(null);
function readModelForm() {
  const model = $('mf-model').value.trim();
  return { label: $('mf-label').value.trim() || model, model, keyId: $('mf-key').value };
}
$('model-form').onsubmit = e => {
  e.preventDefault();
  const v = readModelForm();
  if (!v.keyId) { $('mf-test-result').textContent = '先选一个 key。'; return; }
  if (editing) Object.assign(editing, v); else models.push({ id: newId('m'), enabled: true, ...v });
  settings.lastKeyId = v.keyId;
  persist(); renderAllLists(); dlg.close();
};
$('mf-test').onclick = async () => {
  const out = $('mf-test-result');
  out.textContent = '测试中…';
  try {
    const p = createProvider(resolveModel(readModelForm()));
    const r = await p.chat({ system: '你是一个测试助手。', messages: [{ role: 'user', content: '只回复两个字：收到' }], temperature: 0, maxTokens: 20 });
    out.textContent = `能用，返回：${String(r).slice(0, 40)}`;
  } catch (err) { out.textContent = `失败：${err.message}`; }
};

// ===== 人设 UI =====
function renderPersonas() {
  const ul = $('persona-list');
  ul.innerHTML = '';
  if (!customPersonas.length) { ul.innerHTML = '<li class="empty">还没有自己写的人设，现在用的是内置的。</li>'; }
  customPersonas.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = p.enabled === false ? 'disabled' : '';
    li.innerHTML = `<input type="checkbox" ${p.enabled !== false ? 'checked' : ''} title="上桌">
      <span class="no">P${i + 1}</span>
      <span class="name" title="${esc(p.bio)}">${esc(p.name)}<span class="meta">${esc(p.bio)}</span></span>
      <button class="small" data-act="edit">编辑</button><button class="small" data-act="del">删</button>`;
    li.querySelector('input').onchange = e => { p.enabled = e.target.checked; persist(); renderPersonas(); };
    li.querySelector('[data-act=edit]').onclick = () => openPersonaDialog(p);
    li.querySelector('[data-act=del]').onclick = () => { if (confirm(`删除人设「${p.name}」？`)) { customPersonas = customPersonas.filter(x => x !== p); persist(); renderPersonas(); } };
    ul.appendChild(li);
  });
}
function tablePersonas(n) {
  return pickPersonas(n, Math.random, { custom: customPersonas.filter(p => p.enabled !== false), mode: settings.personaMode });
}
$('builtin-personas').innerHTML = PERSONAS.map(p => `<li><b>${esc(p.name)}</b>：${esc(p.bio)}</li>`).join('');
$('persona-mode').value = settings.personaMode;
$('persona-mode').onchange = e => { settings.personaMode = e.target.value; persist(); };
const personaDlg = $('persona-dialog');
let editingPersona = null;
function openPersonaDialog(p) {
  editingPersona = p || null;
  $('persona-dialog-title').textContent = p ? '编辑人设' : '添加人设';
  $('pf-name').value = p?.name || '';
  $('pf-bio').value = p?.bio || '';
  $('pf-error').textContent = '';
  personaDlg.showModal();
}
$('btn-add-persona').onclick = () => openPersonaDialog(null);
$('pf-cancel').onclick = () => personaDlg.close();
$('persona-form').onsubmit = e => {
  e.preventDefault();
  const name = cleanPersonaName($('pf-name').value), bio = $('pf-bio').value.trim();
  if (!name || !bio) { $('pf-error').textContent = '名字和描述都要填（名字里的空格和标点会被去掉）。'; return; }
  if (/^\d+号?$/.test(name)) { $('pf-error').textContent = '名字不能是纯数字或座位号，会和「3号」这类说法混在一起。'; return; }
  const clash = customPersonas.find(x => x !== editingPersona && namesClash(x.name, name));
  if (clash) { $('pf-error').textContent = `和已有的「${clash.name}」太像了（名字不能互相包含），换一个。`; return; }
  if (editingPersona) Object.assign(editingPersona, { name, bio }); else customPersonas.push({ id: newId('p'), name, bio, enabled: true });
  persist(); renderPersonas(); personaDlg.close();
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
    l.innerHTML = `${ROLES[id].name}<input type="number" min="0" max="${id === 'wolf' || id === 'villager' ? 6 : 1}" value="${settings.composition[id] || 0}">`;
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
$('btn-close-settings').onclick = () => $('settings').classList.add('collapsed');
const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

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
  const personas = tablePersonas(n);
  const ms = enabledModels();
  const humanSeat = settings.humanSeat ? 1 + Math.floor(Math.random() * n) : 0;
  if (!ms.length && !(humanSeat && n === 1)) throw new Error('至少勾选一个模型，或者用假模型试跑');
  const players = [];
  for (let s = 1; s <= n; s++) {
    const persona = personas[s - 1];
    if (s === humanSeat) {
      players.push({ seat: s, name: persona.name, role: roles[s - 1], persona: { name: persona.name, bio: '真人玩家。' }, modelLabel: '真人（你）', agent: new HumanAgent({ onAsk: humanAsk }), human: true });
      continue;
    }
    let m = null;
    if (settings.assignMode === 'manual' && settings.seatModels[s]) m = ms.find(x => x.id === settings.seatModels[s]) || null;
    if (!m) m = ms[Math.floor(Math.random() * ms.length)];
    players.push({ seat: s, name: persona.name, role: roles[s - 1], persona, modelLabel: m.label, agent: new AIAgent({ provider: createProvider(resolveModel(m)), label: m.label }) });
  }
  return players;
}

function buildMockPlayers() {
  const n = settings.playerCount;
  const roles = expandComposition(settings.composition);
  if (roles.length !== n) throw new Error('角色总数和人数不一致，请先调整配置');
  shuffle(roles);
  const personas = tablePersonas(n);
  return roles.map((role, i) => ({ seat: i + 1, name: personas[i].name, role, persona: personas[i], modelLabel: '假模型', agent: new AIAgent({ provider: new MockProvider({ delay: 50 }), label: '假模型' }) }));
}

async function startGame(mock = false) {
  let players;
  try { players = mock ? buildMockPlayers() : buildPlayers(); } catch (e) { alert(e.message); return; }
  $('log').innerHTML = ''; $('mind-content').innerHTML = '';
  if (isPhone()) $('settings').classList.add('collapsed');
  showTab('log');
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
  const icons = { setup: '发', night: '夜', day: '昼', speech: '言', freetalk: '议', vote: '票', end: '终', aborted: '停' };
  const names = { setup: '分发身份', night: `第${day}夜`, day: `第${day}天`, speech: `第${day}天 · 轮流发言`, freetalk: `第${day}天 · 自由讨论`, vote: `第${day}天 · 投票`, end: '结束', aborted: '已终止' };
  $('phase-icon').textContent = icons[phase] || '狼';
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
    case 'wolf-chat': d.className = 'evt wolf god-only'; d.innerHTML = `<div class="who">狼人频道 · ${esc(who)}</div><div class="text">${esc(e.text)}</div>`; return d;
    case 'vote': d.className = 'evt vote'; d.innerHTML = `<div>${esc(e.text)}</div><div class="detail">${esc(e.detail)}</div>`; return d;
    case 'death': d.className = 'evt death god-only'; d.textContent = e.text; return d;
    case 'end': d.className = 'evt end'; d.innerHTML = `${esc(e.text)}<div class="roles">${e.roles.map(r => `${r.seat}号 ${esc(r.name)}=${ROLES[r.role].name}`).join('　')}</div>`; return d;
    case 'error': d.className = 'evt error god-only'; d.textContent = '出错：' + e.text; return d;
    case 'pass': return null;
    default: {
      // 决定类：vote-reason / night-* / hunter
      d.className = 'evt private god-only' + (e.fallback ? ' fallback' : '');
      const icon = { 'vote-reason': '[投票]', 'night-wolf': '[狼刀]', 'night-seer': '[查验]', 'night-guard': '[守护]', 'night-witch': '[用药]', hunter: '[开枪]' }[e.type] || '·';
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
    const showRole = settings.god || p.human || (game && (game.phase === 'end' || game.phase === 'aborted')) || (!game && viewPlayers === replayPlayersView);
    el.innerHTML = `<div class="avatar${p.human ? ' me' : ''}">${p.seat}</div><div class="name">${esc(p.name)}</div><div class="model">${esc(p.modelLabel || '')}</div>${showRole && r ? `<div class="role ${r.team}">${r.name}</div>` : ''}`;
    el.title = p.persona?.bio || p.persona || '';
    el.onclick = () => { selectedSeat = p.seat; renderSeats(); showTab('mind'); renderMind(p.seat); };
    table.appendChild(el);
    seatEls.set(p.seat, el);
  });
}
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
  const parts = [`<h3>${p.seat}号 ${esc(p.name)} · ${ROLES[p.role].name} · ${esc(p.modelLabel || '')}</h3>`];
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
let replayPlayersView = null;
async function replay(data) {
  if (game && game.phase !== 'end' && game.phase !== 'aborted') { if (!confirm('当前有对局在进行，终止并回放？')) return; game.abort(); stepResolve(); }
  game = null;
  $('log').innerHTML = ''; $('mind-content').innerHTML = '';
  replayPlayers = data.players || [];
  viewPlayers = replayPlayersView = replayPlayers.map(p => ({ ...p, alive: true }));
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
renderKeys(); renderModels(); renderPersonas(); renderComposition(); renderSeatAssign();
onPhase({ phase: 'idle', day: 0 });
$('phase-text').textContent = '等待开局';
$('status').textContent = '未开始';
if (location.search.includes('demo=1')) startGame(true);
// 手机上：已经配过模型就直接看牌桌，没配过就先停在设置页
if (isPhone() && enabledModels().length && !location.search.includes('demo=1')) $('settings').classList.add('collapsed');
// 浏览器里注册 service worker（可安装、断网可打开）；安卓壳里资源本来就在本地，不需要
if ('serviceWorker' in navigator && !isNativeApp() && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
