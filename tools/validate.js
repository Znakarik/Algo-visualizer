#!/usr/bin/env node
/*
 * Проверка файлов алгоритмов (.algo.json) тем же движком, что и в конструкторе.
 *
 *   node tools/validate.js algorithms/*.algo.json
 *   node tools/validate.js --today 2026-10-22 --trace algorithms/podbor-kart.algo.json
 *
 * Что проверяется:
 *   ОШИБКИ (код выхода 1):
 *     - файл не JSON или схема не проходит validate();
 *     - первым блоком не идёт «Входные данные», или их несколько;
 *     - правило ссылается на несуществующий параметр;
 *     - неизвестная операция, вид операнда, take, тип параметра;
 *     - алгоритм падает при выполнении на своих тестовых данных.
 *   ПРЕДУПРЕЖДЕНИЯ:
 *     - правило ссылается на поле, которого нет ни в одном элементе тестовых данных;
 *     - правило ни разу не было верным или ни разу ложным во всех запусках
 *       (тестовые данные + сценарии не покрывают обе стороны условия);
 *   Сценарии (необязательное поле "scenarios" в файле) — запуски с другими
 *   значениями параметров и ожидаемым результатом:
 *     { "name": "...", "params": {"creditAllowed": true}, "expect": ["id1", "id2"], "expectBy": "id", "today": "2026-10-22" }
 *   Несовпадение с expect — ОШИБКА.
 *     - нарушено утверждение;
 *     - условие задано кодом, а не правилами;
 *     - у блока нет label; у блока нет source, если у файла указан source
 *       (алгоритм собран из кода).
 *
 * Флаги:
 *   --today YYYY-MM-DD  дата «сегодня» для условий со сроком действия
 *   --trace             напечатать все шаги выполнения
 *   --json              вывести результат проверки в JSON (для агентов)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require(path.join(__dirname, '..', 'engine.js'));

const args = process.argv.slice(2);
const opts = { today: null, trace: false, json: false, files: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--today') opts.today = args[++i];
  else if (a === '--trace') opts.trace = true;
  else if (a === '--json') opts.json = true;
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
  else opts.files.push(a);
}
if (!opts.files.length) {
  console.error('Укажите файлы: node tools/validate.js algorithms/*.algo.json');
  process.exit(2);
}

const TAKES = new Set(['all', 'first', undefined]);
const KINDS_LEFT = new Set(['field', 'param']);
const KINDS_RIGHT = new Set(['const', 'param', 'field', 'today']);

function walk(blocks, fn, where) {
  blocks.forEach((b, i) => {
    const at = (where ? where + ' › ' : '') + '#' + i + ' ' + (b.label || E.BLOCK_TYPES[b.type]?.title || b.type);
    fn(b, at);
    if (b.type === 'branch') {
      walk(b.yes || [], fn, at + ' › да');
      walk(b.no || [], fn, at + ' › нет');
    }
  });
}

function checkFile(file) {
  const errors = [];
  const warnings = [];
  let algo;
  try {
    algo = E.deserialize(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, errors: [e.message], warnings, output: null };
  }
  const { blocks } = algo;

  // входные данные
  const inputs = [];
  walk(blocks, (b, at) => { if (b.type === 'input') inputs.push(at); });
  if (!blocks.length || blocks[0].type !== 'input') errors.push('Первым блоком должны быть «Входные данные» (type: "input")');
  if (inputs.length > 1) errors.push('Блок «Входные данные» должен быть один, найдено: ' + inputs.join(', '));

  const input = blocks[0] && blocks[0].type === 'input' ? blocks[0] : null;
  const params = new Map();
  if (input) {
    for (const p of input.params || []) {
      if (!p.name) errors.push('Параметр без имени');
      else if (!/^[A-Za-z_$][\w$]*$/.test(p.name)) errors.push('Имя параметра «' + p.name + '» должно быть идентификатором (латиница, цифры, _)');
      if (!E.PARAM_TYPES[p.type]) errors.push('Параметр «' + p.name + '»: неизвестный тип «' + p.type + '» (можно: ' + Object.keys(E.PARAM_TYPES).join(', ') + ')');
      if (params.has(p.name)) errors.push('Параметр «' + p.name + '» объявлен дважды');
      params.set(p.name, p);
    }
  }
  let items = [];
  try { items = input ? E.parseInput(input.data) : []; } catch (e) { errors.push(e.message); }
  if (input && !items.length) warnings.push('Нет тестовых данных: алгоритм нечем проверить');
  const fields = new Set(E.fieldsOf(items).map(f => f.name));

  // блоки и правила
  const ids = new Set();
  walk(blocks, (b, at) => {
    if (ids.has(b.id)) errors.push(at + ': повторяется id «' + b.id + '»');
    ids.add(b.id);
    if (b.type !== 'input' && !b.label) warnings.push(at + ': нет label (понятного названия)');
    if (b.type !== 'input' && !b.source && algo.extra.source) warnings.push(at + ': нет source (где это в исходном коде)');
    if ((b.type === 'filter' || b.type === 'branch') && !TAKES.has(b.take)) errors.push(at + ': take должен быть "all" или "first"');
    if (!E.BLOCK_TYPES[b.type] || !E.BLOCK_TYPES[b.type].hasCond) return;
    if (b.condMode === 'code') { warnings.push(at + ': условие задано кодом (' + b.expr + '), его нельзя накликивать'); return; }
    (b.cond.rules || []).forEach((r, k) => {
      const rt = at + ', правило ' + (k + 1);
      if (!r.left || !KINDS_LEFT.has(r.left.kind)) { errors.push(rt + ': left.kind должен быть "field" или "param"'); return; }
      if (!E.OPS[r.op]) { errors.push(rt + ': неизвестная операция «' + r.op + '» (можно: ' + Object.keys(E.OPS).join(', ') + ')'); return; }
      const sides = [r.left];
      if (!E.OPS[r.op].unary) {
        if (!r.right || !KINDS_RIGHT.has(r.right.kind)) { errors.push(rt + ': right.kind должен быть const, param, field или today'); return; }
        sides.push(r.right);
      }
      for (const o of sides) {
        if (o.kind === 'param' && !params.has(o.name)) errors.push(rt + ': нет параметра «' + o.name + '»');
        if (o.kind === 'field' && items.length && !fields.has(o.name)) warnings.push(rt + ': поля «' + o.name + '» нет в тестовых данных');
      }
    });
    if (b.cond.join && b.cond.join !== 'and' && b.cond.join !== 'or') errors.push(at + ': cond.join должен быть "and" или "or"');
  });

  // выполнение: базовый запуск + каждый сценарий
  const scenarios = [{ name: 'тестовые данные как есть', params: null }].concat(
    Array.isArray(algo.extra.scenarios) ? algo.extra.scenarios : []);
  if (algo.extra.scenarios !== undefined && !Array.isArray(algo.extra.scenarios)) errors.push('scenarios должен быть списком');
  const coverage = new Map(); // блок+правило → {label, title, seenTrue, seenFalse}
  const scenarioResults = [];
  let base = null;
  scenarios.forEach((sc, n) => {
    const tag = n === 0 ? '' : 'Сценарий «' + (sc.name || n) + '»: ';
    let runBlocks;
    try { runBlocks = E.withParams(blocks, sc.params); } catch (e) { errors.push(tag + e.message); return; }
    const today = sc.today || opts.today;
    const result = E.run(runBlocks, today ? { today } : undefined);
    if (n === 0) base = result;
    if (result.error) errors.push(tag + 'ошибка при выполнении: ' + result.error);
    for (const s of result.steps) {
      if (s.status === 'fail') warnings.push(tag + 'утверждение «' + s.title + '»: ' + s.message);
      if (!s.ruleLabels) continue;
      s.ruleLabels.forEach((label, k) => {
        const key = s.blockId + '#' + k;
        const c = coverage.get(key) || { label, title: s.title, seenTrue: false, seenFalse: false };
        for (const m of s.marks) { if (m.rules && m.rules[k]) c.seenTrue = true; else if (m.rules) c.seenFalse = true; }
        coverage.set(key, c);
      });
    }
    if (n > 0 && sc.expect !== undefined) {
      const by = sc.expectBy || 'id';
      const got = result.output.map(v => (v && typeof v === 'object' && by in v ? v[by] : v));
      const ok = JSON.stringify(got) === JSON.stringify(sc.expect);
      if (!ok) errors.push(tag + 'ожидалось ' + JSON.stringify(sc.expect) + ', получилось ' + JSON.stringify(got) + ' (сравнение по полю «' + by + '»)');
    }
    if (n > 0) scenarioResults.push({ name: sc.name || String(n), output: result.output, error: result.error || null });
  });
  for (const c of coverage.values()) {
    if (!c.seenFalse) warnings.push('«' + c.title + '», правило «' + c.label + '» ни разу не было ложным: добавьте тестовые данные или сценарий, где оно ложно');
    if (!c.seenTrue) warnings.push('«' + c.title + '», правило «' + c.label + '» ни разу не было верным: добавьте тестовые данные или сценарий, где оно верно');
  }
  const result = base || { output: null, steps: [], today: opts.today };
  return { file, name: algo.name, errors, warnings, output: result.output, steps: result.steps, today: result.today, scenarios: scenarioResults };
}

let failed = false;
const reports = opts.files.map(checkFile);
if (opts.json) {
  console.log(JSON.stringify(reports.map(r => ({ file: r.file, name: r.name, errors: r.errors, warnings: r.warnings, output: r.output, scenarios: r.scenarios })), null, 2));
  failed = reports.some(r => r.errors.length);
} else {
  for (const r of reports) {
    const mark = r.errors.length ? 'ОШИБКИ' : r.warnings.length ? 'есть предупреждения' : 'ok';
    console.log('\n' + r.file + (r.name ? '  «' + r.name + '»' : '') + ': ' + mark);
    r.errors.forEach(e => console.log('  ✗ ' + e));
    r.warnings.forEach(w => console.log('  ! ' + w));
    if (opts.trace && r.steps) {
      console.log('  Шаги (сегодня = ' + r.today + '):');
      r.steps.forEach((s, i) => console.log('    ' + String(i + 1).padStart(2) + '. ' + '  '.repeat(s.depth) + s.title + (s.path ? ' [' + s.path + ']' : '') + ': ' + s.message));
    }
    if (r.output) {
      const lf = r.output.length && r.output[0] && typeof r.output[0] === 'object' ? ['name', 'title', 'id'].find(k => k in r.output[0]) : null;
      console.log('  Результат (' + r.output.length + '): ' + r.output.map(v => (lf ? v[lf] : JSON.stringify(v))).join(', '));
    }
    for (const sc of r.scenarios || []) {
      const out = sc.output || [];
      const lf = out.length && out[0] && typeof out[0] === 'object' ? ['name', 'title', 'id'].find(k => k in out[0]) : null;
      console.log('  Сценарий «' + sc.name + '» (' + out.length + '): ' + (sc.error ? 'ошибка: ' + sc.error : out.map(v => (lf ? v[lf] : JSON.stringify(v))).join(', ')));
    }
    if (r.errors.length) failed = true;
  }
}
process.exit(failed ? 1 : 0);
