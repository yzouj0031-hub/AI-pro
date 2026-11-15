import { Game } from './engine.js';
import { ROLES, presetFor, expandComposition, describeComposition, roleCard } from './roles.js';
import { PERSONAS, pickPersonas, cleanPersonaName, namesClash } from './personas.js';
import { AIAgent, HumanAgent } from './agent.js';
import { createProvider, PROVIDER_PRESETS, detectType, MockProvider, listModels } from './providers.js';

const $ = id => document.getElementById(id);
const LS_MODELS = 'aiwolf.models.v1';
const LS_SETTINGS = 'aiwolf.settings.v1';
const LS_KEYS = 'aiwolf.keys.v1';
const LS_PERSONAS = 'aiwolf.personas.v1';
const LS_MODELCACHE = 'aiwolf.modelcache.v1';
const MAX_SEATS = 12;

// ===== 持久化 =====
function loadJSON(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } }
function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { console.warn('保存失败', e); } }
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

let keys = loadJSON(LS_KEYS, []);               // [{ id, name, type, baseUrl, apiKey }]
let models = loadJSON(LS_MODELS, []);           // [{ id, label, model, keyId, enabled }]
let customPersonas = loadJSON(LS_PERSONAS, []); // [{ id, name, bio, enabled }]
let modelCache = loadJSON(LS_MODELCACHE, {});   // { keyId: [模型名…] }，上次拉取到的列表
let settings = Object.assign({
  playerCount: 9, composition: null, roster: null,
  witchSelfSave: false, firstNightLastWords: true, freeTalk: true, winMode: 'side', wolfChatRounds: 1,
  speed: 800, god: true, auto: true, personaMode: 'first',
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
  for (const m of models) {
    if (m.keyId || !('apiKey' in m || 'baseUrl' in m || 'type' in m)) continue;
    if (m.type === 'mock') continue; // 测试用的假模型不走 key
    const type = m.type || 'openai', baseUrl = m.baseUrl || '', apiKey = m.apiKey || '';
    let k = keys.find(x => x.type === type && x.baseUrl === baseUrl && x.apiKey === apiKey);
    if (!k) {
      const preset = PROVIDER_PRESETS.find(p => p.type === type && hostOf(p.baseUrl) === hostOf(baseUrl));
      k = { id: newId('k'), name: uniqueKeyName(preset?.label || hostOf(baseUrl) || '未命名接口'), type, baseUrl, apiKey };
      keys.push(k);
    }
    m.keyId = k.id; delete m.type; delete m.baseUrl; delete m.apiKey;
  }
})();

const keyOf = m => keys.find(k => k.id === m.keyId) || null;
const keyNo = k => `K${keys.indexOf(k) + 1}`;
const modelNo = m => `M${models.indexOf(m) + 1}`;
const usable = m => m.type === 'mock' || !!keyOf(m);
const enabledModels = () => models.filter(m => m.enabled !== false && usable(m));
const modelById = id => models.find(m => m.id === id);
// 模型 + 它用的 key = 能直接发请求的完整配置
function resolveModel(m) {
  if (m.type === 'mock') return m;
  const k = keyOf(m);
  if (!k) throw new Error(`「${m.label || m.model}」用的 key 已经不在了，先给它换一个`);
  return { label: m.label, model: m.model, type: k.type, baseUrl: k.baseUrl, apiKey: k.apiKey };
}
function maskKey(s) { s = String(s || ''); return !s ? '没填 key' : s.length > 10 ? `${s.slice(0, 3)}…${s.slice(-4)}` : '••••'; }

// ===== 名册：12 个座位各自的名讳、人设、头像、指定模型、指定身份。只用前 N 个 =====
// personaId 不为空表示这个座位坐的是人设库里的某一条，跟着人设库同步；手改过就断开。
const activePersonas = () => customPersonas.filter(p => p.enabled !== false);
function tablePersonas(n) { return pickPersonas(n, Math.random, { custom: activePersonas(), mode: settings.personaMode }); }
function seatFromPersona(p, keep = {}) {
  const lib = p.custom ? customPersonas.find(c => cleanPersonaName(c.name) === p.name) : null;
  return { modelId: '', fixedRole: '', avatar: '', ...keep, name: p.name, bio: p.bio, personaId: lib ? lib.id : '' };
}
if (!settings.composition) settings.composition = { ...presetFor(settings.playerCount) };
if (settings.speed < 0) { settings.speed = 800; settings.auto = false; } // 旧版的"逐步"档
if (!Array.isArray(settings.roster) || settings.roster.length !== MAX_SEATS) {
  settings.roster = tablePersonas(MAX_SEATS).map(p => seatFromPersona(p));
  // 旧版的"按座位指定模型"和"我也上桌"搬到座位上
  for (const [s, id] of Object.entries(settings.seatModels || {})) if (id && settings.roster[s - 1]) settings.roster[s - 1].modelId = id;
  if (settings.humanSeat) settings.roster[0].modelId = 'human';
}
delete settings.seatModels; delete settings.humanSeat; delete settings.assignMode;
const isBuiltinSeat = s => !s.personaId && PERSONAS.some(p => p.name === s.name && p.bio === s.bio);
function unusedBuiltin(taken) {
  const pool = PERSONAS.filter(p => !taken.some(n => namesClash(n, p.name)));
  return pool[Math.floor(Math.random() * pool.length)] || null;
}
// 让座位和人设库保持一致：库里改了就跟着改，删了/停用了就换回内置的，新写的自动找个位置坐下。
function syncRoster() {
  const roster = settings.roster;
  const active = activePersonas();
  for (const s of roster) {
    if (!s.personaId) continue;
    const p = active.find(x => x.id === s.personaId);
    if (p) { s.name = cleanPersonaName(p.name); s.bio = p.bio; continue; }
    const b = unusedBuiltin(roster.filter(x => x !== s).map(x => x.name));
    s.personaId = '';
    if (b) { s.name = b.name; s.bio = b.bio; }
  }
  for (const p of active) {
    if (roster.some(s => s.personaId === p.id)) continue;
    const s = roster.find(x => isBuiltinSeat(x));
    if (!s) break;
    Object.assign(s, { name: cleanPersonaName(p.name), bio: p.bio, personaId: p.id });
  }
  // 内置人设和别的座位重名或互相包含的，换一个
  roster.forEach(s => {
    if (!isBuiltinSeat(s)) return;
    const others = roster.filter(x => x !== s).map(x => x.name);
    if (!others.some(n => namesClash(n, s.name))) return;
    const b = unusedBuiltin(others);
    if (b) { s.name = b.name; s.bio = b.bio; }
  });
}
syncRoster();
persist();

const isPhone = () => window.matchMedia('(max-width: 720px)').matches;
const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

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
  $('settings-summary-text').textContent = `${settings.playerCount} 人 · ${describeComposition(settings.composition)} · 可用模型 ${enabledModels().length} 个`;
}
function setSettingsOpen(open) {
  $('settings-body').hidden = !open;
  $('settings-summary-toggle').textContent = open ? '收起' : '展开';
}
$('settings-summary').onclick = () => setSettingsOpen($('settings-body').hidden);
$('btn-toggle-settings').onclick = () => {
  const collapsed = $('settings-panel').classList.toggle('collapsed');
  $('btn-toggle-settings').textContent = collapsed ? '▼ 展开设置' : '▲ 收起设置';
  if (!collapsed) setSettingsOpen(true);
};
function collapseSettings() { $('settings-panel').classList.add('collapsed'); $('btn-toggle-settings').textContent = '▼ 展开设置'; }
function refreshAll() { syncRoster(); persist(); renderKeys(); renderModels(); renderPersonas(); renderComposition(); settingsSummary(); renderSeats(); }

// ===== Key 库 =====
function renderKeys() {
  const ul = $('key-list');
  ul.innerHTML = '';
  if (!keys.length) ul.innerHTML = '<li class="empty">还没有 key。点「添加」存一个。</li>';
  keys.forEach((k, i) => {
    const used = models.filter(m => m.keyId === k.id).length;
    const li = document.createElement('li');
    li.innerHTML = `<span class="no">K${i + 1}</span>
      <span class="mname">${esc(k.name)}<span class="meta">${esc(hostOf(k.baseUrl) || k.type)} · ${esc(maskKey(k.apiKey))} · ${used} 个模型在用</span></span>
      <button class="btn small" data-act="edit">编辑</button><button class="btn small" data-act="del">删</button>`;
    li.querySelector('[data-act=edit]').onclick = () => openKeyDialog(k);
    li.querySelector('[data-act=del]').onclick = () => {
      if (!confirm(used ? `删除「${k.name}」？有 ${used} 个模型在用它，删掉后这些模型会停用，直到给它们换一个 key。` : `删除「${k.name}」？`)) return;
      keys = keys.filter(x => x !== k); delete modelCache[k.id];
      refreshAll();
    };
    ul.appendChild(li);
  });
}
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
function readKeyForm() { return { name: $('kf-name').value.trim(), type: $('kf-type').value, baseUrl: $('kf-url').value.trim(), apiKey: $('kf-key').value.trim() }; }
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
  refreshAll(); keyDlg.close();
  if (keySaved) keySaved(k);
};

// ===== 模型库 =====
function renderModels() {
  const ul = $('model-list');
  ul.innerHTML = '';
  if (!models.length) ul.innerHTML = '<li class="empty">还没有模型。点「添加」选一个，或者在「更多功能」里先用假模型试跑。</li>';
  models.forEach((m, i) => {
    const k = keyOf(m);
    const ok = usable(m);
    const li = document.createElement('li');
    li.className = (m.enabled === false ? 'disabled' : '') + (ok ? '' : ' broken');
    li.innerHTML = `<input type="checkbox" ${m.enabled !== false ? 'checked' : ''} title="参与随机分配">
      <span class="no">M${i + 1}</span>
      <span class="mname">${esc(m.label)}<span class="meta">${ok ? esc(m.model) : 'key 已删除，换一个才能用'}</span></span>
      <button class="btn small" data-act="edit">编辑</button><button class="btn small" data-act="del">删</button>
      ${m.type === 'mock' ? '' : `<label class="keysel">用的 key <select>${k ? '' : '<option value="">选一个</option>'}${keys.map(x => `<option value="${x.id}" ${x.id === m.keyId ? 'selected' : ''}>${keyNo(x)} ${esc(x.name)}</option>`).join('')}</select></label>`}`;
    li.querySelector('input').onchange = e => { m.enabled = e.target.checked; refreshAll(); };
    const sel = li.querySelector('select');
    if (sel) sel.onchange = e => { if (e.target.value) { m.keyId = e.target.value; refreshAll(); } };
    li.querySelector('[data-act=edit]').onclick = () => openModelDialog(m);
    li.querySelector('[data-act=del]').onclick = () => {
      if (!confirm(`删除「${m.label}」？`)) return;
      models = models.filter(x => x !== m);
      for (const s of settings.roster) if (s.modelId === m.id) s.modelId = '';
      refreshAll();
    };
    ul.appendChild(li);
  });
}
const modelDlg = $('model-dialog');
let editingModel = null, modelSaved = null;
function fillKeySelect(selected) {
  const sel = $('mf-key');
  sel.innerHTML = keys.length ? keys.map(k => `<option value="${k.id}">${keyNo(k)} ${esc(k.name)}</option>`).join('') : '<option value="">还没有 key，点右边新建</option>';
  if (selected && keys.some(k => k.id === selected)) sel.value = selected;
}
function openModelDialog(m, onSaved) {
  editingModel = m || null; modelSaved = onSaved || null;
  $('model-dialog-title').textContent = m ? '编辑模型' : '添加模型';
  fillKeySelect(m?.keyId || settings.lastKeyId);
  $('mf-label').value = m && m.label !== m.model ? m.label : '';
  $('mf-model').value = m?.model || '';
  $('mf-test-result').textContent = '';
  $('mf-fetch-result').textContent = '';
  renderModelOptions();
  modelDlg.showModal();
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
  try { modelCache[k.id] = await listModels(k); persist(); renderModelOptions(); }
  catch (err) { out.textContent = `拉取失败：${err.message}（可以直接手填模型名）`; }
};
$('mf-cancel').onclick = () => modelDlg.close();
$('btn-add-model').onclick = () => openModelDialog(null);
function readModelForm() {
  const model = $('mf-model').value.trim();
  return { label: $('mf-label').value.trim() || model, model, keyId: $('mf-key').value };
}
$('model-form').onsubmit = e => {
  e.preventDefault();
  const v = readModelForm();
  if (!v.keyId) { $('mf-test-result').textContent = '先选一个 key。'; return; }
  let m = editingModel;
  if (m) Object.assign(m, v); else { m = { id: newId('m'), enabled: true, ...v }; models.push(m); }
  settings.lastKeyId = v.keyId;
  refreshAll(); modelDlg.close();
  if (modelSaved) modelSaved(m);
};
async function testModel(m, out) {
  out.textContent = '测试中…';
  try {
    const r = await createProvider(resolveModel(m)).chat({ system: '你是一个测试助手。', messages: [{ role: 'user', content: '只回复两个字：收到' }], temperature: 0, maxTokens: 20 });
    out.textContent = `能用，返回：${String(r).slice(0, 40)}`;
  } catch (err) { out.textContent = `失败：${err.message}`; }
}
$('mf-test').onclick = () => testModel(readModelForm(), $('mf-test-result'));

// ===== 人设库 =====
function renderPersonas() {
  const ul = $('persona-list');
  ul.innerHTML = '';
  if (!customPersonas.length) ul.innerHTML = '<li class="empty">还没有自己写的人设，现在座位上坐的是内置的。</li>';
  customPersonas.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = p.enabled === false ? 'disabled' : '';
    li.innerHTML = `<input type="checkbox" ${p.enabled !== false ? 'checked' : ''} title="上桌">
      <span class="no">P${i + 1}</span>
      <span class="mname" title="${esc(p.bio)}">${esc(p.name)}<span class="meta">${esc(p.bio)}</span></span>
      <button class="btn small" data-act="edit">编辑</button><button class="btn small" data-act="del">删</button>`;
    li.querySelector('input').onchange = e => { p.enabled = e.target.checked; refreshAll(); };
    li.querySelector('[data-act=edit]').onclick = () => openPersonaDialog(p);
    li.querySelector('[data-act=del]').onclick = () => { if (confirm(`删除人设「${p.name}」？`)) { customPersonas = customPersonas.filter(x => x !== p); refreshAll(); } };
    ul.appendChild(li);
  });
}
$('builtin-personas').innerHTML = PERSONAS.map(p => `<li><b>${esc(p.name)}</b>：${esc(p.bio)}</li>`).join('');
$('persona-mode').value = settings.personaMode;
$('persona-mode').onchange = e => { settings.personaMode = e.target.value; persist(); };
$('btn-reroll').onclick = () => {
  if (!confirm('给所有座位重新发一批人设？头像、指定的模型和身份会保留，手改过的名讳和人设会被换掉。')) return;
  const ps = tablePersonas(MAX_SEATS);
  settings.roster = settings.roster.map((s, i) => seatFromPersona(ps[i], { modelId: s.modelId, fixedRole: s.fixedRole, avatar: s.avatar }));
  refreshAll();
};
// 名字的通用校验：不能是座位号，不能和别的名字互相包含
function nameProblem(name, others) {
  if (!name) return '名字不能为空（标点会被去掉）。';
  if (/^\d+号?$/.test(name)) return '名字不能是纯数字或座位号，会和「3号」这类说法混在一起。';
  const clash = others.find(n => namesClash(n, name));
  return clash ? `和「${clash}」太像了（名字不能相同或互相包含），换一个。` : '';
}
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
  if (!bio) { $('pf-error').textContent = '描述也要填。'; return; }
  const err = nameProblem(name, customPersonas.filter(x => x !== editingPersona).map(x => cleanPersonaName(x.name)));
  if (err) { $('pf-error').textContent = err; return; }
  if (editingPersona) Object.assign(editingPersona, { name, bio }); else customPersonas.push({ id: newId('p'), name, bio, enabled: true });
  refreshAll(); personaDlg.close();
};

// ===== 这一局 =====
const pc = $('player-count');
for (let n = 6; n <= MAX_SEATS; n++) { const o = document.createElement('option'); o.value = n; o.textContent = `${n} 人`; pc.appendChild(o); }
pc.value = settings.playerCount;
pc.onchange = () => { settings.playerCount = +pc.value; settings.composition = { ...presetFor(settings.playerCount) }; refreshAll(); };
function renderComposition() {
  const box = $('composition');
  box.innerHTML = '';
  for (const id of ['wolf', 'seer', 'witch', 'hunter', 'guard', 'villager']) {
    const l = document.createElement('label');
    l.innerHTML = `${ROLES[id].name}<input type="number" inputmode="numeric" min="0" max="${id === 'wolf' || id === 'villager' ? 6 : 1}" value="${settings.composition[id] || 0}">`;
    l.querySelector('input').onchange = e => { settings.composition[id] = Math.max(0, +e.target.value | 0); refreshAll(); };
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

// ===== 座位弹窗 =====
const seatDlg = $('seat-dialog');
let editingSeat = -1;
let draftAvatar = '';
function fillSeatModelSelect(selected) {
  const sel = $('sf-model');
  sel.innerHTML = `<option value="">随机（从模型库里勾选的模型中抽）</option>` +
    models.map(m => `<option value="${m.id}">${modelNo(m)} ${esc(m.label)}${usable(m) ? '' : '（key 已删除）'}</option>`).join('') +
    `<option value="human">真人（我自己坐这个位置）</option>`;
  sel.value = selected && (selected === 'human' || modelById(selected)) ? selected : '';
}
function openSeatDialog(i) {
  editingSeat = i;
  const s = settings.roster[i];
  $('sf-title').textContent = `P${i + 1} ${s.name}`;
  $('sf-role').innerHTML = `<option value="">身份(随机)</option>` + Object.values(ROLES).map(r => `<option value="${r.id}">${r.name}</option>`).join('');
  $('sf-role').value = s.fixedRole || '';
  $('sf-name').value = s.name;
  $('sf-bio').value = s.bio;
  fillSeatModelSelect(s.modelId);
  const act = activePersonas();
  $('sf-persona-pick').innerHTML = `<option value="">从人设库里选一个填进来…</option>` +
    act.map(p => `<option value="c:${p.id}">P${customPersonas.indexOf(p) + 1} ${esc(p.name)}</option>`).join('') +
    PERSONAS.map((p, k) => `<option value="b:${k}">内置 · ${esc(p.name)}</option>`).join('');
  draftAvatar = s.avatar || '';
  paintAvatar($('sf-avatar'), draftAvatar, String(i + 1));
  $('sf-test-result').textContent = ''; $('sf-error').textContent = '';
  seatDlg.showModal();
}
$('sf-cancel').onclick = () => seatDlg.close();
$('sf-persona-pick').onchange = e => {
  const v = e.target.value;
  const p = v.startsWith('c:') ? customPersonas.find(x => x.id === v.slice(2)) : v.startsWith('b:') ? PERSONAS[+v.slice(2)] : null;
  if (p) { $('sf-name').value = cleanPersonaName(p.name); $('sf-bio').value = p.bio; }
  e.target.value = '';
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
$('sf-clear-avatar').onclick = () => { draftAvatar = ''; paintAvatar($('sf-avatar'), '', String(editingSeat + 1)); };
$('sf-file').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { draftAvatar = await shrinkImage(f, 128); paintAvatar($('sf-avatar'), draftAvatar, ''); }
  catch (err) { $('sf-error').textContent = '这张图读不了：' + err.message; }
};
$('seat-form').onsubmit = e => {
  e.preventDefault();
  const s = settings.roster[editingSeat];
  const name = cleanPersonaName($('sf-name').value), bio = $('sf-bio').value.trim();
  const err = nameProblem(name, settings.roster.filter(o => o !== s).map(o => o.name));
  if (err) { $('sf-error').textContent = err; return; }
  const modelId = $('sf-model').value;
  if (modelId === 'human') for (const o of settings.roster) if (o !== s && o.modelId === 'human') o.modelId = ''; // 只有一个真人位
  // 名讳和人设跟人设库里某一条完全一致就挂上钩（以后跟着库同步），否则算这个座位自己的
  const lib = activePersonas().find(p => cleanPersonaName(p.name) === name && p.bio === bio);
  Object.assign(s, { name, bio, modelId, fixedRole: $('sf-role').value, avatar: draftAvatar, personaId: lib ? lib.id : '' });
  // 同一条人设不要同时坐两个位置
  if (lib) for (const o of settings.roster) if (o !== s && o.personaId === lib.id) { const b = unusedBuiltin(settings.roster.filter(x => x !== o).map(x => x.name)); o.personaId = ''; if (b) { o.name = b.name; o.bio = b.bio; } }
  refreshAll(); seatDlg.close();
};
// 头像缩到 128px 再存，避免把本地存储撑爆
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
    if (reveal) { tag = r.name; tagCls = r.team; }
    else if (!inGame && p.fixedRole) tag = `指定：${ROLES[p.fixedRole].name}`;
    if (inGame && !p.alive) tag = reveal ? `${r.name} · 出局` : '出局';
    el.innerHTML = `<span class="avatar"></span><span class="info"><span class="name">${esc(p.name)}</span><span class="pid">P${p.seat} · ${esc(p.modelLabel || '')}</span></span><span class="tag ${tagCls}">${esc(tag)}</span>`;
    paintAvatar(el.querySelector('.avatar'), p.avatar, String(p.seat));
    el.onclick = () => (inGame ? openMind(p.seat) : openSeatDialog(i));
    (i < half ? left : right).appendChild(el);
    seatEls.set(p.seat, el);
  });
  for (const s of busySeats) seatEls.get(s)?.classList.add('thinking');
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
  $('btn-auto').textContent = settings.auto ? '自动' : '手动';
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
  busySeats.clear();
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
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (namesClash(seats[i].name, seats[j].name)) throw new Error(`P${i + 1}「${seats[i].name}」和 P${j + 1}「${seats[j].name}」的名字相同或互相包含，AI 会分不清，请改一个。`);
  }
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
    const picked = s.modelId && modelById(s.modelId);
    if (picked && !usable(picked)) throw new Error(`P${seat} ${s.name} 指定的模型「${picked.label}」用的 key 已经删了，先在模型库里给它换一个 key。`);
    const m = picked || ms[Math.floor(Math.random() * ms.length)];
    if (!m) throw new Error(`P${seat} ${s.name} 没有可用的模型。请先在「设置面板」里加 key 和模型，或者在「更多功能」里用假模型试跑。`);
    return { ...base, modelLabel: m.label, agent: new AIAgent({ provider: createProvider(resolveModel(m)), label: m.label }) };
  });
}

async function startGame(mock = false) {
  let players;
  try { players = buildPlayers(mock); }
  catch (e) {
    alert(e.message);
    $('settings-panel').classList.remove('collapsed'); $('btn-toggle-settings').textContent = '▲ 收起设置'; setSettingsOpen(true);
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
  setStatus(day ? `第${day}${phase === 'night' ? '夜' : '天'}` : '第0回', PHASE_NAMES[phase] || phase, null);
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
  if (e.type === 'death') { const p = viewPlayers.find(x => x.seat === e.seat); if (p) p.alive = false; renderSeats(); setStatus(null, null, aliveText()); }
  if (e.type === 'speech' || e.type === 'wolf-chat') setActive(e.seat);
  if (e.type === 'end') setStatus(null, e.winner === 'wolf' ? '狼人胜' : e.winner === 'village' ? '好人胜' : '平局', null);
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
    case 'wolf-chat': d.className = 'evt wolf god-only'; d.innerHTML = `<div class="who">狼人频道 · ${esc(who)}</div><div class="text">${esc(e.text)}</div>`; return d;
    case 'vote': d.className = 'evt vote'; d.innerHTML = `<div>${esc(e.text)}</div><div class="detail">${esc(e.detail)}</div>`; return d;
    case 'death': d.className = 'evt death god-only'; d.textContent = e.text; return d;
    case 'end': d.className = 'evt end'; d.innerHTML = `${esc(e.text.replace(/^[^一-龥A-Za-z]+/, ''))}<div class="roles">${e.roles.map(r => `${r.seat}号 ${esc(r.name)}=${ROLES[r.role].name}`).join('　')}</div>`; return d;
    case 'error': d.className = 'evt error god-only'; d.textContent = '出错：' + e.text; return d;
    case 'pass': return null;
    default: {
      d.className = 'evt private god-only' + (e.fallback ? ' fallback' : '');
      const icon = { 'vote-reason': '[投票]', 'night-wolf': '[狼刀]', 'night-seer': '[查验]', 'night-guard': '[守护]', 'night-witch': '[用药]', hunter: '[开枪]' }[e.type] || '·';
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
  $('mind-title').textContent = `P${p.seat} ${p.name}${revealed ? ` · ${ROLES[p.role].name}` : ''} · ${p.modelLabel || ''}`;
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
    // 任务里"可选：…"之后提到的座位号就是能选的人；名字从当前对局里查，不靠正则猜
    const optPart = task.slice(Math.max(0, task.indexOf('可选')));
    const seatNos = [...new Set([...optPart.matchAll(/(\d{1,2})号/g)].map(m => +m[1]))];
    const seats = seatNos.map(n => game?.players.find(q => q.seat === n)).filter(Boolean).map(q => `${q.seat}号 ${q.name}`);
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
  seatMeta = new Map(); busySeats.clear();
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
