/*
 * Движок конструктора алгоритмов.
 *
 * Алгоритм — это список блоков. Первый блок «Входные данные» задаёт:
 *   - параметры (флаги, числа, строки, даты), например «кредитные разрешены»;
 *   - массив элементов (например, карты с полями баланс, срок действия, тип).
 * Дальше каждый блок получает массив, что-то с ним делает и передаёт дальше.
 * Каждое действие записывается в «трассу» (steps) — по ней интерфейс
 * показывает промежуточные результаты.
 *
 * Типы блоков:
 *   input   — входные данные: параметры + массив
 *   filter  — оставить элементы, для которых условие верно
 *   branch  — разделить по условию на ветки «да» и «нет», у каждой свои блоки;
 *             потом ветки сливаются (сначала «да», затем «нет»)
 *   assert  — утверждение: условие должно быть верно для каждого элемента
 *   map     — преобразовать каждый элемент (выражение JS)
 *   sort    — отсортировать по ключу
 *   reduce  — свернуть массив в одно значение
 *
 * Условие (у filter, branch, assert) задаётся одним из двух способов:
 *   1) правилами, которые накликиваются в интерфейсе:
 *        cond = { join: 'and' | 'or', rules: [ { left, op, right } ] }
 *        left  = { kind: 'field' | 'param', name: 'balance' }
 *        right = { kind: 'const' | 'param' | 'field' | 'today', value: '5000' }
 *   2) выражением JS (condMode = 'code', поле expr).
 *
 * В выражениях доступны: x — элемент, i — индекс, data — весь массив,
 * p — параметры, acc — накопитель (в свёртке).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AlgoEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BLOCK_TYPES = {
    input:  { title: 'Входные данные', hasCond: false, hasExpr: false },
    filter: { title: 'Фильтр',         hasCond: true,  hasExpr: false },
    branch: { title: 'Ветвление',      hasCond: true,  hasExpr: false },
    assert: { title: 'Утверждение',    hasCond: true,  hasExpr: false },
    map:    { title: 'Преобразование', hasCond: false, hasExpr: true  },
    sort:   { title: 'Сортировка',     hasCond: false, hasExpr: true  },
    reduce: { title: 'Свёртка',        hasCond: false, hasExpr: true  },
  };

  const OPS = {
    eq:       { label: '=',          unary: false },
    ne:       { label: '≠',          unary: false },
    gt:       { label: '>',          unary: false },
    gte:      { label: '≥',          unary: false },
    lt:       { label: '<',          unary: false },
    lte:      { label: '≤',          unary: false },
    contains: { label: 'содержит',   unary: false },
    isTrue:   { label: 'да (true)',  unary: true  },
    isFalse:  { label: 'нет (false)', unary: true },
    isEmpty:  { label: 'не задано',  unary: true  },
    notEmpty: { label: 'задано',     unary: true  },
  };

  const PARAM_TYPES = {
    boolean: 'да/нет',
    number: 'число',
    string: 'строка',
    date: 'дата',
  };

  class AlgoError extends Error {}

  // ---------- выражения JS ----------
  const fnCache = new Map();
  function compile(expr, params) {
    const key = params.join(',') + '|' + expr;
    if (fnCache.has(key)) return fnCache.get(key);
    if (typeof expr !== 'string' || expr.trim() === '') {
      throw new AlgoError('Пустое выражение');
    }
    let fn;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function(...params, '"use strict"; return (' + expr + ');');
    } catch (e) {
      throw new AlgoError('Ошибка в выражении «' + expr + '»: ' + e.message);
    }
    fnCache.set(key, fn);
    return fn;
  }
  function evaluate(expr, params, args) {
    const fn = compile(expr, params);
    try {
      return fn(...args);
    } catch (e) {
      throw new AlgoError('Ошибка при вычислении «' + expr + '»: ' + e.message);
    }
  }

  function clone(v) {
    if (v === undefined) return undefined;
    return JSON.parse(JSON.stringify(v));
  }

  // ---------- разбор входных данных ----------
  /** JSON-массив, одно JSON-значение или список через запятую. */
  function parseInput(text) {
    if (Array.isArray(text)) return clone(text);
    const s = String(text == null ? '' : text).trim();
    if (s === '') return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [v];
    } catch (_) {
      if (/^[[{]/.test(s)) throw new AlgoError('Входные данные — неверный JSON: проверьте скобки, кавычки и запятые');
      return s.split(/[,;\n]/).map(t => t.trim()).filter(t => t !== '').map(t => {
        const n = Number(t);
        return Number.isFinite(n) ? n : t;
      });
    }
  }

  /** Привести значение параметра к его типу. */
  function castParam(type, value) {
    switch (type) {
      case 'boolean':
        if (typeof value === 'boolean') return value;
        return value === 'true' || value === 1 || value === '1';
      case 'number': {
        if (value === '' || value == null) return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      }
      case 'date':
      case 'string':
      default:
        return value == null ? '' : String(value);
    }
  }

  /** Список параметров [{name, type, value}] → объект {name: value}. */
  function paramsObject(list) {
    const out = {};
    for (const p of list || []) {
      if (!p || !p.name) continue;
      out[p.name] = castParam(p.type, p.value);
    }
    return out;
  }

  /** Строка из поля «значение» в правиле → число, true/false или строка. */
  function parseConst(raw) {
    if (typeof raw !== 'string') return raw;
    const s = raw.trim();
    if (s === '') return '';
    if (s === 'true' || s === 'да') return true;
    if (s === 'false' || s === 'нет') return false;
    if (s === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    const q = s.match(/^"(.*)"$|^'(.*)'$/);
    if (q) return q[1] !== undefined ? q[1] : q[2];
    return s;
  }

  // ---------- даты и сравнение ----------
  function todayKey(d) {
    const t = d ? new Date(d) : new Date();
    const pad = n => String(n).padStart(2, '0');
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  }

  function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  /**
   * Строка с датой → ключ ГГГГ-ММ-ДД для сравнения, иначе null.
   * Понимает: 2027-03-15, 2027-03 (конец месяца), 03/27 (как на карте — конец месяца),
   * 15.03.2027.
   */
  function dateKey(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return m[1] + '-' + m[2] + '-' + m[3];
    if ((m = s.match(/^(\d{4})-(\d{2})$/))) return m[1] + '-' + m[2] + '-' + String(lastDay(+m[1], +m[2])).padStart(2, '0');
    if ((m = s.match(/^(\d{2})\/(\d{2})$/))) {
      const y = 2000 + Number(m[2]);
      return y + '-' + m[1] + '-' + String(lastDay(y, +m[1])).padStart(2, '0');
    }
    if ((m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/))) return m[3] + '-' + m[2] + '-' + m[1];
    return null;
  }

  function isNumLike(v) {
    return typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()));
  }

  /** Сравнить два значения: числа как числа, даты как даты, остальное как строки. */
  function compare(a, b) {
    if (isNumLike(a) && isNumLike(b)) return Number(a) - Number(b);
    const da = dateKey(a), db = dateKey(b);
    if (da && db) return da < db ? -1 : da > db ? 1 : 0;
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      return (a === b) ? 0 : NaN;
    }
    if (a == null || b == null) return NaN;
    const sa = String(a), sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  function equals(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      const ta = typeof a === 'boolean' ? a : a === 'true' ? true : a === 'false' ? false : a;
      const tb = typeof b === 'boolean' ? b : b === 'true' ? true : b === 'false' ? false : b;
      return ta === tb;
    }
    return compare(a, b) === 0;
  }

  /** Достать поле по пути «a.b.c». */
  function getPath(obj, path) {
    if (path === '' || path == null || path === '.') return obj;
    let cur = obj;
    for (const part of String(path).split('.')) {
      if (cur == null) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  // ---------- правила ----------
  function operandValue(operand, x, params, today) {
    if (!operand) return undefined;
    switch (operand.kind) {
      case 'field': return getPath(x, operand.name != null ? operand.name : operand.value);
      case 'param': {
        const name = operand.name != null ? operand.name : operand.value;
        if (!(name in params)) throw new AlgoError('Нет параметра «' + name + '»');
        return params[name];
      }
      case 'today': return today;
      case 'const':
      default: return parseConst(operand.value);
    }
  }

  function applyOp(op, a, b) {
    switch (op) {
      case 'eq': return equals(a, b);
      case 'ne': return !equals(a, b);
      case 'gt': return compare(a, b) > 0;
      case 'gte': return compare(a, b) >= 0;
      case 'lt': return compare(a, b) < 0;
      case 'lte': return compare(a, b) <= 0;
      case 'contains':
        if (Array.isArray(a)) return a.some(v => equals(v, b));
        return a != null && String(a).toLowerCase().includes(String(b).toLowerCase());
      case 'isTrue': return a === true || a === 'true';
      case 'isFalse': return a === false || a === 'false' || a == null;
      case 'isEmpty': return a == null || a === '' || (Array.isArray(a) && a.length === 0);
      case 'notEmpty': return !(a == null || a === '' || (Array.isArray(a) && a.length === 0));
      default: throw new AlgoError('Неизвестная операция «' + op + '»');
    }
  }

  function evalRule(rule, x, params, today) {
    if (!rule || !rule.left || !(rule.left.name || rule.left.value)) {
      throw new AlgoError('В правиле не выбрано, что проверять');
    }
    if (!OPS[rule.op]) throw new AlgoError('Неизвестная операция «' + rule.op + '»');
    const a = operandValue(rule.left, x, params, today);
    const b = OPS[rule.op].unary ? undefined : operandValue(rule.right, x, params, today);
    return { ok: applyOp(rule.op, a, b), left: a, right: b };
  }

  /** Проверить условие из правил. Возвращает {ok, rules: [true/false...]}. */
  function evalCond(cond, x, params, today) {
    const rules = (cond && cond.rules) || [];
    if (rules.length === 0) return { ok: true, rules: [] };
    const results = rules.map(r => evalRule(r, x, params, today).ok);
    const ok = cond.join === 'or' ? results.some(Boolean) : results.every(Boolean);
    return { ok, rules: results };
  }

  function operandText(o) {
    if (!o) return '?';
    switch (o.kind) {
      case 'field': return o.name || o.value || '?';
      case 'param': return 'параметр ' + (o.name || o.value || '?');
      case 'today': return 'сегодня';
      default: {
        const v = parseConst(o.value);
        return typeof v === 'string' ? '«' + v + '»' : String(v);
      }
    }
  }
  function ruleText(rule) {
    const op = OPS[rule.op] || { label: rule.op, unary: false };
    return operandText(rule.left) + ' ' + op.label + (op.unary ? '' : ' ' + operandText(rule.right));
  }
  function condText(block) {
    if (usesCode(block)) return block.expr || '';
    const rules = (block.cond && block.cond.rules) || [];
    if (!rules.length) return 'всегда';
    return rules.map(ruleText).join(block.cond.join === 'or' ? ' ИЛИ ' : ' И ');
  }

  function usesCode(block) {
    return block.condMode === 'code' || (!block.cond && typeof block.expr === 'string');
  }

  /** Проверить условие блока для элемента. */
  function checkBlock(block, x, i, data, ctx) {
    if (usesCode(block)) {
      return { ok: Boolean(evaluate(block.expr, ['x', 'i', 'data', 'p'], [x, i, data, ctx.params])), rules: null };
    }
    return evalCond(block.cond, x, ctx.params, ctx.today);
  }

  // ---------- блоки ----------
  let uid = 0;
  function newId(prefix) {
    uid += 1;
    return (prefix || 'b') + Date.now().toString(36) + uid.toString(36);
  }

  function rule(leftKind, leftName, op, rightKind, rightValue) {
    const r = { left: { kind: leftKind, name: leftName }, op };
    if (!OPS[op] || !OPS[op].unary) {
      r.right = rightKind === 'param' || rightKind === 'field'
        ? { kind: rightKind, name: rightValue }
        : { kind: rightKind || 'const', value: rightValue == null ? '' : String(rightValue) };
    } else {
      r.right = { kind: 'const', value: '' };
    }
    return r;
  }

  function createBlock(type, overrides) {
    const emptyCond = () => ({ join: 'and', rules: [] });
    const defaults = {
      input:  { params: [], data: '[]' },
      filter: { cond: emptyCond() },
      branch: { cond: emptyCond(), yes: [], no: [] },
      assert: { cond: emptyCond(), stopOnFail: false },
      map:    { expr: 'x' },
      sort:   { expr: 'x', order: 'asc' },
      reduce: { expr: 'acc + x', init: '0' },
    };
    if (!BLOCK_TYPES[type]) throw new AlgoError('Неизвестный тип блока: ' + type);
    return Object.assign({ id: newId(type[0]), type, label: '' }, clone(defaults[type]), overrides || {});
  }

  // ---------- выполнение ----------
  /**
   * @param {Array} blocks
   * @param {Object} [options] { maxSteps, today: 'YYYY-MM-DD' }
   * @returns {{ok, output, params, steps, error}}
   */
  function run(blocks, options) {
    const opts = Object.assign({ maxSteps: 5000 }, options || {});
    const ctx = {
      steps: [], opts, stopped: false, error: null, failed: false,
      params: {}, today: opts.today || todayKey(),
    };
    let output = [];
    try {
      output = runList(blocks || [], [], ctx, 0, '');
    } catch (e) {
      if (!(e instanceof AlgoError)) throw e;
      ctx.error = e.message;
    }
    return {
      ok: !ctx.error && !ctx.failed,
      output: clone(output),
      params: clone(ctx.params),
      today: ctx.today,
      steps: ctx.steps,
      error: ctx.error,
    };
  }

  function pushStep(ctx, step) {
    if (ctx.steps.length >= ctx.opts.maxSteps) {
      throw new AlgoError('Слишком много шагов (больше ' + ctx.opts.maxSteps + ')');
    }
    step.index = ctx.steps.length;
    ctx.steps.push(step);
    return step;
  }

  function runList(blocks, data, ctx, depth, path) {
    let current = data;
    for (const block of blocks) {
      if (ctx.stopped) break;
      current = runBlock(block, current, ctx, depth, path);
    }
    return current;
  }

  function baseStep(block, before, depth, path) {
    return {
      blockId: block.id,
      type: block.type,
      title: block.label || BLOCK_TYPES[block.type].title,
      depth,
      path,
      before: clone(before),
      after: null,
      marks: [],
      ruleLabels: null,
      status: 'ok',
      message: '',
    };
  }

  function condMarks(block, data, ctx, step, okStatus, badStatus) {
    const res = data.map((x, i) => checkBlock(block, x, i, data, ctx));
    if (!usesCode(block)) step.ruleLabels = ((block.cond && block.cond.rules) || []).map(ruleText);
    step.join = usesCode(block) ? null : (block.cond && block.cond.join) || 'and';
    step.condText = condText(block);
    step.marks = res.map((r, i) => ({ index: i, status: r.ok ? okStatus : badStatus, rules: r.rules }));
    return res;
  }

  function runBlock(block, data, ctx, depth, path) {
    if (!BLOCK_TYPES[block.type]) throw new AlgoError('Неизвестный тип блока: ' + block.type);
    const step = baseStep(block, data, depth, path);

    try {
      switch (block.type) {
        case 'input': {
          ctx.params = paramsObject(block.params);
          const out = parseInput(block.data);
          step.params = clone(ctx.params);
          step.after = clone(out);
          step.marks = out.map((_, i) => ({ index: i, status: 'new' }));
          const pc = Object.keys(ctx.params).length;
          step.message = 'Элементов: ' + out.length + (pc ? ', параметров: ' + pc : '');
          pushStep(ctx, step);
          return out;
        }

        case 'filter': {
          const res = condMarks(block, data, ctx, step, 'kept', 'dropped');
          const out = data.filter((_, i) => res[i].ok);
          step.after = clone(out);
          step.message = 'Осталось ' + out.length + ' из ' + data.length;
          pushStep(ctx, step);
          return out;
        }

        case 'assert': {
          const res = condMarks(block, data, ctx, step, 'pass', 'fail');
          const failedCount = res.filter(r => !r.ok).length;
          step.after = clone(data);
          if (failedCount > 0) {
            step.status = 'fail';
            step.message = 'Утверждение нарушено для ' + failedCount + ' из ' + data.length;
            ctx.failed = true;
            if (block.stopOnFail) {
              step.message += ', выполнение остановлено';
              ctx.stopped = true;
            }
          } else {
            step.message = 'Утверждение верно для всех (' + data.length + ')';
          }
          pushStep(ctx, step);
          return data;
        }

        case 'branch': {
          const res = condMarks(block, data, ctx, step, 'yes', 'no');
          const yes = data.filter((_, i) => res[i].ok);
          const no = data.filter((_, i) => !res[i].ok);
          step.after = clone(data);
          step.split = { yes: clone(yes), no: clone(no) };
          step.message = 'Да: ' + yes.length + ', нет: ' + no.length;
          pushStep(ctx, step);

          const prefix = path ? path + ' › ' : '';
          const yesOut = runList(block.yes || [], yes, ctx, depth + 1, prefix + 'да');
          const noOut = ctx.stopped ? [] : runList(block.no || [], no, ctx, depth + 1, prefix + 'нет');
          const merged = yesOut.concat(noOut);

          if (!ctx.stopped) {
            pushStep(ctx, {
              blockId: block.id, type: 'merge', title: 'Слияние веток', depth, path,
              before: clone(data), after: clone(merged),
              split: { yes: clone(yesOut), no: clone(noOut) },
              marks: merged.map((_, i) => ({ index: i, status: i < yesOut.length ? 'yes' : 'no' })),
              status: 'ok',
              message: 'Объединено: ' + yesOut.length + ' (да) + ' + noOut.length + ' (нет)',
            });
          }
          return merged;
        }

        case 'map': {
          const out = data.map((x, i) => {
            const y = evaluate(block.expr, ['x', 'i', 'data', 'p'], [x, i, data, ctx.params]);
            step.marks.push({ index: i, status: 'changed', from: clone(x), to: clone(y) });
            return y;
          });
          step.after = clone(out);
          step.message = 'Преобразовано элементов: ' + out.length;
          pushStep(ctx, step);
          return out;
        }

        case 'sort': {
          const keyed = data.map((x, i) => ({
            x, i, k: evaluate(block.expr, ['x', 'i', 'data', 'p'], [x, i, data, ctx.params]),
          }));
          const dir = block.order === 'desc' ? -1 : 1;
          keyed.sort((a, b) => {
            const c = compare(a.k, b.k);
            if (c < 0) return -dir;
            if (c > 0) return dir;
            return a.i - b.i;
          });
          const out = keyed.map(e => e.x);
          step.marks = keyed.map((e, newIndex) => ({ index: e.i, status: 'moved', to: newIndex }));
          step.after = clone(out);
          step.message = 'Отсортировано по «' + block.expr + '» ' + (dir === 1 ? 'по возрастанию' : 'по убыванию');
          pushStep(ctx, step);
          return out;
        }

        case 'reduce': {
          let acc = evaluate(block.init == null || block.init === '' ? 'undefined' : String(block.init), ['p'], [ctx.params]);
          data.forEach((x, i) => {
            const prev = acc;
            acc = evaluate(block.expr, ['acc', 'x', 'i', 'data', 'p'], [acc, x, i, data, ctx.params]);
            step.marks.push({ index: i, status: 'folded', from: clone(prev), to: clone(acc) });
          });
          step.after = [clone(acc)];
          step.message = 'Результат: ' + JSON.stringify(acc);
          pushStep(ctx, step);
          return [acc];
        }

        default:
          throw new AlgoError('Неизвестный тип блока: ' + block.type);
      }
    } catch (e) {
      if (!(e instanceof AlgoError)) throw e;
      if (!ctx.steps.includes(step)) {
        step.status = 'error';
        step.message = e.message;
        step.after = null;
        step.marks = [];
        ctx.steps.push(Object.assign(step, { index: ctx.steps.length }));
      }
      throw e;
    }
  }

  // ---------- вспомогательное для интерфейса ----------
  /** Найти блок по id в дереве. */
  function findBlock(blocks, id) {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.id === id) return { block: b, list: blocks, index: i };
      if (b.type === 'branch') {
        const r = findBlock(b.yes || [], id) || findBlock(b.no || [], id);
        if (r) return r;
      }
    }
    return null;
  }

  function typeOfValue(v) {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'string' && dateKey(v)) return 'date';
    return typeof v;
  }

  /**
   * Собрать поля элементов (с вложенными через точку) и их типы.
   * [{name:'balance', type:'number', samples:[...]}]
   */
  function fieldsOf(items) {
    const map = new Map();
    function add(name, v) {
      if (!map.has(name)) map.set(name, { name, types: new Set(), samples: new Set() });
      const f = map.get(name);
      f.types.add(typeOfValue(v));
      if (v !== null && typeof v !== 'object' && f.samples.size < 12) f.samples.add(v);
    }
    function walk(obj, prefix, level) {
      for (const [k, v] of Object.entries(obj)) {
        const name = prefix ? prefix + '.' + k : k;
        if (v && typeof v === 'object' && !Array.isArray(v) && level < 2) walk(v, name, level + 1);
        else add(name, v);
      }
    }
    for (const it of items || []) {
      if (it && typeof it === 'object' && !Array.isArray(it)) walk(it, '', 0);
    }
    return [...map.values()].map(f => {
      const types = [...f.types].filter(t => t !== 'null');
      return { name: f.name, type: types.length === 1 ? types[0] : (types.length ? 'mixed' : 'null'), samples: [...f.samples] };
    });
  }

  /** Проверить структуру схемы (для загрузки из файла). */
  function validate(blocks) {
    const errors = [];
    (function walk(list, where) {
      if (!Array.isArray(list)) { errors.push(where + ': ожидался список блоков'); return; }
      list.forEach((b, i) => {
        const at = where + '[' + i + ']';
        if (!b || typeof b !== 'object') { errors.push(at + ': не объект'); return; }
        const info = BLOCK_TYPES[b.type];
        if (!info) { errors.push(at + ': неизвестный тип «' + b.type + '»'); return; }
        if (info.hasExpr && typeof b.expr !== 'string') errors.push(at + ': нет выражения');
        if (info.hasCond) {
          const okCode = b.condMode === 'code' ? typeof b.expr === 'string' : true;
          const okCond = b.cond ? Array.isArray(b.cond.rules) : typeof b.expr === 'string';
          if (!okCode || !okCond) errors.push(at + ': нет условия');
        }
        if (b.type === 'input' && b.params && !Array.isArray(b.params)) errors.push(at + ': params должен быть списком');
        if (b.type === 'branch') { walk(b.yes || [], at + '.yes'); walk(b.no || [], at + '.no'); }
      });
    })(blocks, 'blocks');
    return errors;
  }

  /** Обернуть алгоритм для сохранения в файл. */
  function serialize(name, blocks) {
    return { format: 'algo-visualizer', version: 2, name: name || 'Без названия', savedAt: new Date().toISOString(), blocks: clone(blocks) };
  }
  /** Прочитать сохранённый алгоритм: файл формата serialize() или просто массив блоков. */
  function deserialize(obj) {
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch (e) { throw new AlgoError('Это не JSON: ' + e.message); }
    }
    const blocks = Array.isArray(obj) ? obj : obj && obj.blocks;
    const name = (!Array.isArray(obj) && obj && obj.name) || '';
    const errs = validate(blocks);
    if (errs.length) throw new AlgoError('Схема не подходит: ' + errs.slice(0, 3).join('; '));
    return { name, blocks };
  }

  return {
    BLOCK_TYPES, OPS, PARAM_TYPES, AlgoError,
    parseInput, parseConst, castParam, paramsObject, dateKey, compare, getPath, todayKey,
    evalRule, evalCond, ruleText, condText, rule,
    createBlock, run, findBlock, fieldsOf, validate, serialize, deserialize,
  };
});
