/* Интерфейс конструктора: редактор блоков + пошаговый просмотр выполнения. */
(function () {
  'use strict';
  const E = window.AlgoEngine;
  const STORE_KEY = 'algo-visualizer:v1';

  // ---------- примеры ----------
  const B = (type, props) => E.createBlock(type, props);
  const PRESETS = {
    numbers: {
      title: 'Пример: числа и ветвление',
      make: () => [
        B('input', { label: 'Числа', data: '[7, 2, 9, 4, 12, 5, 8, 1]' }),
        B('filter', { label: 'Убрать единицы', expr: 'x > 1' }),
        B('branch', {
          label: 'Чётное?', expr: 'x % 2 === 0',
          yes: [B('map', { label: 'Половина', expr: 'x / 2' })],
          no: [B('map', { label: 'Утроить и +1', expr: 'x * 3 + 1' })],
        }),
        B('assert', { label: 'Все целые', expr: 'Number.isInteger(x)' }),
        B('sort', { expr: 'x', order: 'asc' }),
        B('reduce', { label: 'Сумма', expr: 'acc + x', init: '0' }),
      ],
    },
    students: {
      title: 'Пример: список студентов',
      make: () => [
        B('input', {
          label: 'Студенты',
          data: JSON.stringify([
            { name: 'Аня', score: 82 }, { name: 'Борис', score: 45 }, { name: 'Вика', score: 67 },
            { name: 'Гоша', score: 30 }, { name: 'Даша', score: 95 },
          ], null, 1),
        }),
        B('assert', { label: 'Баллы в диапазоне', expr: 'x.score >= 0 && x.score <= 100' }),
        B('branch', {
          label: 'Сдал?', expr: 'x.score >= 50',
          yes: [B('map', { expr: "x.name + ' — сдал (' + x.score + ')'" })],
          no: [
            B('map', { label: 'Добавить 10 баллов', expr: '({ name: x.name, score: x.score + 10 })' }),
            B('map', { expr: "x.name + ' — пересдача'" }),
          ],
        }),
      ],
    },
    broken: {
      title: 'Пример: нарушенное утверждение',
      make: () => [
        B('input', { label: 'Температуры', data: '21, 19, -3, 25, 40' }),
        B('map', { label: 'В Фаренгейты', expr: 'x * 9 / 5 + 32' }),
        B('assert', { label: 'Выше нуля по Фаренгейту', expr: 'x > 32', stopOnFail: false }),
        B('filter', { label: 'Жарко', expr: 'x >= 77' }),
      ],
    },
  };

  // ---------- состояние ----------
  const state = {
    blocks: [],
    result: null,
    stepIndex: 0,
    playing: false,
    timer: null,
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const blocks = JSON.parse(raw);
        if (E.validate(blocks).length === 0) return blocks;
      }
    } catch (_) { /* хранилище недоступно — начинаем с примера */ }
    return PRESETS.numbers.make();
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.blocks)); } catch (_) { /* ничего */ }
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
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }
  function fmt(v, max) {
    let s;
    if (typeof v === 'string') s = JSON.stringify(v);
    else if (v === undefined) s = 'undefined';
    else s = JSON.stringify(v);
    max = max || 48;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  const ICONS = {
    up: '<svg viewBox="0 0 16 16"><path d="M8 3l5 6H3z" fill="currentColor"/></svg>',
    down: '<svg viewBox="0 0 16 16"><path d="M8 13L3 7h10z" fill="currentColor"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 10V4a1 1 0 0 1 1-1h6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    del: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7"/></svg>',
  };
  function reassignIds(b) {
    const fresh = E.createBlock(b.type);
    b.id = fresh.id;
    if (b.type === 'branch') { (b.yes || []).forEach(reassignIds); (b.no || []).forEach(reassignIds); }
    return b;
  }

  // ---------- выполнение ----------
  let runTimer = null;
  function scheduleRun(keepStep) {
    clearTimeout(runTimer);
    runTimer = setTimeout(() => runNow(keepStep), 250);
  }
  function runNow(keepStep) {
    save();
    state.result = E.run(state.blocks);
    const n = state.result.steps.length;
    if (!keepStep) state.stepIndex = Math.max(0, n - 1);
    state.stepIndex = Math.min(state.stepIndex, Math.max(0, n - 1));
    renderBlockStatus();
    renderViewer();
  }

  // ---------- редактор ----------
  function renderEditor() {
    const root = $('editor');
    root.replaceChildren(renderList(state.blocks, true));
    const count = countBlocks(state.blocks);
    $('block-count').textContent = count + ' ' + plural(count, 'блок', 'блока', 'блоков');
    renderBlockStatus();
  }
  function countBlocks(list) {
    return list.reduce((s, b) => s + 1 + (b.type === 'branch' ? countBlocks(b.yes || []) + countBlocks(b.no || []) : 0), 0);
  }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
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
        if (!top && type === 'input') continue;
        menu.append(el('button', {
          type: 'button', role: 'menuitem', class: 't-' + type,
          onclick: () => { close(); list.push(E.createBlock(type)); renderEditor(); runNow(false); },
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
      if (e.target.closest('input,textarea,select,button')) return;
      e.stopPropagation();
      jumpToBlock(b.id);
    });

    const onChange = (key, parse) => e => {
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      b[key] = parse ? parse(v) : v;
      scheduleRun(true);
    };

    const head = el('div', { class: 'block-head' },
      el('span', { class: 'type-tag', text: info.title }),
      el('input', {
        class: 'block-label', value: b.label || '', placeholder: 'название (необязательно)',
        'aria-label': 'Название блока', oninput: onChange('label'),
      }),
      el('div', { class: 'block-tools' },
        iconBtn('up', 'Выше', index === 0, () => { swap(list, index, index - 1); }),
        iconBtn('down', 'Ниже', index === list.length - 1, () => { swap(list, index, index + 1); }),
        iconBtn('copy', 'Дублировать', false, () => {
          list.splice(index + 1, 0, reassignIds(JSON.parse(JSON.stringify(b))));
          renderEditor(); runNow(true);
        }),
        iconBtn('del', 'Удалить', false, () => { list.splice(index, 1); renderEditor(); runNow(true); }, 'danger'),
      ),
    );
    card.append(head);

    const exprField = (kw, placeholder) => el('label', { class: 'field' },
      el('span', { class: 'kw', text: kw }),
      el('input', {
        class: 'expr', value: b.expr || '', placeholder, spellcheck: 'false', autocomplete: 'off',
        'aria-label': kw, oninput: onChange('expr'),
      }));

    switch (b.type) {
      case 'input':
        card.append(el('label', { class: 'field' },
          el('textarea', {
            spellcheck: 'false', rows: String(Math.min(8, Math.max(2, String(b.data).split('\n').length))),
            'aria-label': 'Входные данные', oninput: onChange('data'),
          }, b.data || ''),
        ));
        card.append(el('div', { class: 'block-msg', text: 'JSON-массив, например [1, 2, 3] или [{"name":"Аня"}], либо значения через запятую' }));
        break;
      case 'filter': card.append(exprField('оставить, если', 'x > 0')); break;
      case 'map': card.append(exprField('x →', 'x * 2')); break;
      case 'assert': {
        card.append(exprField('для всех верно', 'x >= 0'));
        card.append(el('label', { class: 'check' },
          el('input', { type: 'checkbox', checked: b.stopOnFail ? true : null, onchange: onChange('stopOnFail') }),
          'остановить алгоритм, если нарушено'));
        break;
      }
      case 'sort': {
        const sel = el('select', { 'aria-label': 'Порядок', onchange: onChange('order') },
          el('option', { value: 'asc', selected: b.order !== 'desc' ? true : null, text: 'по возрастанию' }),
          el('option', { value: 'desc', selected: b.order === 'desc' ? true : null, text: 'по убыванию' }));
        card.append(el('div', { class: 'field' },
          el('span', { class: 'kw', text: 'ключ' }),
          el('input', { class: 'expr', value: b.expr || '', spellcheck: 'false', 'aria-label': 'Ключ сортировки', oninput: onChange('expr') }),
          sel));
        break;
      }
      case 'reduce':
        card.append(el('div', { class: 'field' },
          el('span', { class: 'kw', text: 'acc =' }),
          el('input', { class: 'small-input', value: b.init == null ? '' : b.init, spellcheck: 'false', 'aria-label': 'Начальное значение', oninput: onChange('init') }),
          el('span', { class: 'kw', text: 'затем acc =' }),
          el('input', { class: 'expr', value: b.expr || '', spellcheck: 'false', 'aria-label': 'Выражение свёртки', oninput: onChange('expr') })));
        break;
      case 'branch': {
        card.append(exprField('если', 'x > 0'));
        b.yes = b.yes || []; b.no = b.no || [];
        const col = (cls, title, sub) => el('div', { class: 'branch-col ' + cls },
          el('h3', { text: title }),
          sub.length === 0 ? el('p', { class: 'empty', text: 'Пусто — элементы проходят без изменений' }) : null,
          renderList(sub, false));
        card.append(el('div', { class: 'branches' }, col('yes', 'Да', b.yes), col('no', 'Нет', b.no)));
        break;
      }
    }
    card.append(el('div', { class: 'block-msg', 'data-msg': '' }));
    return card;
  }

  function iconBtn(icon, title, disabled, onclick, extra) {
    return el('button', {
      type: 'button', class: 'icon-btn ' + (extra || ''), title, 'aria-label': title,
      disabled: disabled ? true : null, html: ICONS[icon], onclick,
    });
  }
  function swap(list, a, b) {
    [list[a], list[b]] = [list[b], list[a]];
    renderEditor(); runNow(true);
  }

  /** Показать на блоках итог: ошибка, нарушенное утверждение, текущий шаг. */
  function renderBlockStatus() {
    const r = state.result;
    document.querySelectorAll('.block').forEach(card => {
      card.classList.remove('has-error', 'has-fail', 'active');
      const msg = card.querySelector(':scope > [data-msg]');
      if (msg) { msg.textContent = ''; msg.className = 'block-msg'; }
    });
    if (!r) return;
    for (const s of r.steps) {
      if (s.status === 'ok' || s.type === 'merge') continue;
      const card = document.querySelector('.block[data-id="' + s.blockId + '"]');
      if (!card) continue;
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
    if (idx >= 0) setStep(idx);
  }

  // ---------- просмотр шагов ----------
  function setStep(i) {
    const n = state.result ? state.result.steps.length : 0;
    state.stepIndex = Math.max(0, Math.min(i, n - 1));
    renderBlockStatus();
    renderViewer();
    const cur = state.result && state.result.steps[state.stepIndex];
    if (cur) {
      const card = document.querySelector('.block[data-id="' + cur.blockId + '"]');
      if (card && state.playing && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function renderViewer() {
    const r = state.result;
    const steps = r ? r.steps : [];
    const n = steps.length;

    // итог
    const sum = $('summary');
    let pill;
    if (!r || n === 0) pill = el('span', { class: 'pill ok', text: 'нет шагов' });
    else if (r.error) pill = el('span', { class: 'pill error', text: 'ошибка' });
    else if (!r.ok) pill = el('span', { class: 'pill fail', text: 'утверждение нарушено' });
    else pill = el('span', { class: 'pill ok', text: 'успешно' });
    sum.replaceChildren(pill,
      el('span', { class: 'out' }, r && r.error ? r.error : 'Результат: ' + fmt(r ? r.output : [], 160)));

    // плеер
    const scrub = $('scrub');
    scrub.max = String(Math.max(0, n - 1));
    scrub.value = String(state.stepIndex);
    scrub.disabled = n <= 1;
    $('counter').textContent = n ? (state.stepIndex + 1) + ' / ' + n : '0 / 0';
    $('btn-first').disabled = $('btn-prev').disabled = state.stepIndex <= 0;
    $('btn-next').disabled = state.stepIndex >= n - 1;
    $('btn-play').textContent = state.playing ? '❚❚ Пауза' : '▶ Пуск';

    // шаг
    $('step').replaceChildren(...renderStep(steps[state.stepIndex]));

    // список шагов
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

  function chips(values, marks, opts) {
    opts = opts || {};
    if (!values || values.length === 0) return el('div', { class: 'chips' }, el('span', { class: 'none', text: 'пусто' }));
    const byIndex = new Map((marks || []).map(m => [m.index, m]));
    return el('div', { class: 'chips' }, values.map((v, i) => {
      const m = opts.noMarks ? null : byIndex.get(i);
      return el('span', { class: 'chip ' + (m ? m.status : ''), title: JSON.stringify(v) },
        el('span', { class: 'idx', text: String(i) }), fmt(v));
    }));
  }
  function row(label, content, cls) {
    return el('div', { class: 'data-row ' + (cls || '') }, el('span', { class: 'lbl', text: label }), content);
  }
  function legend(items) {
    const colors = {
      kept: ['--ok-soft', '--ok'], dropped: ['--bad-soft', '--bad'], pass: ['--ok-soft', '--ok'],
      fail: ['--bad-soft', '--bad'], yes: ['--yes-soft', '--yes'], no: ['--no-soft', '--no'],
    };
    return el('div', { class: 'legend' }, items.map(([k, text]) => el('span', {},
      el('i', { style: 'background:var(' + colors[k][0] + ');border-color:var(' + colors[k][1] + ')' }), text)));
  }

  function renderStep(s) {
    if (!s) {
      return [el('p', { class: 'step-msg', text: 'Добавьте блок «Входные данные», чтобы начать.' })];
    }
    const out = [];
    out.push(el('div', { class: 'step-title' },
      el('strong', { text: s.title }),
      s.path ? el('span', { class: 'crumb', text: 'ветка: ' + s.path }) : null,
      s.status !== 'ok' ? el('span', { class: 'pill ' + s.status, text: s.status === 'error' ? 'ошибка' : 'нарушено' }) : null));
    out.push(el('p', { class: 'step-msg ' + s.status, text: s.message }));

    switch (s.type) {
      case 'input':
        if (s.after) out.push(row('Данные', chips(s.after, null)));
        break;
      case 'filter':
        out.push(row('До фильтра', chips(s.before, s.marks)));
        if (s.after) out.push(row('После', chips(s.after, null)));
        out.push(legend([['kept', 'проходит'], ['dropped', 'отброшен']]));
        break;
      case 'assert':
        out.push(row('Проверка', chips(s.before, s.marks)));
        out.push(legend([['pass', 'верно'], ['fail', 'нарушено']]));
        break;
      case 'map':
        if (s.marks.length) out.push(tableOf(['#', 'было', '', 'стало'], s.marks.map(m => [m.index, fmt(m.from, 60), '→', fmt(m.to, 60)])));
        else out.push(row('До', chips(s.before, null)));
        break;
      case 'sort':
        out.push(row('До', chips(s.before, null)));
        if (s.after) out.push(row('После', chips(s.after, null)));
        break;
      case 'reduce':
        if (s.marks.length) {
          out.push(tableOf(['#', 'элемент', 'acc было', '', 'acc стало'],
            s.marks.map(m => [m.index, fmt(s.before[m.index], 40), fmt(m.from, 40), '→', fmt(m.to, 40)])));
        } else out.push(row('До', chips(s.before, null)));
        break;
      case 'branch':
        out.push(row('Вход', chips(s.before, s.marks)));
        if (s.split) {
          out.push(el('div', { class: 'split' },
            row('Да', chips(s.split.yes, null), 'yes-box'),
            row('Нет', chips(s.split.no, null), 'no-box')));
        }
        out.push(legend([['yes', 'условие верно'], ['no', 'условие ложно']]));
        break;
      case 'merge':
        if (s.split) {
          out.push(el('div', { class: 'split' },
            row('Из ветки «да»', chips(s.split.yes, null), 'yes-box'),
            row('Из ветки «нет»', chips(s.split.no, null), 'no-box')));
        }
        out.push(row('После слияния', chips(s.after, s.marks)));
        break;
      default:
        out.push(row('До', chips(s.before, null)));
    }
    if (s.status === 'error') out.push(row('Данные на входе блока', chips(s.before, null)));
    return out;
  }

  function tableOf(headers, rows) {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'trace-table' },
      el('thead', {}, el('tr', {}, headers.map(h => el('th', { text: h })))),
      el('tbody', {}, rows.map(r => el('tr', {}, r.map((c, i) => el('td', { class: c === '→' ? 'arrow' : null, text: String(c) })))))));
  }

  // ---------- проигрывание ----------
  function play() {
    const n = state.result ? state.result.steps.length : 0;
    if (n === 0) return;
    if (state.stepIndex >= n - 1) setStep(0);
    state.playing = true;
    renderViewer();
    state.timer = setInterval(() => {
      const total = state.result.steps.length;
      if (state.stepIndex >= total - 1) { stop(); return; }
      setStep(state.stepIndex + 1);
    }, 1100);
  }
  function stop() {
    state.playing = false;
    clearInterval(state.timer);
    state.timer = null;
    renderViewer();
  }

  // ---------- импорт / экспорт ----------
  function openIO() {
    $('io-text').value = JSON.stringify(state.blocks, null, 2);
    setNote('Скопируйте, чтобы сохранить, или вставьте свою схему и нажмите «Загрузить».');
    $('modal').hidden = false;
    $('io-text').focus();
  }
  function setNote(text, err) {
    const n = $('io-note'); n.textContent = text; n.className = 'note' + (err ? ' err' : '');
  }

  // ---------- старт ----------
  function init() {
    const sel = $('preset');
    sel.append(el('option', { value: '', text: 'Примеры…' }));
    for (const [k, p] of Object.entries(PRESETS)) sel.append(el('option', { value: k, text: p.title }));
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      stop();
      state.blocks = PRESETS[sel.value].make();
      sel.value = '';
      renderEditor(); runNow(false);
    });

    $('btn-new').addEventListener('click', () => {
      stop();
      state.blocks = [E.createBlock('input', { data: '[1, 2, 3]' })];
      renderEditor(); runNow(false);
    });
    $('btn-io').addEventListener('click', openIO);
    $('io-close').addEventListener('click', () => { $('modal').hidden = true; });
    $('modal').addEventListener('click', e => { if (e.target === $('modal')) $('modal').hidden = true; });
    $('io-copy').addEventListener('click', () => {
      const text = $('io-text').value;
      const fallback = () => { $('io-text').select(); setNote('Текст выделен — нажмите Cmd+C / Ctrl+C.'); };
      try {
        navigator.clipboard.writeText(text).then(() => setNote('Скопировано.'), fallback);
      } catch (_) { fallback(); }
    });
    $('io-load').addEventListener('click', () => {
      let blocks;
      try { blocks = JSON.parse($('io-text').value); } catch (e) { setNote('Это не JSON: ' + e.message, true); return; }
      const errs = E.validate(blocks);
      if (errs.length) { setNote('Схема не подходит: ' + errs.slice(0, 3).join('; '), true); return; }
      stop();
      state.blocks = blocks;
      $('modal').hidden = true;
      renderEditor(); runNow(false);
    });

    $('btn-first').addEventListener('click', () => { stop(); setStep(0); });
    $('btn-prev').addEventListener('click', () => { stop(); setStep(state.stepIndex - 1); });
    $('btn-next').addEventListener('click', () => { stop(); setStep(state.stepIndex + 1); });
    $('btn-play').addEventListener('click', () => (state.playing ? stop() : play()));
    $('scrub').addEventListener('input', e => { stop(); setStep(Number(e.target.value)); });

    document.addEventListener('keydown', e => {
      if (e.target.closest('input,textarea,select') || !$('modal').hidden) {
        if (e.key === 'Escape') $('modal').hidden = true;
        return;
      }
      if (e.key === 'ArrowRight') { stop(); setStep(state.stepIndex + 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { stop(); setStep(state.stepIndex - 1); e.preventDefault(); }
      else if (e.key === ' ') { state.playing ? stop() : play(); e.preventDefault(); }
    });

    state.blocks = load();
    renderEditor();
    runNow(false);
    setStep(0);
  }

  init();
})();
