/* Интерфейс конструктора: редактор блоков, пошаговый просмотр и сохранение алгоритмов. */
(function () {
  'use strict';
  const E = window.AlgoEngine;
  const X = window.AlgoExamples;

  const KEY_CURRENT = 'algo-visualizer:current';
  const KEY_LIBRARY = 'algo-visualizer:library';
  const LEGACY_KEY = 'algo-visualizer:v1';

  // ---------- состояние ----------
  const state = {
    name: '',          // название текущего алгоритма
    blocks: [],
    savedJson: null,   // как выглядел алгоритм при последнем сохранении (для «есть изменения»)
    extra: {},         // необязательные поля файла: description, source, scenarios
    result: null,
    stepIndex: 0,
    playing: false,
    timer: null,
    fields: [],        // поля элементов из входных данных
    paramNames: [],
  };

  // ---------- хранилище в браузере ----------
  function storeGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  function storeSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }
  // ---------- где хранятся сохранённые алгоритмы ----------
  // В опубликованной версии (claude.ai) — хранилище страницы (db): переживает
  // перезагрузки и открывается с любого устройства. Всегда дублируется
  // в память браузера, а без хранилища (страница открыта как файл) — только там.
  const cloud = { db: null, downloads: null, lib: null };
  function localLibrary() { return storeGet(KEY_LIBRARY, {}) || {}; }
  function library() { return cloud.lib || localLibrary(); }
  function docIdFor(name) {
    let h = 0x811c9dc5;
    for (const ch of new TextEncoder().encode(name)) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
    return 'a' + h.toString(16).padStart(8, '0');
  }
  async function initCapabilities() {
    const c = window.claude;
    if (!c || typeof c.use !== 'function') return;
    c.use('downloads').then(d => { cloud.downloads = d; }, () => {});
    let db = null;
    try { db = await c.use('db'); } catch (_) { db = null; }
    if (!db) return;
    cloud.db = db;
    try {
      db.collection('algorithms').onSnapshot(snap => {
        const lib = {};
        for (const d of snap.docs) {
          const v = d.data();
          if (!v || typeof v.name !== 'string') continue;
          try { lib[v.name] = { blocks: JSON.parse(v.blocks), extra: v.extra ? JSON.parse(v.extra) : {}, savedAt: v.savedAt }; } catch (_) { /* битая запись */ }
        }
        const first = cloud.lib === null;
        cloud.lib = lib;
        if (first) migrateLocal(lib);
        renderLibrary();
      }, () => { cloud.db = null; cloud.lib = null; renderLibrary(); });
    } catch (_) { cloud.db = null; }
  }
  /** Перенести в хранилище то, что раньше сохранялось только в браузере. */
  async function migrateLocal(lib) {
    for (const [name, e] of Object.entries(localLibrary())) {
      if (lib[name] || !Array.isArray(e.blocks)) continue;
      try { await cloudWrite(name, e.blocks, e.extra, e.savedAt); } catch (_) { return; }
    }
  }
  async function cloudWrite(name, blocks, extra, savedAt) {
    await cloud.db.collection('algorithms').doc(docIdFor(name)).set({
      name, blocks: JSON.stringify(blocks), extra: JSON.stringify(extra || {}), savedAt: savedAt || new Date().toISOString(),
    });
  }
  async function writeEntry(name, blocks, extra) {
    const savedAt = new Date().toISOString();
    const lib = localLibrary();
    lib[name] = { blocks, extra: extra || {}, savedAt };
    const localOk = storeSet(KEY_LIBRARY, lib);
    if (cloud.db && cloud.lib) {
      await cloudWrite(name, blocks, extra, savedAt);
      cloud.lib = Object.assign({}, cloud.lib, { [name]: { blocks: JSON.parse(JSON.stringify(blocks)), extra: JSON.parse(JSON.stringify(extra || {})), savedAt } });
      return;
    }
    if (!localOk) throw new Error('local');
  }
  async function removeEntry(name) {
    const lib = localLibrary();
    delete lib[name];
    storeSet(KEY_LIBRARY, lib);
    if (cloud.db && cloud.lib) {
      await cloud.db.collection('algorithms').doc(docIdFor(name)).delete();
      const next = Object.assign({}, cloud.lib); delete next[name]; cloud.lib = next;
    }
  }

  function loadInitial() {
    const cur = storeGet(KEY_CURRENT, null);
    if (cur && Array.isArray(cur.blocks) && E.validate(cur.blocks).length === 0) {
      return { name: cur.name || '', blocks: cur.blocks, extra: cur.extra || {}, savedJson: cur.savedJson || null };
    }
    const legacy = storeGet(LEGACY_KEY, null);
    if (Array.isArray(legacy) && E.validate(legacy).length === 0) return { name: '', blocks: legacy, savedJson: null };
    return { name: '', blocks: X.byKey.cards.make(), savedJson: null };
  }
  function persistCurrent() {
    storeSet(KEY_CURRENT, { name: state.name, blocks: state.blocks, extra: state.extra, savedJson: state.savedJson });
  }

  // ---------- утилиты ----------
  const $ = id => document.getElementById(id);
  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = Boolean(v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }
  function option(value, text, selected) {
    const o = el('option', { value, text });
    if (selected) o.selected = true;
    return o;
  }
  function fmt(v, max) {
    let s;
    if (v === undefined) s = '—';
    else if (v === null) s = 'null';
    else if (typeof v === 'boolean') s = v ? 'да' : 'нет';
    else if (typeof v === 'string') s = v;
    else s = JSON.stringify(v);
    max = max || 48;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function fmtJson(v, max) {
    const s = v === undefined ? 'undefined' : JSON.stringify(v);
    max = max || 60;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }
  const isPlainObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const ICONS = {
    up: '<svg viewBox="0 0 16 16"><path d="M8 3l5 6H3z" fill="currentColor"/></svg>',
    down: '<svg viewBox="0 0 16 16"><path d="M8 13L3 7h10z" fill="currentColor"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 10V4a1 1 0 0 1 1-1h6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    del: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7"/></svg>',
  };
  function reassignIds(b) {
    b.id = E.createBlock(b.type).id;
    if (b.type === 'branch') { (b.yes || []).forEach(reassignIds); (b.no || []).forEach(reassignIds); }
    return b;
  }
  function inputBlock() { return state.blocks.find(b => b.type === 'input') || null; }

  /** Поля и параметры для выпадающих списков. */
  function refreshContext() {
    const ib = inputBlock();
    let items = [];
    try { items = ib ? E.parseInput(ib.data) : []; } catch (_) { items = []; }
    state.fields = E.fieldsOf(items);
    state.paramNames = ib ? (ib.params || []).map(p => p.name).filter(Boolean) : [];
  }
  function fieldInfo(name) { return state.fields.find(f => f.name === name) || null; }

  /** Какое поле показывать как «имя» элемента. */
  function labelField(items) {
    const objs = (items || []).filter(isPlainObj);
    if (!objs.length) return null;
    for (const k of ['name', 'title', 'id']) if (k in objs[0]) return k;
    const s = Object.keys(objs[0]).find(k => typeof objs[0][k] === 'string');
    return s || null;
  }
  function itemLabel(v, lf) {
    if (isPlainObj(v) && lf && v[lf] != null) return String(v[lf]);
    return fmtJson(v, 40);
  }

  // ---------- выполнение ----------
  let runTimer = null;
  function changed(opts) {
    opts = opts || {};
    persistCurrent();
    updateSaveState();
    if (opts.rerender) renderEditor();
    clearTimeout(runTimer);
    if (opts.now) runNow(opts.keepStep !== false);
    else runTimer = setTimeout(() => runNow(true), 250);
  }
  function runNow(keepStep) {
    state.result = E.run(state.blocks);
    const n = state.result.steps.length;
    if (!keepStep) state.stepIndex = Math.max(0, n - 1);
    state.stepIndex = Math.min(state.stepIndex, Math.max(0, n - 1));
    renderBlockStatus();
    renderParamsPanel();
    renderViewer();
  }

  // ---------- редактор ----------
  function renderEditor() {
    refreshContext();
    const y = window.scrollY;
    $('editor').replaceChildren(renderList(state.blocks, true));
    const count = countBlocks(state.blocks);
    $('block-count').textContent = count + ' ' + plural(count, 'блок', 'блока', 'блоков');
    renderBlockStatus();
    renderParamsPanel();
    window.scrollTo(0, y);
  }
  function countBlocks(list) {
    return list.reduce((s, b) => s + 1 + (b.type === 'branch' ? countBlocks(b.yes || []) + countBlocks(b.no || []) : 0), 0);
  }

  function renderList(list, top) {
    const frag = el('div', { class: 'flow' });
    list.forEach((b, i) => {
      if (i > 0) frag.append(el('div', { class: 'connector' }));
      frag.append(renderBlock(b, list, i));
    });
    frag.append(addButton(list, top));
    return frag;
  }

  function addButton(list, top) {
    const wrap = el('div', { class: 'add-wrap' });
    const btn = el('button', { class: 'add-btn', type: 'button', 'aria-haspopup': 'true', text: '+ блок' });
    let menu = null;
    function close() { if (menu) { menu.remove(); menu = null; document.removeEventListener('click', outside, true); } }
    function outside(e) { if (!wrap.contains(e.target)) close(); }
    btn.addEventListener('click', () => {
      if (menu) return close();
      menu = el('div', { class: 'add-menu', role: 'menu' });
      for (const [type, info] of Object.entries(E.BLOCK_TYPES)) {
        if (type === 'input' && (!top || inputBlock())) continue;
        menu.append(el('button', {
          type: 'button', role: 'menuitem',
          onclick: () => {
            close();
            const b = E.createBlock(type);
            if (info.hasCond) b.cond.rules.push(newRule());
            if (type === 'sort' && state.fields.length) b.expr = 'x.' + state.fields[0].name;
            list.push(b);
            changed({ rerender: true, now: true, keepStep: false });
          },
        }, el('span', { class: 'dot', style: '--c: var(--t-' + type + ')' }), info.title));
      }
      wrap.append(menu);
      document.addEventListener('click', outside, true);
    });
    wrap.append(btn);
    return wrap;
  }

  function renderBlock(b, list, index) {
    const info = E.BLOCK_TYPES[b.type];
    const card = el('div', { class: 'block t-' + b.type, 'data-id': b.id });
    card.addEventListener('click', e => {
      if (e.target.closest('input,textarea,select,button,label')) return;
      e.stopPropagation();
      jumpToBlock(b.id);
    });

    const head = el('div', { class: 'block-head' },
      el('span', { class: 'type-tag', text: info.title }),
      el('input', {
        class: 'block-label', value: b.label || '', placeholder: 'название (необязательно)',
        'aria-label': 'Название блока', oninput: e => { b.label = e.target.value; changed(); },
      }),
      el('div', { class: 'block-tools' },
        iconBtn('up', 'Выше', index === 0 || (b.type !== 'input' && list[index - 1].type === 'input'), () => swap(list, index, index - 1)),
        iconBtn('down', 'Ниже', index === list.length - 1 || b.type === 'input', () => swap(list, index, index + 1)),
        b.type === 'input' ? null : iconBtn('copy', 'Дублировать', false, () => {
          list.splice(index + 1, 0, reassignIds(JSON.parse(JSON.stringify(b))));
          changed({ rerender: true, now: true });
        }),
        iconBtn('del', 'Удалить', false, () => { list.splice(index, 1); changed({ rerender: true, now: true }); }, 'danger'),
      ),
    );
    card.append(head);

    switch (b.type) {
      case 'input': renderInputBody(card, b); break;
      case 'filter': renderCondBody(card, b, 'Оставить элемент, если'); break;
      case 'assert':
        renderCondBody(card, b, 'Для каждого элемента должно быть верно');
        card.append(el('label', { class: 'check' },
          el('input', { type: 'checkbox', checked: b.stopOnFail, onchange: e => { b.stopOnFail = e.target.checked; changed({ now: true }); } }),
          'остановить алгоритм, если нарушено'));
        break;
      case 'branch': {
        renderCondBody(card, b, 'Направить в «Да», если');
        b.yes = b.yes || []; b.no = b.no || [];
        const col = (cls, title, sub) => el('div', { class: 'branch-col ' + cls },
          el('h3', { text: title }),
          sub.length === 0 ? el('p', { class: 'empty', text: 'Пусто: элементы проходят без изменений' }) : null,
          renderList(sub, false));
        card.append(el('div', { class: 'branches' }, col('yes', 'Да', b.yes), col('no', 'Нет', b.no)));
        break;
      }
      case 'map':
        card.append(exprField(b, 'x →', 'x.balance * 2', 'expr'));
        card.append(el('div', { class: 'block-msg', text: 'Выражение JS. Например: ({ ...x, balance: x.balance * 2 }) или x.name' }));
        break;
      case 'sort': renderSortBody(card, b); break;
      case 'reduce':
        card.append(el('div', { class: 'field' },
          el('span', { class: 'kw', text: 'acc =' }),
          el('input', { class: 'small-input', value: b.init == null ? '' : b.init, spellcheck: 'false', 'aria-label': 'Начальное значение', oninput: e => { b.init = e.target.value; changed(); } }),
          el('span', { class: 'kw', text: 'затем acc =' }),
          el('input', { class: 'expr', value: b.expr || '', spellcheck: 'false', 'aria-label': 'Выражение свёртки', oninput: e => { b.expr = e.target.value; changed(); } })));
        break;
    }
    card.append(el('div', { class: 'block-msg', 'data-msg': '' }));
    return card;
  }

  function exprField(b, kw, placeholder, key) {
    return el('label', { class: 'field' },
      el('span', { class: 'kw', text: kw }),
      el('input', {
        class: 'expr', value: b[key] || '', placeholder, spellcheck: 'false', autocomplete: 'off',
        'aria-label': kw, oninput: e => { b[key] = e.target.value; changed(); },
      }));
  }

  // ----- входные данные: параметры + массив -----
  function renderInputBody(card, b) {
    b.params = b.params || [];
    const rows = el('div', { class: 'params' });
    b.params.forEach((p, i) => rows.append(paramRow(b, p, i)));
    card.append(el('div', { class: 'sub-head' },
      el('span', { class: 'sub-title', text: 'Параметры' }),
      el('span', { class: 'block-msg', text: 'флаги и числа, которые можно использовать в условиях' })));
    card.append(rows);
    card.append(el('button', {
      type: 'button', class: 'link-btn', text: '+ параметр',
      onclick: () => {
        let n = b.params.length + 1, name = 'param' + n;
        while (b.params.some(p => p.name === name)) name = 'param' + (++n);
        b.params.push({ name, type: 'boolean', value: false });
        changed({ rerender: true, now: true });
      },
    }));

    let items = [];
    let parseErr = null;
    try { items = E.parseInput(b.data); } catch (e) { parseErr = e.message; }
    card.append(el('div', { class: 'sub-head' },
      el('span', { class: 'sub-title', text: 'Элементы' }),
      el('span', { class: 'block-msg', text: parseErr ? '' : items.length + ' шт.' + (state.fields.length ? ', поля: ' + state.fields.map(f => f.name).join(', ') : '') })));
    const ta = el('textarea', {
      spellcheck: 'false', rows: String(Math.min(14, Math.max(3, String(b.data || '').split('\n').length))),
      'aria-label': 'Элементы (JSON)', class: 'data-area',
      oninput: e => { b.data = e.target.value; changed(); },
      onchange: () => changed({ rerender: true, now: true }),
    });
    ta.value = b.data || '';
    card.append(ta);
    card.append(el('div', { class: 'block-msg' }, 'JSON-массив, например [{"name": "Зарплатная", "balance": 15000}]. Срок действия: "2027-03", "03/27" или "2027-03-31".'));
  }

  function paramRow(b, p, i) {
    const valueCtl = paramValueControl(p, () => changed({ now: true }));
    return el('div', { class: 'param-row' },
      el('input', {
        class: 'p-name', value: p.name, spellcheck: 'false', 'aria-label': 'Имя параметра',
        oninput: e => { p.name = e.target.value.trim(); changed(); },
        onchange: () => changed({ rerender: true, now: true }),
      }),
      (() => {
        const s = el('select', {
          'aria-label': 'Тип параметра', class: 'p-type',
          onchange: e => { p.type = e.target.value; p.value = E.castParam(p.type, p.type === 'boolean' ? false : ''); changed({ rerender: true, now: true }); },
        });
        for (const [t, label] of Object.entries(E.PARAM_TYPES)) s.append(option(t, label, p.type === t));
        return s;
      })(),
      valueCtl,
      iconBtn('del', 'Удалить параметр', false, () => { b.params.splice(i, 1); changed({ rerender: true, now: true }); }, 'danger'),
    );
  }

  function paramValueControl(p, onChange) {
    switch (p.type) {
      case 'boolean':
        return el('label', { class: 'toggle' },
          el('input', { type: 'checkbox', checked: p.value === true, 'aria-label': p.name, onchange: e => {
            p.value = e.target.checked;
            e.target.nextElementSibling.textContent = p.value ? 'да' : 'нет';
            onChange();
          } }),
          el('span', { class: 'toggle-text', text: p.value === true ? 'да' : 'нет' }));
      case 'number':
        return el('input', { type: 'number', class: 'p-value', value: p.value == null ? '' : String(p.value), 'aria-label': p.name, oninput: e => { p.value = e.target.value === '' ? null : Number(e.target.value); onChange(); } });
      case 'date':
        return el('input', { type: 'date', class: 'p-value', value: p.value || '', 'aria-label': p.name, oninput: e => { p.value = e.target.value; onChange(); } });
      default:
        return el('input', { class: 'p-value', value: p.value || '', 'aria-label': p.name, oninput: e => { p.value = e.target.value; onChange(); } });
    }
  }

  // ----- условие: правила или код -----
  function newRule() {
    const f = state.fields[0];
    if (!f) return { left: { kind: 'field', name: '' }, op: 'eq', right: { kind: 'const', value: '' } };
    return defaultRuleFor({ kind: 'field', name: f.name });
  }
  function defaultRuleFor(left) {
    const t = left.kind === 'field' ? (fieldInfo(left.name) || {}).type : paramType(left.name);
    if (t === 'boolean') return { left, op: 'isTrue', right: { kind: 'const', value: '' } };
    if (t === 'date') return { left, op: 'gte', right: { kind: 'today', value: '' } };
    if (t === 'number') return { left, op: 'gte', right: { kind: 'const', value: '0' } };
    const f = left.kind === 'field' ? fieldInfo(left.name) : null;
    return { left, op: 'eq', right: { kind: 'const', value: f && f.samples.length ? String(f.samples[0]) : '' } };
  }
  function paramType(name) {
    const ib = inputBlock();
    const p = ib && (ib.params || []).find(q => q.name === name);
    return p ? p.type : null;
  }

  /** «Все совпавшие» или «только первая совпавшая» (для фильтра и ветвления). */
  function takeRow(b) {
    if (b.type !== 'filter' && b.type !== 'branch') return null;
    const branch = b.type === 'branch';
    const sel = el('select', { class: 'take-select', 'aria-label': 'Сколько совпавших брать',
      onchange: e => { b.take = e.target.value; changed({ now: true, rerender: true }); } },
      option('all', 'все совпавшие', b.take !== 'first'),
      option('first', 'только первая совпавшая', b.take === 'first'));
    return el('label', { class: 'take-row' },
      el('span', { class: 'kw', text: branch ? 'в «Да» идут' : 'результат:' }), sel,
      el('span', { class: 'block-msg', text: b.take === 'first' ? (branch ? 'остальные совпавшие уходят в «Нет»' : 'порядок элементов важен: сортировка выше по схеме') : '' }));
  }

  function renderCondBody(card, b, caption) {
    const code = b.condMode === 'code' || (!b.cond && typeof b.expr === 'string');
    if (!b.cond) b.cond = { join: 'and', rules: [] };

    const modeSwitch = el('div', { class: 'seg', role: 'group', 'aria-label': 'Способ задания условия' },
      el('button', { type: 'button', class: code ? '' : 'on', 'aria-pressed': String(!code), text: 'Правила',
        onclick: () => { b.condMode = 'rules'; changed({ rerender: true, now: true }); } }),
      el('button', { type: 'button', class: code ? 'on' : '', 'aria-pressed': String(code), text: 'Код',
        onclick: () => {
          b.condMode = 'code';
          if (!b.expr) b.expr = rulesToCode(b.cond) || 'true';
          changed({ rerender: true, now: true });
        } }));

    if (code) {
      card.append(el('div', { class: 'cond-head' }, el('span', { class: 'cond-caption', text: caption }), modeSwitch));
      const tr = takeRow(b); if (tr) card.append(tr);
      card.append(exprField(b, 'условие', 'x.balance >= p.minAmount', 'expr'));
      card.append(el('div', { class: 'block-msg', text: 'x — элемент, p — параметры, i — номер, data — весь массив' }));
      return;
    }

    const joinSel = el('select', { 'aria-label': 'Как объединять условия', class: 'join-select',
      onchange: e => { b.cond.join = e.target.value; changed({ now: true }); } },
      option('and', 'все условия (И)', b.cond.join !== 'or'),
      option('or', 'хотя бы одно (ИЛИ)', b.cond.join === 'or'));

    card.append(el('div', { class: 'cond-head' },
      el('span', { class: 'cond-caption' }, caption + ' ', b.cond.rules.length > 1 ? joinSel : null),
      modeSwitch));
    const tr = takeRow(b); if (tr) card.append(tr);

    const rules = el('div', { class: 'rules' });
    b.cond.rules.forEach((r, i) => {
      if (i > 0) rules.append(el('div', { class: 'join-chip', text: b.cond.join === 'or' ? 'или' : 'и' }));
      rules.append(ruleRow(b, r, i));
    });
    if (!b.cond.rules.length) rules.append(el('p', { class: 'empty', text: 'Нет условий: проходят все элементы' }));
    card.append(rules);
    card.append(el('button', { type: 'button', class: 'link-btn', text: '+ условие',
      onclick: () => { b.cond.rules.push(newRule()); changed({ rerender: true, now: true }); } }));
  }

  function rulesToCode(cond) {
    const js = r => {
      const side = o => {
        if (!o) return 'undefined';
        if (o.kind === 'field') return 'x.' + o.name;
        if (o.kind === 'param') return 'p.' + o.name;
        if (o.kind === 'today') return JSON.stringify(E.todayKey());
        return JSON.stringify(E.parseConst(o.value));
      };
      const a = side(r.left), bb = side(r.right);
      switch (r.op) {
        case 'eq': return a + ' === ' + bb;
        case 'ne': return a + ' !== ' + bb;
        case 'gt': return a + ' > ' + bb;
        case 'gte': return a + ' >= ' + bb;
        case 'lt': return a + ' < ' + bb;
        case 'lte': return a + ' <= ' + bb;
        case 'contains': return 'String(' + a + ').includes(' + bb + ')';
        case 'isTrue': return a + ' === true';
        case 'isFalse': return '!' + a;
        case 'isEmpty': return '(' + a + ' == null || ' + a + " === '')";
        case 'notEmpty': return '(' + a + ' != null && ' + a + " !== '')";
        default: return 'true';
      }
    };
    const parts = (cond.rules || []).map(js);
    return parts.join(cond.join === 'or' ? ' || ' : ' && ');
  }

  /** Выпадающий список «что проверяем»: поля элемента и параметры. */
  function operandSelect(current, allowKinds, onPick, label) {
    const s = el('select', { 'aria-label': label, class: 'operand' });
    const curVal = current ? current.kind + ':' + (current.name != null ? current.name : current.value || '') : '';
    let found = false;
    if (allowKinds.includes('field')) {
      const g = el('optgroup', { label: 'Поле элемента' });
      for (const f of state.fields) {
        const v = 'field:' + f.name;
        if (v === curVal) found = true;
        g.append(option(v, f.name, v === curVal));
      }
      if (current && current.kind === 'field' && current.name && !found) { g.append(option(curVal, current.name + ' (нет в данных)', true)); found = true; }
      s.append(g);
    }
    if (allowKinds.includes('param')) {
      const g = el('optgroup', { label: 'Параметр' });
      for (const name of state.paramNames) {
        const v = 'param:' + name;
        if (v === curVal) found = true;
        g.append(option(v, 'p.' + name, v === curVal));
      }
      if (current && current.kind === 'param' && current.name && !found) { g.append(option(curVal, 'p.' + current.name + ' (нет такого)', true)); found = true; }
      s.append(g);
    }
    if (!found) s.prepend(option('', 'выберите…', true));
    s.addEventListener('change', () => {
      const [kind, ...rest] = s.value.split(':');
      onPick({ kind, name: rest.join(':') });
    });
    return s;
  }

  function ruleRow(b, r, i) {
    const op = E.OPS[r.op] || E.OPS.eq;
    const row = el('div', { class: 'rule' });

    row.append(operandSelect(r.left, ['field', 'param'], picked => {
      const fresh = defaultRuleFor(picked);
      b.cond.rules[i] = fresh;
      changed({ rerender: true, now: true });
    }, 'Что проверяем'));

    const opSel = el('select', { 'aria-label': 'Операция', class: 'op',
      onchange: e => {
        r.op = e.target.value;
        if (!E.OPS[r.op].unary && (!r.right || (r.right.kind === 'const' && r.right.value === ''))) {
          r.right = r.right || { kind: 'const', value: '' };
        }
        changed({ rerender: true, now: true });
      } });
    for (const [k, o] of Object.entries(E.OPS)) opSel.append(option(k, o.label, k === r.op));
    row.append(opSel);

    if (!op.unary) {
      r.right = r.right || { kind: 'const', value: '' };
      const kindSel = el('select', { 'aria-label': 'С чем сравниваем', class: 'rkind',
        onchange: e => {
          const k = e.target.value;
          if (k === 'param') r.right = { kind: 'param', name: state.paramNames[0] || '' };
          else if (k === 'field') r.right = { kind: 'field', name: (state.fields[0] || {}).name || '' };
          else r.right = { kind: k, value: '' };
          changed({ rerender: true, now: true });
        } },
        option('const', 'значение', r.right.kind === 'const'),
        option('param', 'параметр', r.right.kind === 'param'),
        option('field', 'другое поле', r.right.kind === 'field'),
        option('today', 'сегодня', r.right.kind === 'today'));
      row.append(kindSel);

      if (r.right.kind === 'const') {
        const listId = 'dl-' + b.id + '-' + i;
        const f = r.left.kind === 'field' ? fieldInfo(r.left.name) : null;
        row.append(el('input', {
          class: 'rvalue', value: r.right.value == null ? '' : String(r.right.value), spellcheck: 'false',
          'aria-label': 'Значение', list: f && f.samples.length ? listId : null,
          placeholder: f && f.samples.length ? String(f.samples[0]) : 'значение',
          oninput: e => { r.right.value = e.target.value; changed(); },
        }));
        if (f && f.samples.length) row.append(el('datalist', { id: listId }, f.samples.map(v => el('option', { value: String(v) }))));
      } else if (r.right.kind === 'param' || r.right.kind === 'field') {
        row.append(operandSelect(r.right, [r.right.kind], picked => { r.right = picked; changed({ rerender: true, now: true }); }, 'Значение'));
      }
    }

    row.append(iconBtn('del', 'Удалить условие', false, () => { b.cond.rules.splice(i, 1); changed({ rerender: true, now: true }); }, 'danger'));
    row.append(el('span', { class: 'rule-status', 'data-rule': String(i) }));
    return row;
  }

  // ----- сортировка -----
  function renderSortBody(card, b) {
    const m = /^x\.([\w.]+)$/.exec(b.expr || '');
    const isField = m && fieldInfo(m[1]);
    const s = el('select', { 'aria-label': 'Ключ сортировки', class: 'operand',
      onchange: e => {
        b.expr = e.target.value === '__expr' ? (b.expr || 'x') : 'x.' + e.target.value;
        b._exprMode = e.target.value === '__expr';
        changed({ rerender: true, now: true });
      } });
    for (const f of state.fields) s.append(option(f.name, f.name, isField && m[1] === f.name && !b._exprMode));
    s.append(option('__expr', 'выражение…', !isField || b._exprMode));
    const order = el('select', { 'aria-label': 'Порядок', onchange: e => { b.order = e.target.value; changed({ now: true }); } },
      option('asc', 'по возрастанию', b.order !== 'desc'),
      option('desc', 'по убыванию', b.order === 'desc'));
    card.append(el('div', { class: 'field' }, el('span', { class: 'kw', text: 'по' }), s, order));
    if (!isField || b._exprMode) card.append(exprField(b, 'ключ =', 'x.balance', 'expr'));
  }

  function iconBtn(icon, title, disabled, onclick, extra) {
    return el('button', {
      type: 'button', class: 'icon-btn ' + (extra || ''), title, 'aria-label': title,
      disabled: disabled ? true : null, html: ICONS[icon], onclick,
    });
  }
  function swap(list, a, c) {
    [list[a], list[c]] = [list[c], list[a]];
    changed({ rerender: true, now: true });
  }

  /** Отметки на блоках: ошибка, нарушенное утверждение, текущий шаг, итог по правилам. */
  function renderBlockStatus() {
    const r = state.result;
    document.querySelectorAll('.block').forEach(card => {
      card.classList.remove('has-error', 'has-fail', 'active');
      const msg = card.querySelector(':scope > [data-msg]');
      if (msg) { msg.textContent = ''; msg.className = 'block-msg'; }
      card.querySelectorAll(':scope > .rules [data-rule]').forEach(s => { s.textContent = ''; s.className = 'rule-status'; });
    });
    if (!r) return;
    for (const s of r.steps) {
      if (s.type === 'merge') continue;
      const card = document.querySelector('.block[data-id="' + s.blockId + '"]');
      if (!card) continue;
      // сколько элементов прошло каждое правило
      if (s.ruleLabels && s.marks.length) {
        card.querySelectorAll(':scope > .rules [data-rule]').forEach(span => {
          const k = Number(span.getAttribute('data-rule'));
          const passed = s.marks.filter(m => m.rules && m.rules[k]).length;
          span.textContent = passed + '/' + s.marks.length;
          span.title = 'Верно для ' + passed + ' из ' + s.marks.length;
        });
      }
      if (s.status === 'ok') continue;
      card.classList.add(s.status === 'error' ? 'has-error' : 'has-fail');
      const msg = card.querySelector(':scope > [data-msg]');
      if (msg) { msg.textContent = s.message; msg.className = 'block-msg ' + (s.status === 'error' ? 'err' : 'fail'); }
    }
    const cur = r.steps[state.stepIndex];
    if (cur) {
      const card = document.querySelector('.block[data-id="' + cur.blockId + '"]');
      if (card) card.classList.add('active');
    }
  }

  function jumpToBlock(id) {
    if (!state.result) return;
    const idx = state.result.steps.findIndex(s => s.blockId === id);
    if (idx >= 0) { stop(); setStep(idx); }
  }

  // ---------- быстрые параметры в панели выполнения ----------
  function renderParamsPanel() {
    const box = $('params-panel');
    if (box.contains(document.activeElement) && document.activeElement.type !== 'checkbox') return; // не мешаем вводу
    const ib = inputBlock();
    const params = ib ? (ib.params || []).filter(p => p.name) : [];
    box.hidden = params.length === 0;
    if (!params.length) { box.replaceChildren(); return; }
    box.replaceChildren(
      el('span', { class: 'lbl', text: 'Параметры' }),
      ...params.map(p => el('div', { class: 'qp' },
        el('span', { class: 'qp-name', text: p.name }),
        paramValueControl(p, () => { changed({ now: true }); syncInputBlock(); }))));
  }

  /** Перерисовать только блок входных данных (после правки параметров в панели). */
  let syncTimer = null;
  function syncInputBlock() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      const ib = inputBlock();
      const old = ib && document.querySelector('.block[data-id="' + ib.id + '"]');
      if (!old || old.contains(document.activeElement)) return;
      const idx = state.blocks.indexOf(ib);
      old.replaceWith(renderBlock(ib, state.blocks, idx));
      renderBlockStatus();
    }, 300);
  }

  // ---------- просмотр шагов ----------
  function setStep(i) {
    const n = state.result ? state.result.steps.length : 0;
    state.stepIndex = Math.max(0, Math.min(i, n - 1));
    renderBlockStatus();
    renderViewer();
    const cur = state.result && state.result.steps[state.stepIndex];
    if (cur && state.playing) {
      const card = document.querySelector('.block[data-id="' + cur.blockId + '"]');
      if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function renderViewer() {
    const r = state.result;
    const steps = r ? r.steps : [];
    const n = steps.length;

    // итог
    let pill;
    if (!r || n === 0) pill = el('span', { class: 'pill ok', text: 'нет шагов' });
    else if (r.error) pill = el('span', { class: 'pill error', text: 'ошибка' });
    else if (!r.ok) pill = el('span', { class: 'pill fail', text: 'утверждение нарушено' });
    else pill = el('span', { class: 'pill ok', text: 'успешно' });
    let outText;
    if (r && r.error) outText = r.error;
    else {
      const out = r ? r.output : [];
      const lf = labelField(out);
      outText = 'Результат (' + out.length + '): ' + (out.length ? out.map(v => itemLabel(v, lf)).join(', ') : 'пусто');
    }
    $('summary').replaceChildren(pill, el('span', { class: 'out', text: outText }));

    // плеер
    const scrub = $('scrub');
    scrub.max = String(Math.max(0, n - 1));
    scrub.value = String(state.stepIndex);
    scrub.disabled = n <= 1;
    $('counter').textContent = n ? (state.stepIndex + 1) + ' / ' + n : '0 / 0';
    $('btn-first').disabled = $('btn-prev').disabled = state.stepIndex <= 0;
    $('btn-next').disabled = state.stepIndex >= n - 1;
    $('btn-play').textContent = state.playing ? '❚❚ Пауза' : '▶ Пуск';

    $('step').replaceChildren(...renderStep(steps[state.stepIndex], r));

    const tl = $('timeline');
    tl.replaceChildren(...steps.map((s, i) => el('button', {
      type: 'button', class: i === state.stepIndex ? 'cur' : '',
      style: 'padding-left:' + (8 + s.depth * 16) + 'px', onclick: () => { stop(); setStep(i); },
    },
      el('span', { class: 'n', text: String(i + 1) }),
      el('span', { class: 'st ' + s.status }),
      el('span', { class: 't', text: s.title }),
      el('span', { class: 'm', text: s.message }))));
    const curBtn = tl.children[state.stepIndex];
    if (curBtn && curBtn.scrollIntoView && state.playing) curBtn.scrollIntoView({ block: 'nearest' });
  }

  const STATUS_TEXT = {
    kept: 'проходит', dropped: 'отброшен', pass: 'верно', fail: 'нарушено', skipped: 'совпал, не первый',
    yes: 'да', no: 'нет', new: '', changed: '', moved: '', folded: '',
  };

  function chips(values, marks, lf) {
    if (!values || values.length === 0) return el('div', { class: 'chips' }, el('span', { class: 'none', text: 'пусто' }));
    const byIndex = new Map((marks || []).map(m => [m.index, m]));
    return el('div', { class: 'chips' }, values.map((v, i) => {
      const m = byIndex.get(i);
      return el('span', { class: 'chip ' + (m ? m.status : ''), title: JSON.stringify(v) },
        el('span', { class: 'idx', text: String(i) }), lf !== undefined ? itemLabel(v, lf) : fmtJson(v, 48));
    }));
  }

  /** Таблица элементов: поля + (если есть) колонка результата и колонки правил. */
  function itemsTable(items, marks, ruleLabels, opts) {
    opts = opts || {};
    if (!items || !items.length) return el('div', { class: 'chips' }, el('span', { class: 'none', text: 'пусто' }));
    if (!items.every(isPlainObj)) return chips(items, marks);
    const byIndex = new Map((marks || []).map(m => [m.index, m]));
    const fields = E.fieldsOf(items).map(f => f.name);
    const showStatus = marks && marks.some(m => STATUS_TEXT[m.status]);
    const head = el('tr', {},
      el('th', { text: '#' }),
      showStatus ? el('th', { text: opts.statusTitle || 'итог' }) : null,
      (ruleLabels || []).map((t, k) => el('th', { class: 'rule-col', title: t, text: 'П' + (k + 1) })),
      fields.map(f => el('th', { text: f })));
    const body = items.map((it, i) => {
      const m = byIndex.get(i);
      return el('tr', { class: m ? 'row-' + m.status : '' },
        el('td', { class: 'num', text: String(i) }),
        showStatus ? el('td', {}, m ? el('span', { class: 'tag ' + m.status, text: STATUS_TEXT[m.status] }) : null) : null,
        (ruleLabels || []).map((_, k) => {
          const ok = m && m.rules ? m.rules[k] : null;
          return el('td', { class: 'rule-cell ' + (ok ? 'yes' : 'no'), text: ok == null ? '' : ok ? '✓' : '✗' });
        }),
        fields.map(f => {
          const v = E.getPath(it, f);
          return el('td', { class: typeof v === 'number' ? 'n-cell' : '', text: fmt(v, 32) });
        }));
    });
    return el('div', { class: 'table-wrap' }, el('table', { class: 'trace-table items' }, el('thead', {}, head), el('tbody', {}, body)));
  }

  function ruleLegend(s) {
    if (!s.ruleLabels || !s.ruleLabels.length) {
      return s.condText ? el('p', { class: 'cond-line' }, el('span', { class: 'kw', text: 'условие: ' }), el('code', { text: s.condText })) : null;
    }
    return el('ol', { class: 'rule-legend' },
      s.ruleLabels.map((t, k) => el('li', {},
        el('span', { class: 'rule-id', text: 'П' + (k + 1) }),
        el('code', { text: t }),
        k < s.ruleLabels.length - 1 ? el('span', { class: 'join-chip', text: s.join === 'or' ? 'или' : 'и' }) : null)));
  }

  function row(label, content, cls) {
    return el('div', { class: 'data-row ' + (cls || '') }, el('span', { class: 'lbl', text: label }), content);
  }

  function renderStep(s, r) {
    if (!s) return [el('p', { class: 'step-msg', text: 'Добавьте блок «Входные данные», чтобы начать.' })];
    const out = [];
    out.push(el('div', { class: 'step-title' },
      el('strong', { text: s.title }),
      s.path ? el('span', { class: 'crumb', text: 'ветка: ' + s.path }) : null,
      s.status !== 'ok' ? el('span', { class: 'pill ' + s.status, text: s.status === 'error' ? 'ошибка' : 'нарушено' }) : null));
    out.push(el('p', { class: 'step-msg ' + s.status, text: s.message }));

    const lfBefore = labelField(s.before);
    switch (s.type) {
      case 'input':
        if (s.params && Object.keys(s.params).length) {
          out.push(row('Параметры', el('div', { class: 'chips' },
            Object.entries(s.params).map(([k, v]) => el('span', { class: 'chip param' }, el('span', { class: 'idx', text: k }), fmt(v))))));
        }
        if (s.after) out.push(row('Элементы', itemsTable(s.after, null)));
        if (r && r.today) out.push(el('p', { class: 'block-msg', text: '«Сегодня» в условиях: ' + r.today }));
        break;
      case 'filter':
        out.push(ruleLegend(s));
        out.push(row('Проверка', itemsTable(s.before, s.marks, s.ruleLabels)));
        if (s.after) out.push(row('Осталось', chips(s.after, null, lfBefore)));
        break;
      case 'assert':
        out.push(ruleLegend(s));
        out.push(row('Проверка', itemsTable(s.before, s.marks, s.ruleLabels)));
        break;
      case 'branch':
        out.push(ruleLegend(s));
        out.push(row('Проверка', itemsTable(s.before, s.marks, s.ruleLabels, { statusTitle: 'ветка' })));
        if (s.split) out.push(el('div', { class: 'split' },
          row('Да', chips(s.split.yes, null, lfBefore), 'yes-box'),
          row('Нет', chips(s.split.no, null, lfBefore), 'no-box')));
        break;
      case 'merge': {
        const lf = labelField(s.after);
        if (s.split) out.push(el('div', { class: 'split' },
          row('Из ветки «да»', chips(s.split.yes, null, lf), 'yes-box'),
          row('Из ветки «нет»', chips(s.split.no, null, lf), 'no-box')));
        out.push(row('После слияния', itemsTable(s.after, null)));
        break;
      }
      case 'map':
        if (s.marks.length) out.push(tableOf(['#', 'было', '', 'стало'], s.marks.map(m => [m.index, fmtJson(m.from, 60), '→', fmtJson(m.to, 60)])));
        else out.push(row('До', chips(s.before, null)));
        break;
      case 'sort':
        out.push(row('До', chips(s.before, null, lfBefore)));
        if (s.after) out.push(row('После', itemsTable(s.after, null)));
        break;
      case 'reduce':
        if (s.marks.length) {
          out.push(tableOf(['#', 'элемент', 'acc было', '', 'acc стало'],
            s.marks.map(m => [m.index, fmtJson(s.before[m.index], 40), fmtJson(m.from, 40), '→', fmtJson(m.to, 40)])));
        } else out.push(row('До', chips(s.before, null)));
        break;
      default:
        out.push(row('До', chips(s.before, null)));
    }
    if (s.status === 'error') out.push(row('Данные на входе блока', itemsTable(s.before, null)));
    return out.filter(Boolean);
  }

  function tableOf(headers, rows) {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'trace-table' },
      el('thead', {}, el('tr', {}, headers.map(h => el('th', { text: h })))),
      el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', { class: c === '→' ? 'arrow' : null, text: String(c) })))))));
  }

  // ---------- проигрывание ----------
  function play() {
    const n = state.result ? state.result.steps.length : 0;
    if (n === 0) return;
    if (state.stepIndex >= n - 1) setStep(0);
    state.playing = true;
    renderViewer();
    state.timer = setInterval(() => {
      if (state.stepIndex >= state.result.steps.length - 1) { stop(); return; }
      setStep(state.stepIndex + 1);
    }, 1200);
  }
  function stop() {
    if (!state.playing && !state.timer) return;
    state.playing = false;
    clearInterval(state.timer);
    state.timer = null;
    renderViewer();
  }

  // ---------- сохранение ----------
  function currentJson() { return JSON.stringify(state.blocks); }
  function updateSaveState() {
    const dirty = state.savedJson !== currentJson();
    const st = $('save-state');
    if (!state.name && !state.savedJson) st.textContent = 'не сохранён';
    else st.textContent = dirty ? 'есть несохранённые изменения' : 'сохранён';
    st.className = 'save-state' + (dirty ? ' dirty' : '');
    renderLibrary();
  }
  function renderLibrary() {
    const lib = library();
    const sel = $('library');
    const names = Object.keys(lib).sort((a, b) => a.localeCompare(b, 'ru'));
    sel.replaceChildren(option('', names.length ? 'Мои алгоритмы (' + names.length + ')…' : 'Сохранённых пока нет', true));
    for (const n of names) sel.append(option(n, n + (n === state.name ? ' — открыт' : ''), false));
    $('btn-delete').disabled = !state.name || !lib[state.name];
  }
  function flash(text, err) {
    const st = $('save-state');
    st.textContent = text;
    st.className = 'save-state' + (err ? ' err' : ' good');
    clearTimeout(flash.t);
    flash.t = setTimeout(updateSaveState, 2500);
  }

  async function saveToLibrary() {
    let name = $('algo-name').value.trim();
    if (!name && fileHandle) { name = fileHandle.name.replace(/(\.algo)?\.json$/i, ''); $('algo-name').value = name; }
    if (!name) { $('algo-name').focus(); flash('Введите название, чтобы сохранить', true); return; }
    state.name = name;
    try {
      await writeEntry(name, state.blocks, state.extra);
    } catch (_) {
      flash('Не получилось сохранить в список. Сохраните файлом.', true);
      return;
    }
    state.savedJson = currentJson();
    persistCurrent();
    updateSaveState();
    if (fileHandle) {
      try { await writeToHandle(fileHandle); flash('Сохранено: ' + name + ' и файл ' + fileHandle.name); return; }
      catch (_) { unlinkFile(); flash('Сохранено в список, но файл записать не удалось', true); return; }
    }
    flash('Сохранено: ' + name);
  }

  function openAlgorithm(name, blocks, savedJson, handle, extra) {
    stop();
    state.extra = extra || {};
    state.name = name || '';
    state.blocks = blocks;
    state.savedJson = savedJson === undefined ? null : savedJson;
    fileHandle = handle || null;
    updateFileButtons();
    $('algo-name').value = state.name;
    persistCurrent();
    renderEditor();
    updateSaveState();
    runNow(false);
    setStep(0);
  }

  let deleteArmed = null;
  async function deleteFromLibrary() {
    const lib = library();
    if (!state.name || !lib[state.name]) return;
    const btn = $('btn-delete');
    if (deleteArmed !== state.name) {
      deleteArmed = state.name;
      btn.textContent = 'Точно удалить?';
      btn.classList.add('danger');
      setTimeout(() => { deleteArmed = null; btn.textContent = 'Удалить'; btn.classList.remove('danger'); }, 3000);
      return;
    }
    deleteArmed = null;
    btn.textContent = 'Удалить';
    btn.classList.remove('danger');
    const removed = state.name;
    try { await removeEntry(removed); } catch (_) { flash('Не получилось удалить', true); return; }
    state.savedJson = null;
    persistCurrent();
    updateSaveState();
    flash('Удалён из списка: ' + removed);
  }

  // ---------- внешний файл ----------
  // 1) В claude.ai: сохранение файла через платформу (с подтверждением).
  // 2) В Chrome/Edge, открытых локально: выбранный файл запоминается,
  //    и «Сохранить» дальше перезаписывает его же.
  // 3) Иначе: обычное скачивание.
  let fileHandle = null;
  function fileName() {
    const base = (state.name || 'алгоритм').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'алгоритм';
    return base + '.algo.json';
  }
  function fileJson() {
    return JSON.stringify(E.serialize(state.name || 'Без названия', state.blocks, state.extra), null, 2) + '\n';
  }
  async function writeToHandle(h) {
    const w = await h.createWritable();
    await w.write(fileJson());
    await w.close();
  }
  function unlinkFile() { fileHandle = null; updateFileButtons(); }
  function updateFileButtons() {
    $('btn-download').textContent = fileHandle ? 'Записать в файл' : 'Сохранить в файл';
    const link = $('file-link');
    link.hidden = !fileHandle;
    if (fileHandle) {
      link.replaceChildren(
        el('span', { text: 'файл: ' + fileHandle.name }),
        el('button', { type: 'button', class: 'icon-btn', title: 'Отвязать файл', 'aria-label': 'Отвязать файл', html: ICONS.del, onclick: unlinkFile }));
    }
  }
  function blobDownload(data) {
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = el('a', { href: url, download: fileName() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function downloadFile() {
    if (fileHandle) {
      try { await writeToHandle(fileHandle); flash('Записано в файл ' + fileHandle.name); return; }
      catch (_) { unlinkFile(); }
    }
    const data = fileJson();
    if (cloud.downloads) {
      try {
        await cloud.downloads.save({ filename: fileName(), data });
        flash('Файл сохранён: ' + fileName());
      } catch (e) {
        if (e && e.code === 'declined') flash('Сохранение файла отменено');
        else if (e && e.code === 'rate_limited') flash('Подождите пару секунд и попробуйте ещё раз', true);
        else { flash('Файл сохранить не удалось: скопируйте JSON', true); openIO(); }
      }
      return;
    }
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const h = await window.showSaveFilePicker({
          suggestedName: fileName(),
          types: [{ description: 'Алгоритм', accept: { 'application/json': ['.json'] } }],
        });
        await writeToHandle(h);
        fileHandle = h;
        updateFileButtons();
        flash('Сохранено в ' + h.name + '. Дальше «Сохранить» обновляет этот файл.');
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        // выбор файла запрещён в этой среде — скачиваем обычным способом
      }
    }
    try { blobDownload(data); flash('Файл: ' + fileName()); } catch (_) { openIO(); }
  }

  function openFileText(text, displayName, handle) {
    try {
      const { name, blocks, extra } = E.deserialize(text);
      const n = (name && name !== 'Без названия') ? name : displayName.replace(/(\.algo)?\.json$/i, '');
      openAlgorithm(n, blocks, null, handle, extra);
      flash('Открыт файл: ' + displayName + (handle ? '. «Сохранить» будет обновлять его.' : ''));
    } catch (e) {
      flash(e.message, true);
    }
  }
  async function pickFileToOpen() {
    if (typeof window.showOpenFilePicker === 'function' && !cloud.db) {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'Алгоритм', accept: { 'application/json': ['.json'] } }] });
        const f = await h.getFile();
        openFileText(await f.text(), f.name, h);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    $('file-input').click();
  }
  function openFile(file) {
    const reader = new FileReader();
    reader.onload = () => openFileText(String(reader.result), file.name, null);
    reader.readAsText(file);
  }

  // ----- окно JSON -----
  function openIO() {
    $('io-text').value = JSON.stringify(E.serialize(state.name || 'Без названия', state.blocks, state.extra), null, 2);
    setNote('Скопируйте, чтобы сохранить, или вставьте свой алгоритм и нажмите «Загрузить».');
    $('modal').hidden = false;
    $('io-text').focus();
  }
  function setNote(text, err) {
    const n = $('io-note'); n.textContent = text; n.className = 'note' + (err ? ' err' : '');
  }

  // ---------- старт ----------
  function init() {
    const sel = $('preset');
    sel.append(option('', 'Примеры…', true));
    for (const ex of X.list) sel.append(option(ex.key, ex.title));
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const ex = X.byKey[sel.value];
      sel.value = '';
      openAlgorithm('', ex.make(), null, null, ex.extra);
    });

    $('btn-new').addEventListener('click', () => {
      openAlgorithm('', [E.createBlock('input', {
        params: [{ name: 'creditAllowed', type: 'boolean', value: false }],
        data: JSON.stringify(X.CARDS.slice(0, 3), null, 1),
      })], null);
      $('algo-name').focus();
    });

    $('algo-name').addEventListener('input', e => { state.name = e.target.value.trim(); persistCurrent(); });
    $('algo-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveToLibrary(); });
    $('btn-save').addEventListener('click', saveToLibrary);
    $('btn-delete').addEventListener('click', deleteFromLibrary);
    $('library').addEventListener('change', e => {
      const name = e.target.value;
      if (!name) return;
      const entry = library()[name];
      if (!entry) return;
      openAlgorithm(name, JSON.parse(JSON.stringify(entry.blocks)), JSON.stringify(entry.blocks), null, JSON.parse(JSON.stringify(entry.extra || {})));
      flash('Открыт: ' + name);
    });
    $('btn-download').addEventListener('click', downloadFile);
    $('btn-open-file').addEventListener('click', pickFileToOpen);
    $('file-input').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) openFile(f);
      e.target.value = '';
    });

    $('btn-io').addEventListener('click', openIO);
    $('io-close').addEventListener('click', () => { $('modal').hidden = true; });
    $('modal').addEventListener('click', e => { if (e.target === $('modal')) $('modal').hidden = true; });
    $('io-copy').addEventListener('click', () => {
      const text = $('io-text').value;
      const fallback = () => { $('io-text').select(); setNote('Текст выделен, нажмите Cmd+C / Ctrl+C.'); };
      try { navigator.clipboard.writeText(text).then(() => setNote('Скопировано.'), fallback); } catch (_) { fallback(); }
    });
    $('io-load').addEventListener('click', () => {
      try {
        const { name, blocks, extra } = E.deserialize($('io-text').value);
        $('modal').hidden = true;
        openAlgorithm(name === 'Без названия' ? '' : name, blocks, null, null, extra);
      } catch (e) { setNote(e.message, true); }
    });

    $('btn-first').addEventListener('click', () => { stop(); setStep(0); });
    $('btn-prev').addEventListener('click', () => { stop(); setStep(state.stepIndex - 1); });
    $('btn-next').addEventListener('click', () => { stop(); setStep(state.stepIndex + 1); });
    $('btn-play').addEventListener('click', () => (state.playing ? stop() : play()));
    $('scrub').addEventListener('input', e => { stop(); setStep(Number(e.target.value)); });

    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveToLibrary(); return; }
      if (e.target.closest('input,textarea,select') || !$('modal').hidden) {
        if (e.key === 'Escape') $('modal').hidden = true;
        return;
      }
      if (e.key === 'ArrowRight') { stop(); setStep(state.stepIndex + 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { stop(); setStep(state.stepIndex - 1); e.preventDefault(); }
      else if (e.key === ' ') { state.playing ? stop() : play(); e.preventDefault(); }
    });

    const initial = loadInitial();
    openAlgorithm(initial.name, initial.blocks, initial.savedJson, null, initial.extra);
    initCapabilities();
  }

  init();
})();
