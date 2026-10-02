import { writeProjectToDirectory } from './local-save.js';
import { createCodeEditor } from './editor-bundle.js';
import { VoiceSegmenter, wavBlob } from './voice-activity.js';

const $ = selector => document.querySelector(selector);
const state = { files: [], tree: [], trash: [], open: new Map(), saving: new Map(), saveTimers: new Map(), active: '', selected: '', expanded: new Set(), projectName: 'workspace', projectPath: '', openRequest: 0, preview: false, busy: false, speaking: true, messages: [] };
const voice = { enabled: false, starting: false, generation: 0, stream: null, context: null, node: null, segmenter: null, queue: [], processing: false, abort: null, suppressed: false, mutedUntil: 0, playbackId: 0 };
const editor = createCodeEditor($('#codeEditor'), content => {
  if (!state.active) return;
  state.open.get(state.active).content = content;
  scheduleSave(state.active);
  updateEditorChrome();
  renderTabs();
}, () => updateEditorChrome());
const messageInput = $('#messageInput');
const welcomeTemplate = $('.welcome').cloneNode(true);
let settingsStatus = { configured: false, model: '', keySource: 'none' };

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function jsonOptions(method, body) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function language(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ({ html: 'HTML', css: 'CSS', js: 'JavaScript', json: 'JSON', md: 'Markdown', py: 'Python', ts: 'TypeScript' })[ext] || ext.toUpperCase();
}

function allFolders(nodes = state.tree) { return nodes.flatMap(node => node.type === 'folder' ? [node.path, ...allFolders(node.children)] : []); }
function allFiles(nodes = state.tree) { return nodes.flatMap(node => node.type === 'file' ? [node.path] : allFiles(node.children)); }
function parentOf(name) { return name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''; }
function baseName(name) { return name.split('/').pop(); }
function joinPath(parent, name) { return parent ? `${parent}/${name}` : name; }
function saveExpanded() { localStorage.setItem(`vocode-expanded:${state.projectPath}`, JSON.stringify([...state.expanded])); }

async function refreshTree() {
  const data = await api('/api/tree');
  state.tree = data.tree;
  state.trash = data.trash;
  state.files = allFiles();
  renderFiles();
  renderTrash();
  if (state.preview) refreshPreview();
}

function renderFiles() {
  const list = $('#fileList');
  list.replaceChildren();
  const query = $('#fileSearch').value.trim().toLocaleLowerCase();
  const matches = node => !query || node.name.toLocaleLowerCase().includes(query) || (node.type === 'folder' && node.children.some(matches));
  const renderNodes = (nodes, depth) => {
    for (const node of nodes) {
      if (!matches(node)) continue;
      const row = document.createElement('div');
      row.className = `tree-row${node.path === state.active ? ' active' : ''}${node.path === state.selected ? ' selected' : ''}`;
      row.style.paddingLeft = `${5 + depth * 14}px`;
      row.title = node.path;
      row.draggable = true;
      row.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', node.path); event.dataTransfer.effectAllowed = 'move'; });
      const main = document.createElement('button');
      main.className = 'tree-main';
      const caret = document.createElement('span');
      caret.className = 'tree-caret';
      caret.textContent = node.type === 'folder' ? (state.expanded.has(node.path) || query ? '⌄' : '›') : '';
      const glyph = icon(node.type === 'folder' ? 'i-folder' : 'i-file');
      glyph.classList.add('tree-icon', node.type === 'file' ? 'file' : 'folder');
      if (node.type === 'file') glyph.classList.add(node.name.split('.').pop());
      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = node.name;
      main.append(caret, glyph, label);
      main.addEventListener('click', () => {
        state.selected = node.path;
        if (node.type === 'folder') {
          state.expanded.has(node.path) ? state.expanded.delete(node.path) : state.expanded.add(node.path);
          saveExpanded(); renderFiles();
        } else openFile(node.path).catch(error => showError(error.message));
      });
      const more = document.createElement('button');
      more.className = 'tree-menu-button';
      more.title = `${node.name} の操作`;
      more.setAttribute('aria-label', `${node.name} の操作`);
      more.append(icon('i-more'));
      more.addEventListener('click', event => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); state.selected = node.path; renderFiles(); showEntryMenu(node, rect); });
      row.addEventListener('contextmenu', event => { event.preventDefault(); state.selected = node.path; renderFiles(); showEntryMenu(node, { left: event.clientX, bottom: event.clientY }); });
      if (node.type === 'folder') {
        row.addEventListener('dragover', event => { event.preventDefault(); row.classList.add('drop-target'); });
        row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
        row.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); row.classList.remove('drop-target'); moveDropped(event.dataTransfer.getData('text/plain'), node.path); });
      }
      row.append(main, more);
      list.append(row);
      if (node.type === 'folder' && (state.expanded.has(node.path) || query)) {
        if (node.children.length) renderNodes(node.children, depth + 1);
        else if (!query) {
          const empty = document.createElement('div');
          empty.className = 'tree-empty small';
          empty.style.paddingLeft = `${29 + depth * 14}px`;
          empty.textContent = '空のフォルダ';
          list.append(empty);
        }
      }
    }
  };
  renderNodes(state.tree, 0);
  if (!list.children.length) {
    const empty = document.createElement('div'); empty.className = 'tree-empty';
    empty.textContent = query ? '一致するファイルがありません。' : 'ファイルがありません。上のボタンから作成できます。';
    list.append(empty);
  }
}

function renderTrash() {
  $('#trashCount').textContent = state.trash.length;
  const list = $('#trashList');
  list.replaceChildren();
  for (const item of state.trash) {
    const row = document.createElement('div'); row.className = 'trash-item';
    const label = document.createElement('span'); label.className = 'trash-path'; label.textContent = item.path; label.title = item.path;
    const restore = document.createElement('button'); restore.className = 'trash-restore'; restore.textContent = '復元';
    restore.addEventListener('click', async () => {
      try { const result = await api('/api/entries/restore', jsonOptions('POST', { id: item.id })); expandParents(result.path); await refreshTree(); }
      catch (error) { showError(error.message); }
    });
    row.append(label, restore); list.append(row);
  }
  if (!state.trash.length) { const empty = document.createElement('div'); empty.className = 'tree-empty small'; empty.textContent = 'ゴミ箱は空です。'; list.append(empty); }
}

function expandParents(name) {
  let parent = parentOf(name);
  while (parent) { state.expanded.add(parent); parent = parentOf(parent); }
  saveExpanded();
}

function hideEntryMenu() { $('#entryMenu').hidden = true; }

function showEntryMenu(node, rect) {
  const menu = $('#entryMenu');
  menu.replaceChildren();
  const action = (label, handler, danger = false) => {
    const button = document.createElement('button');
    button.textContent = label;
    if (danger) button.className = 'danger';
    button.addEventListener('click', () => { hideEntryMenu(); handler(); });
    menu.append(button);
  };
  if (node.type === 'folder') {
    action('新しいファイル', () => openEntryDialog('file', node.path));
    action('新しいフォルダ', () => openEntryDialog('folder', node.path));
  }
  action('名前を変更', () => openEntryDialog('rename', node.path));
  action('別のフォルダへ移動', () => openMoveDialog(node.path));
  action('ゴミ箱に移動', () => trashEntry(node.path, node.type), true);
  menu.hidden = false;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 175)}px`;
  menu.style.top = `${Math.min(rect.bottom + 3, window.innerHeight - menu.offsetHeight - 8)}px`;
}

let entryDialogAction = null;
function openEntryDialog(type, source = '') {
  entryDialogAction = { type, source };
  const isRename = type === 'rename';
  const parent = isRename ? parentOf(source) : source || (state.selected && state.tree ? (findNode(state.tree, state.selected)?.type === 'folder' ? state.selected : parentOf(state.selected)) : '');
  entryDialogAction.parent = parent;
  $('#entryDialogTitle').textContent = isRename ? '名前を変更' : type === 'folder' ? '新しいフォルダ' : '新しいファイル';
  $('#entryDialogHint').textContent = isRename ? `${source} の新しい名前を入力してください。` : `作成先: ${parent || state.projectPath || state.projectName}`;
  $('#chooseEntryLocationButton').hidden = isRename;
  $('#entryName').value = isRename ? baseName(source) : '';
  $('#entryError').hidden = true;
  $('#entryName').removeAttribute('aria-invalid');
  $('#entryName').placeholder = type === 'folder' ? '例: components' : '例: button.js';
  $('#entryDialog').showModal();
  $('#entryName').focus();
  if (isRename) $('#entryName').select();
}

function findNode(nodes, name) {
  for (const node of nodes) {
    if (node.path === name) return node;
    if (node.type === 'folder') { const child = findNode(node.children, name); if (child) return child; }
  }
  return null;
}

function openMoveDialog(source) {
  const select = $('#moveDestination');
  select.replaceChildren();
  const add = (value, label, depth = 0) => {
    const option = document.createElement('option'); option.value = value; option.textContent = `${'　'.repeat(depth)}${label}`; select.append(option);
  };
  add('', state.projectName);
  const folders = (nodes, depth) => {
    for (const node of nodes) if (node.type === 'folder' && node.path !== source && !node.path.startsWith(source + '/')) {
      add(node.path, node.name, depth); folders(node.children, depth + 1);
    }
  };
  folders(state.tree, 1);
  select.value = parentOf(source);
  if (!select.value && parentOf(source)) select.value = '';
  $('#moveHint').textContent = `${source} の移動先を選んでください。`;
  $('#moveDialog').dataset.source = source;
  $('#moveDialog').showModal();
}

async function moveEntry(source, destination) {
  if (source === destination) return;
  try {
    await flushFiles([...state.open.keys()].filter(name => name === source || name.startsWith(source + '/')));
    const result = await api('/api/entries/move', jsonOptions('POST', { source, destination }));
    const remap = name => name === source || (result.type === 'folder' && name.startsWith(source + '/')) ? destination + name.slice(source.length) : name;
    state.open = new Map([...state.open].map(([name, data]) => [remap(name), data]));
    state.active = remap(state.active);
    state.selected = destination;
    state.expanded = new Set([...state.expanded].map(remap));
    expandParents(destination);
    await refreshTree();
    if (state.active) await openFile(state.active);
    else renderTabs();
  } catch (error) { showError(error.message); }
}

function moveDropped(source, folder) {
  if (!source) return;
  const destination = joinPath(folder, baseName(source));
  moveEntry(source, destination);
}

async function trashEntry(name, type) {
  const affected = [...state.open.keys()].filter(file => file === name || (type === 'folder' && file.startsWith(name + '/')));
  if (!confirm(`${name} をゴミ箱に移動しますか？ 後で復元できます。`)) return;
  try {
    await flushFiles(affected);
    await api('/api/entries/trash', jsonOptions('POST', { path: name }));
    for (const file of affected) state.open.delete(file);
    if (name === state.active || (type === 'folder' && state.active.startsWith(name + '/'))) state.active = '';
    state.selected = '';
    await refreshTree();
    const next = state.active || state.open.keys().next().value || state.files[0];
    if (next) await openFile(next);
    else clearEditor();
    renderTabs();
  } catch (error) { showError(error.message); }
}

function clearEditor() {
  state.openRequest++;
  state.active = '';
  editor.setValue('');
  editor.setEnabled(false);
  editor.setLanguage('');
  $('#breadcrumbFile').textContent = 'ファイルを選択';
  $('#languageLabel').textContent = 'TEXT';
  $('#saveStatus').textContent = 'ファイルを選択してください';
  $('#dirtyLabel').hidden = true;
  renderFiles();
  renderTabs();
}

async function closeFile(name) {
  const data = state.open.get(name);
  if (data && data.content !== data.saved) {
    try { await saveFile(name); }
    catch (error) { showError(error.message); return; }
  }
  clearTimeout(state.saveTimers.get(name));
  state.saveTimers.delete(name);
  state.open.delete(name);
  if (state.active === name) {
    const next = state.open.keys().next().value;
    if (next) openFile(next).catch(error => showError(error.message));
    else clearEditor();
  } else renderTabs();
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.replaceChildren();
  for (const [name, data] of state.open) {
    const tab = document.createElement('div');
    tab.className = `tab${name === state.active ? ' active' : ''}`;
    tab.title = name;
    tab.tabIndex = 0;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(name === state.active));
    const label = document.createElement('span');
    label.className = 'tab-name';
    label.textContent = name.split('/').pop();
    tab.append(icon('i-file'), label);
    if (data.content !== data.saved) {
      const dot = document.createElement('span'); dot.className = 'dot'; tab.append(dot);
    }
    const close = document.createElement('button');
    close.className = 'tab-close'; close.title = `${name} を閉じる`; close.setAttribute('aria-label', `${name} を閉じる`);
    close.append(icon('i-close'));
    close.addEventListener('click', event => { event.stopPropagation(); closeFile(name).catch(error => showError(error.message)); });
    tab.append(close);
    tab.addEventListener('click', () => openFile(name).catch(error => showError(error.message)));
    tab.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFile(name).catch(error => showError(error.message)); } });
    tabs.append(tab);
  }
}

async function openFile(name) {
  const request = ++state.openRequest;
  if (!state.open.has(name)) {
    const data = await api(`/api/file?path=${encodeURIComponent(name)}`);
    if (request !== state.openRequest) return;
    state.open.set(name, { content: data.content, saved: data.content, version: data.version });
  }
  if (request !== state.openRequest) return;
  state.active = name;
  state.selected = name;
  editor.setEnabled(true);
  editor.setValue(state.open.get(name).content);
  editor.setLanguage(name).catch(error => showToast(`色分けを読み込めませんでした: ${error.message}`, true));
  $('#breadcrumbFile').textContent = name;
  $('#languageLabel').textContent = language(name);
  updateEditorChrome();
  renderFiles();
  renderTabs();
}

function updateEditorChrome() {
  const { row, column } = editor.position;
  $('#cursorPosition').textContent = `行 ${row}, 列 ${column}`;
  const dirty = state.active && state.open.get(state.active)?.content !== state.open.get(state.active)?.saved;
  $('#dirtyLabel').hidden = !dirty;
  $('#saveStatus').textContent = dirty ? (state.saving.has(state.active) ? 'ローカルへ保存中…' : '自動保存待ち…') : 'ローカルに保存済み';
}

function scheduleSave(name) {
  clearTimeout(state.saveTimers.get(name));
  state.saveTimers.set(name, setTimeout(() => {
    state.saveTimers.delete(name);
    saveFile(name).catch(error => showError(error.message));
  }, 800));
}

async function saveFile(name) {
  clearTimeout(state.saveTimers.get(name));
  state.saveTimers.delete(name);
  if (state.saving.has(name)) await state.saving.get(name);
  const data = state.open.get(name);
  if (!data || data.content === data.saved) return;
  const content = data.content;
  const request = api('/api/file', jsonOptions('PUT', { path: name, content, expectedVersion: data.version }));
  state.saving.set(name, request);
  if (state.active === name) updateEditorChrome();
  try {
    const result = await request;
    data.saved = content;
    data.version = result.version;
  } finally {
    state.saving.delete(name);
    if (state.active === name) updateEditorChrome();
    renderTabs();
  }
  if (data.content !== data.saved) scheduleSave(name);
  if (state.preview) refreshPreview();
}

async function flushFiles(names = [...state.open.keys()]) {
  for (const name of names) await saveFile(name);
}

async function saveActive() {
  if (!state.active) return;
  try { await saveFile(state.active); }
  catch (error) { showError(error.message); }
}

let toastTimer;
function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

async function downloadZip() {
  $('#saveLocalDialog').close();
  $('#saveLocalButton').disabled = true;
  try {
    await flushFiles();
    const response = await fetch('/api/export');
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || '書き出しに失敗しました。');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.projectName}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    showToast('プロジェクトの ZIP をローカルに保存しました。');
  } catch (error) { showToast(error.message, true); }
  finally { $('#saveLocalButton').disabled = false; }
}

async function saveToFolder() {
  if (!window.showDirectoryPicker) return showToast('このブラウザではフォルダ保存が使えません。ZIP をダウンロードしてください。', true);
  $('#saveLocalDialog').close();
  let destination;
  try { destination = await window.showDirectoryPicker({ mode: 'readwrite' }); }
  catch (error) { if (error.name !== 'AbortError') showToast('保存先フォルダを開けませんでした。', true); return; }
  if (!confirm(`${destination.name} にプロジェクトのファイルを書き込みます。同じ名前のファイルは上書きします。続けますか？`)) return;
  $('#saveLocalButton').disabled = true;
  try {
    await flushFiles();
    await refreshTree();
    await writeProjectToDirectory(state.tree, destination, async name => {
      const response = await fetch(`/api/raw?path=${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error(`${name} を読み取れませんでした。`);
      return response.blob();
    });
    showToast(`${destination.name} にプロジェクトを保存しました。`);
  } catch (error) { showToast(error.message || 'フォルダへの保存に失敗しました。', true); }
  finally { $('#saveLocalButton').disabled = false; }
}

function setWorkspaceInfo(name, location) {
  state.projectName = name;
  state.projectPath = location;
  $('#projectName').textContent = name;
  $('#projectFolderName').textContent = name;
  $('#projectPath').textContent = location;
  $('#projectPath').title = location;
  $('#chooseWorkspaceButton').title = `作業フォルダを選ぶ（現在: ${location}）`;
  $('.crumb-folder').textContent = name;
}

function openWorkspaceDialog() {
  $('#workspacePathInput').value = state.projectPath;
  $('#workspacePathError').hidden = true;
  $('#workspaceDialog').showModal();
}

async function switchWorkspace(options) {
  const controls = [$('#chooseWorkspaceButton'), $('#chooseEntryLocationButton'), $('#browseWorkspaceButton'), $('#openWorkspaceButton'), $('#cancelWorkspaceButton')];
  if (controls[0].disabled) return;
  controls.forEach(control => { control.disabled = true; });
  $('#workspacePathError').hidden = true;
  try {
    await flushFiles();
    const result = await api(options.url, options.request);
    if (result.cancelled) return;
    for (const timer of state.saveTimers.values()) clearTimeout(timer);
    state.saveTimers.clear();
    state.open.clear();
    state.saving.clear();
    state.selected = '';
    state.messages = [];
    $('#conversation').replaceChildren(welcomeTemplate.cloneNode(true));
    setWorkspaceInfo(result.projectName, result.projectPath);
    const data = await api('/api/tree');
    state.tree = data.tree;
    state.trash = data.trash;
    state.files = allFiles();
    const savedExpanded = localStorage.getItem(`vocode-expanded:${state.projectPath}`);
    state.expanded = savedExpanded ? new Set(JSON.parse(savedExpanded)) : new Set(allFolders());
    renderFiles();
    renderTrash();
    if (state.files.length) await openFile(state.files.includes('index.html') ? 'index.html' : state.files[0]);
    else clearEditor();
    if (state.preview) refreshPreview();
    if ($('#entryDialog').open && entryDialogAction) {
      entryDialogAction.parent = '';
      $('#entryDialogHint').textContent = `作成先: ${state.projectPath}`;
    }
    $('#workspaceDialog').close();
    showToast(`作業フォルダを ${state.projectPath} に切り替えました。`);
  } catch (error) {
    $('#workspacePathError').textContent = error.message;
    $('#workspacePathError').hidden = false;
  } finally { controls.forEach(control => { control.disabled = false; }); }
}

function addMessage(role, content, isError = false) {
  const welcome = $('.welcome');
  if (welcome) welcome.remove();
  const message = document.createElement('div');
  message.className = `message ${role}${isError ? ' error' : ''}`;
  const label = document.createElement('span');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'あなた' : 'Vocode';
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = content;
  message.append(label, body);
  $('#conversation').append(message);
  $('#conversation').scrollTop = $('#conversation').scrollHeight;
  return message;
}

function showError(message) { addMessage('assistant', message, true); }

function updateApiStatus(status) {
  settingsStatus = status;
  if (!status.configured && (voice.enabled || voice.starting)) stopVoiceListening();
  $('#apiStatus').classList.toggle('ready', status.configured);
  $('#apiStatus').lastChild.textContent = status.configured ? ` AI 設定済み · ${status.model}` : ' AI キー未設定';
  $('#apiKeyHint').textContent = status.keySource === 'saved'
    ? 'この端末に保存済みです。変更するときだけ新しいキーを入力してください。'
    : status.keySource === 'environment'
      ? '環境変数のキーを使用中です。ここに入力すると、この端末の設定が優先されます。'
      : 'まだキーが設定されていません。';
  $('#removeApiKeyButton').disabled = status.keySource !== 'saved';
}

function settingsMessage(message, error = false) {
  const target = $('#settingsMessage');
  target.textContent = message;
  target.classList.toggle('error', error);
  target.hidden = !message;
}

function settingsBusy(busy) {
  for (const selector of ['#apiKeyInput', '#modelInput', '#loadModelsButton', '#testConnectionButton', '#saveSettingsButton', '#removeApiKeyButton']) {
    $(selector).disabled = busy;
  }
  if (!busy) $('#removeApiKeyButton').disabled = settingsStatus.keySource !== 'saved';
}

async function openSettingsDialog() {
  $('#apiKeyInput').value = '';
  $('#apiKeyInput').type = 'password';
  $('#toggleApiKeyButton').textContent = '表示';
  $('#modelInput').value = settingsStatus.model;
  settingsMessage('');
  $('#settingsDialog').showModal();
  try {
    const status = await api('/api/settings');
    updateApiStatus(status);
    $('#modelInput').value = status.model;
  } catch (error) { settingsMessage(error.message, true); }
}

async function loadModels() {
  settingsBusy(true);
  settingsMessage('モデル一覧を取得しています…');
  try {
    const { models } = await api('/api/models', jsonOptions('POST', { apiKey: $('#apiKeyInput').value.trim() }));
    const options = $('#modelOptions');
    options.replaceChildren();
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model;
      options.append(option);
    }
    settingsMessage(`${models.length} 件のモデルを取得しました。入力欄から選べます。`);
  } catch (error) { settingsMessage(error.message, true); }
  finally { settingsBusy(false); }
}

async function checkSettingsConnection() {
  settingsBusy(true);
  settingsMessage('接続を確認しています…');
  try {
    const model = $('#modelInput').value.trim();
    await api('/api/settings/check', jsonOptions('POST', { apiKey: $('#apiKeyInput').value.trim(), model }));
    settingsMessage(`APIキーと ${model} の参照を確認できました。`);
  } catch (error) { settingsMessage(error.message, true); }
  finally { settingsBusy(false); }
}

async function saveSettings(event) {
  event.preventDefault();
  settingsBusy(true);
  settingsMessage('保存しています…');
  try {
    const status = await api('/api/settings', jsonOptions('PUT', {
      apiKey: $('#apiKeyInput').value.trim(), model: $('#modelInput').value.trim()
    }));
    $('#apiKeyInput').value = '';
    updateApiStatus(status);
    $('#settingsDialog').close();
    showToast('AI 設定を保存しました。');
  } catch (error) { settingsMessage(error.message, true); }
  finally { settingsBusy(false); }
}

async function removeSavedApiKey() {
  if (!confirm('この端末に保存した APIキーを削除しますか？')) return;
  settingsBusy(true);
  try {
    const status = await api('/api/settings', jsonOptions('PUT', { model: $('#modelInput').value.trim(), clearKey: true }));
    $('#apiKeyInput').value = '';
    updateApiStatus(status);
    settingsMessage(status.configured ? '保存済みのキーを削除しました。環境変数のキーを使用します。' : '保存済みのキーを削除しました。');
  } catch (error) { settingsMessage(error.message, true); }
  finally { settingsBusy(false); }
}

function setBusy(busy) {
  state.busy = busy;
  $('#sendButton').disabled = busy;
  $('#sendButton').title = busy ? '回答を待っています' : '送信';
}

function releaseVoiceAfterSpeech(playbackId) {
  if (playbackId !== voice.playbackId) return;
  voice.suppressed = false;
  voice.mutedUntil = Date.now() + 700;
  updateVoiceDisplay();
}

function speak(text) {
  if (!state.speaking || !('speechSynthesis' in window)) return;
  const playbackId = ++voice.playbackId;
  speechSynthesis.cancel();
  voice.suppressed = true;
  voice.segmenter?.reset();
  updateVoiceDisplay();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 700));
  utterance.lang = 'ja-JP';
  utterance.rate = 1.05;
  utterance.onend = () => releaseVoiceAfterSpeech(playbackId);
  utterance.onerror = () => releaseVoiceAfterSpeech(playbackId);
  speechSynthesis.speak(utterance);
}

function renderProposal(files) {
  const proposal = document.createElement('div');
  proposal.className = 'proposal';
  const title = document.createElement('div');
  title.className = 'proposal-title';
  title.append(icon('i-spark'), document.createTextNode(`${files.length} 件の変更案`));
  proposal.append(title);
  const fileList = document.createElement('div');
  fileList.className = 'proposal-files';
  for (const file of files) {
    const chip = document.createElement('span');
    chip.className = 'proposal-file';
    chip.textContent = file.path;
    fileList.append(chip);
  }
  proposal.append(fileList);
  for (const file of files) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${file.path} の内容を見る`;
    summary.style.cssText = 'font-size:10px;color:#accfc0;cursor:pointer;margin:7px 0';
    const code = document.createElement('pre');
    code.textContent = file.content;
    code.style.cssText = 'max-height:220px;overflow:auto;background:#101b1d;padding:10px;border-radius:6px;font-size:10px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere';
    details.append(summary, code);
    proposal.append(details);
  }
  const apply = document.createElement('button');
  apply.className = 'apply-button';
  apply.textContent = '変更を適用する';
  apply.addEventListener('click', async () => {
    const conflicts = files.filter(file => state.open.has(file.path) && state.open.get(file.path).content !== state.open.get(file.path).saved);
    if (conflicts.length && !confirm(`未保存の変更があるファイル（${conflicts.map(file => file.path).join('、')}）を上書きします。続けますか？`)) return;
    apply.disabled = true;
    apply.textContent = '適用中…';
    try {
      for (const file of files) {
        const existing = state.files.includes(file.path);
        const saved = await api('/api/file', jsonOptions('PUT', { ...file, create: !existing, expectedVersion: state.open.get(file.path)?.version }));
        state.open.set(file.path, { content: file.content, saved: file.content, version: saved.version });
        expandParents(file.path);
      }
      await refreshTree();
      await openFile(files[0].path);
      apply.textContent = '適用しました ✓';
      addMessage('assistant', '変更を適用しました。コードとプレビューを確認してください。');
      if (state.preview) refreshPreview();
    } catch (error) {
      apply.disabled = false;
      apply.textContent = '変更を適用する';
      showError(error.message);
    }
  });
  proposal.append(apply);
  $('#conversation').append(proposal);
  $('#conversation').scrollTop = $('#conversation').scrollHeight;
}

async function sendMessage(value = messageInput.value, preserveInput = false) {
  const text = value.trim();
  if (!text || state.busy) return;
  if (!preserveInput) messageInput.value = '';
  addMessage('user', text);
  const history = state.messages.slice(-8);
  state.messages.push({ role: 'user', content: text });
  setBusy(true);
  const pending = addMessage('assistant', '考えています…');
  try {
    const result = await api('/api/assistant', jsonOptions('POST', { message: text, activeFile: state.active, activeContent: state.open.get(state.active)?.content, history }));
    pending.remove();
    const answer = addMessage('assistant', result.reply || '回答がありませんでした。');
    answer.querySelector('.message-label').textContent = result.files?.length ? 'Vocode · 変更案' : 'Vocode · 回答';
    state.messages.push({ role: 'assistant', content: result.reply || '' });
    if (result.files?.length) renderProposal(result.files);
    speak(result.reply || '');
  } catch (error) { pending.remove(); showError(error.message); }
  finally { setBusy(false); if (!preserveInput) messageInput.focus(); }
}

function refreshPreview() {
  const html = state.active.endsWith('.html') ? state.active : (state.files.find(file => file === 'index.html') || state.files.find(file => file.endsWith('.html')));
  if (html) $('#previewFrame').src = `/preview/${html.split('/').map(encodeURIComponent).join('/')}?v=${Date.now()}`;
  else $('#previewFrame').srcdoc = '<p style="font-family:sans-serif;padding:2rem">HTML ファイルを作成するとプレビューが表示されます。</p>';
}

async function togglePreview() {
  if (!state.preview && state.active) {
    try { await saveFile(state.active); }
    catch (error) { showError(error.message); return; }
  }
  state.preview = !state.preview;
  $('#editorView').hidden = state.preview;
  $('#previewView').hidden = !state.preview;
  $('#previewButton').classList.toggle('selected', state.preview);
  $('#previewButton').replaceChildren(icon(state.preview ? 'i-code' : 'i-play'), document.createTextNode(state.preview ? 'エディタに戻る' : 'プレビュー'));
  if (state.preview) refreshPreview();
}

function updateVoiceDisplay() {
  const active = voice.enabled || voice.starting;
  const talking = voice.segmenter?.active && !voice.suppressed;
  $('#micButton').classList.toggle('listening', active);
  $('#micButton').classList.toggle('recording', Boolean(talking));
  $('#micButton').disabled = false;
  $('#micButton').title = active ? '音声待ち受けを停止' : '音声待ち受けを開始';
  $('#micButton').setAttribute('aria-label', active ? '音声待ち受けを停止' : '音声待ち受けを開始');
  $('#micButton').setAttribute('aria-pressed', String(active));
  $('#micHint').textContent = active ? '待ち受けを停止' : '声で話す';
  $('#recordingBanner').hidden = !active;
  $('#recordingBanner').classList.toggle('speaking', Boolean(talking));
  $('#voiceStatus').textContent = voice.starting ? 'マイクを準備しています…'
    : voice.suppressed || Date.now() < voice.mutedUntil ? '回答の読み上げ中は一時停止しています'
      : talking ? '聞き取っています。話し終えると自動送信します'
        : voice.processing || voice.queue.length ? '音声を処理中。次の発話も聞いています'
          : '声を待っています。話し終えると自動送信します';
  $('#recordingTime').textContent = talking ? `${Math.floor(voice.segmenter.recordedSamples / voice.segmenter.sampleRate)}秒` : '';
}

function stopVoiceListening() {
  voice.generation++;
  voice.enabled = false;
  voice.starting = false;
  voice.queue = [];
  voice.abort?.abort();
  voice.abort = null;
  voice.node?.disconnect();
  voice.node = null;
  voice.stream?.getTracks().forEach(track => track.stop());
  voice.stream = null;
  voice.context?.close().catch(() => {});
  voice.context = null;
  voice.segmenter = null;
  updateVoiceDisplay();
}

async function waitUntilReady(generation) {
  while (voice.enabled && voice.generation === generation && state.busy) {
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return voice.enabled && voice.generation === generation;
}

async function processVoiceQueue() {
  if (voice.processing) return;
  voice.processing = true;
  const generation = voice.generation;
  try {
    while (voice.enabled && voice.generation === generation && voice.queue.length) {
      const blob = voice.queue.shift();
      const pending = addMessage('assistant', '音声を文字にしています…');
      const abort = new AbortController();
      voice.abort = abort;
      updateVoiceDisplay();
      try {
        const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob, signal: abort.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '音声を文字にできませんでした。');
        if (!await waitUntilReady(generation)) break;
        if (data.text?.trim()) await sendMessage(data.text, true);
      } catch (error) {
        if (error.name !== 'AbortError' && voice.enabled && voice.generation === generation) showError(error.message);
      } finally {
        pending.remove();
        if (voice.abort === abort) voice.abort = null;
      }
    }
  } finally {
    voice.processing = false;
    updateVoiceDisplay();
    if (voice.enabled && voice.queue.length) processVoiceQueue();
  }
}

function receiveVoiceSamples(samples) {
  if (!voice.enabled || !voice.segmenter) return;
  if (voice.suppressed || Date.now() < voice.mutedUntil) {
    voice.segmenter.reset();
    return;
  }
  const result = voice.segmenter.push(samples);
  if (result.started) updateVoiceDisplay();
  if (voice.segmenter.active) $('#recordingTime').textContent = `${Math.floor(voice.segmenter.recordedSamples / voice.segmenter.sampleRate)}秒`;
  if (result.audio) {
    if (voice.queue.length < 4) voice.queue.push(wavBlob(result.audio, voice.segmenter.sampleRate));
    else showError('音声がたまっています。回答が終わるまで少しお待ちください。');
    updateVoiceDisplay();
    processVoiceQueue();
  }
}

async function toggleVoiceListening() {
  if (voice.enabled || voice.starting) { stopVoiceListening(); return; }
  if (!settingsStatus.configured) { showError('右上の AI 設定で OpenAI APIキーを登録してください。'); openSettingsDialog(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) return showError('このブラウザでは音声待ち受けを使えません。Chrome または Edge の最新版でお試しください。');
  const generation = ++voice.generation;
  voice.starting = true;
  updateVoiceDisplay();
  let stream;
  let context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (voice.generation !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
    context = new AudioContext();
    await context.audioWorklet.addModule('/voice-capture-processor.js');
    await context.resume();
    if (voice.generation !== generation) { stream.getTracks().forEach(track => track.stop()); await context.close(); return; }
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'vocode-voice-capture');
    source.connect(node);
    node.connect(context.destination);
    voice.stream = stream;
    voice.context = context;
    voice.node = node;
    voice.segmenter = new VoiceSegmenter(context.sampleRate);
    voice.enabled = true;
    voice.starting = false;
    node.port.onmessage = event => receiveVoiceSamples(event.data);
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      if (voice.enabled && voice.stream === stream) {
        stopVoiceListening();
        showError('マイクが切断されました。音声待ち受けを再開してください。');
      }
    });
    updateVoiceDisplay();
  } catch {
    stream?.getTracks().forEach(track => track.stop());
    context?.close().catch(() => {});
    if (voice.generation !== generation) return;
    voice.starting = false;
    updateVoiceDisplay();
    showError('マイクを使えませんでした。ブラウザのマイク許可を確認してください。');
  }
}

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveActive(); }
});
window.addEventListener('beforeunload', event => {
  if ([...state.open.values()].some(file => file.content !== file.saved)) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', stopVoiceListening);
$('#saveButton').addEventListener('click', saveActive);
$('#previewButton').addEventListener('click', togglePreview);
$('#saveLocalButton').addEventListener('click', () => $('#saveLocalDialog').showModal());
$('#saveFolderButton').addEventListener('click', saveToFolder);
$('#downloadZipButton').addEventListener('click', downloadZip);
$('#closeSaveLocalButton').addEventListener('click', () => $('#saveLocalDialog').close());
$('#settingsButton').addEventListener('click', openSettingsDialog);
$('#closeSettingsButton').addEventListener('click', () => $('#settingsDialog').close());
$('#toggleApiKeyButton').addEventListener('click', () => {
  const input = $('#apiKeyInput');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#toggleApiKeyButton').textContent = input.type === 'password' ? '表示' : '隠す';
});
$('#loadModelsButton').addEventListener('click', loadModels);
$('#testConnectionButton').addEventListener('click', checkSettingsConnection);
$('#settingsForm').addEventListener('submit', saveSettings);
$('#removeApiKeyButton').addEventListener('click', removeSavedApiKey);
if (!window.showDirectoryPicker) {
  $('#saveFolderButton').disabled = true;
  $('#saveFolderButton small').textContent = 'このブラウザでは利用できません。ZIP を選んでください。';
}
$('#refreshPreviewButton').addEventListener('click', refreshPreview);
$('#sendButton').addEventListener('click', () => sendMessage());
messageInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); } });
$('#micButton').addEventListener('click', toggleVoiceListening);
$('#speakButton').addEventListener('click', () => {
  state.speaking = !state.speaking;
  $('#speakButton').classList.toggle('active', state.speaking);
  $('#speakButton').title = state.speaking ? '回答を読み上げる' : '読み上げはオフ';
  if (!state.speaking && 'speechSynthesis' in window) { ++voice.playbackId; speechSynthesis.cancel(); releaseVoiceAfterSpeech(voice.playbackId); }
});
$('#newFileButton').addEventListener('click', () => openEntryDialog('file'));
$('#newFolderButton').addEventListener('click', () => openEntryDialog('folder'));
$('#chooseWorkspaceButton').addEventListener('click', openWorkspaceDialog);
$('#chooseEntryLocationButton').addEventListener('click', openWorkspaceDialog);
$('#browseWorkspaceButton').addEventListener('click', () => switchWorkspace({ url: '/api/workspace/choose', request: { method: 'POST' } }));
$('#cancelWorkspaceButton').addEventListener('click', () => $('#workspaceDialog').close());
$('#workspacePathInput').addEventListener('input', () => { $('#workspacePathError').hidden = true; });
$('#workspaceForm').addEventListener('submit', event => {
  event.preventDefault();
  const location = $('#workspacePathInput').value.trim();
  if (!location) {
    $('#workspacePathError').textContent = 'フォルダの絶対パスを入力してください。';
    $('#workspacePathError').hidden = false;
    $('#workspacePathInput').focus();
    return;
  }
  switchWorkspace({ url: '/api/workspace/open', request: jsonOptions('POST', { path: location }) });
});
$('#entryName').addEventListener('input', () => {
  $('#entryError').hidden = true;
  $('#entryName').removeAttribute('aria-invalid');
});
$('#entryForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!$('#entryName').value.trim()) {
    $('#entryError').hidden = false;
    $('#entryName').setAttribute('aria-invalid', 'true');
    $('#entryName').focus();
    return;
  }
  $('#entryDialog').close('submit');
});
$('#cancelEntryButton').addEventListener('click', () => $('#entryDialog').close('cancel'));
$('#cancelMoveButton').addEventListener('click', () => $('#moveDialog').close('cancel'));
$('#refreshTreeButton').addEventListener('click', () => refreshTree().catch(error => showError(error.message)));
$('#fileSearch').addEventListener('input', renderFiles);
$('#trashToggle').addEventListener('click', () => { $('#trashList').hidden = !$('#trashList').hidden; });
$('#projectHeading').addEventListener('dragover', event => { event.preventDefault(); $('#projectHeading').classList.add('drop-target'); });
$('#projectHeading').addEventListener('dragleave', () => $('#projectHeading').classList.remove('drop-target'));
$('#projectHeading').addEventListener('drop', event => { event.preventDefault(); $('#projectHeading').classList.remove('drop-target'); moveDropped(event.dataTransfer.getData('text/plain'), ''); });
document.addEventListener('click', event => { if (!event.target.closest('#entryMenu,.tree-menu-button')) hideEntryMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideEntryMenu(); });
$('#entryDialog').addEventListener('close', async () => {
  if ($('#entryDialog').returnValue !== 'submit' || !entryDialogAction) return;
  const { type, source, parent } = entryDialogAction;
  const name = $('#entryName').value.trim();
  if (!name) return;
  try {
    if (type === 'rename') {
      if (name.includes('/') || name.includes('\\')) throw new Error('名前に区切り文字は使えません。');
      await moveEntry(source, joinPath(parent, name));
    } else {
      const result = await api('/api/entries', jsonOptions('POST', { path: joinPath(parent, name), type }));
      expandParents(result.path);
      if (type === 'folder') { state.expanded.add(result.path); saveExpanded(); }
      await refreshTree();
      if (type === 'file') { await openFile(result.path); editor.focus(); }
      else { state.selected = result.path; renderFiles(); }
    }
  } catch (error) { showError(error.message); }
});
$('#moveDialog').addEventListener('close', () => {
  if ($('#moveDialog').returnValue !== 'submit') return;
  const source = $('#moveDialog').dataset.source;
  moveEntry(source, joinPath($('#moveDestination').value, baseName(source)));
});
$('#helpButton').addEventListener('click', () => $('#helpDialog').showModal());
$('#closeHelpButton').addEventListener('click', () => $('#helpDialog').close());
$('#conversation').addEventListener('click', event => {
  const button = event.target.closest('[data-suggestion]');
  if (!button) return;
  messageInput.value = button.dataset.suggestion;
  messageInput.focus();
});

try {
  const [status, data] = await Promise.all([api('/api/status'), api('/api/tree')]);
  updateApiStatus(status);
  setWorkspaceInfo(status.projectName, status.projectPath);
  state.tree = data.tree;
  state.trash = data.trash;
  state.files = allFiles();
  const savedExpanded = localStorage.getItem(`vocode-expanded:${state.projectPath}`);
  state.expanded = savedExpanded ? new Set(JSON.parse(savedExpanded)) : new Set(allFolders());
  renderFiles();
  renderTrash();
  if (state.files.length) await openFile(state.files.includes('index.html') ? 'index.html' : state.files[0]);
  else clearEditor();
} catch (error) { showError(error.message); }
