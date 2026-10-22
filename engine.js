/*
 * Движок конструктора алгоритмов.
 *
 * Алгоритм — это список блоков. Каждый блок получает массив данных,
 * что-то с ним делает и передаёт дальше. Каждое действие записывается
 * в «трассу» (trace) — по ней интерфейс показывает промежуточные результаты.
 *
 * Типы блоков:
 *   input   — входные данные (JSON-массив или список через запятую)
 *   filter  — оставить элементы, для которых условие истинно
 *   map     — преобразовать каждый элемент
 *   branch  — разделить элементы по условию на ветки «да» и «нет»,
 *             у каждой ветки свои блоки; потом ветки снова сливаются
 *   assert  — утверждение: проверить, что условие верно для каждого элемента
 *   sort    — отсортировать по ключу
 *   reduce  — свернуть массив в одно значение (сумма, максимум и т. п.)
 *
 * В выражениях доступны переменные:
 *   x    — текущий элемент
 *   i    — его индекс
 *   data — весь текущий массив
 *   acc  — накопитель (только в reduce)
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
    input:  { title: 'Входные данные', hasExpr: false },
    filter: { title: 'Фильтр',         hasExpr: true  },
    map:    { title: 'Преобразование', hasExpr: true  },
    branch: { title: 'Ветвление',      hasExpr: true  },
    assert: { title: 'Утверждение',    hasExpr: true  },
    sort:   { title: 'Сортировка',     hasExpr: true  },
    reduce: { title: 'Свёртка',        hasExpr: true  },
  };

  class AlgoError extends Error {}

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

  /** Разобрать входные данные: JSON-массив, одно JSON-значение или список через запятую. */
  function parseInput(text) {
    if (Array.isArray(text)) return clone(text);
    const s = String(text == null ? '' : text).trim();
    if (s === '') return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [v];
    } catch (_) {
      return s.split(/[,;\n]/).map(t => t.trim()).filter(t => t !== '').map(t => {
        const n = Number(t);
        return Number.isFinite(n) ? n : t;
      });
    }
  }

  let uid = 0;
  function newId(prefix) {
    uid += 1;
    return (prefix || 'b') + Date.now().toString(36) + uid.toString(36);
  }

  /** Создать блок с параметрами по умолчанию. */
  function createBlock(type, overrides) {
    const defaults = {
      input:  { data: '[5, 3, 8, 1, 9, 2]' },
      filter: { expr: 'x > 2' },
      map:    { expr: 'x * 10' },
      branch: { expr: 'x % 2 === 0', yes: [], no: [] },
      assert: { expr: 'x >= 0', stopOnFail: false },
      sort:   { expr: 'x', order: 'asc' },
      reduce: { expr: 'acc + x', init: '0' },
    };
    if (!BLOCK_TYPES[type]) throw new AlgoError('Неизвестный тип блока: ' + type);
    return Object.assign({ id: newId(type[0]), type, label: '' }, clone(defaults[type]), overrides || {});
  }

  function asBool(v) { return Boolean(v); }

  /**
   * Выполнить алгоритм.
   * @param {Array} blocks список блоков
   * @param {Object} [options] { maxSteps }
   * @returns {{ok:boolean, output:Array, steps:Array, error:string|null}}
   */
  function run(blocks, options) {
    const opts = Object.assign({ maxSteps: 5000 }, options || {});
    const steps = [];
    const ctx = { steps, opts, stopped: false, error: null, failed: false };

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
      steps,
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
      status: 'ok',
      message: '',
    };
  }

  function runBlock(block, data, ctx, depth, path) {
    if (!BLOCK_TYPES[block.type]) throw new AlgoError('Неизвестный тип блока: ' + block.type);
    const step = baseStep(block, data, depth, path);

    try {
      switch (block.type) {
        case 'input': {
          const out = parseInput(block.data);
          step.after = clone(out);
          step.marks = out.map((_, i) => ({ index: i, status: 'new' }));
          step.message = 'Загружено элементов: ' + out.length;
          pushStep(ctx, step);
          return out;
        }

        case 'filter': {
          const out = [];
          data.forEach((x, i) => {
            const keep = asBool(evaluate(block.expr, ['x', 'i', 'data'], [x, i, data]));
            step.marks.push({ index: i, status: keep ? 'kept' : 'dropped' });
            if (keep) out.push(x);
          });
          step.after = clone(out);
          step.message = 'Осталось ' + out.length + ' из ' + data.length;
          pushStep(ctx, step);
          return out;
        }

        case 'map': {
          const out = data.map((x, i) => {
            const y = evaluate(block.expr, ['x', 'i', 'data'], [x, i, data]);
            step.marks.push({ index: i, status: 'changed', from: clone(x), to: clone(y) });
            return y;
          });
          step.after = clone(out);
          step.message = 'Преобразовано элементов: ' + out.length;
          pushStep(ctx, step);
          return out;
        }

        case 'assert': {
          let failedCount = 0;
          data.forEach((x, i) => {
            const ok = asBool(evaluate(block.expr, ['x', 'i', 'data'], [x, i, data]));
            if (!ok) failedCount += 1;
            step.marks.push({ index: i, status: ok ? 'pass' : 'fail' });
          });
          step.after = clone(data);
          if (failedCount > 0) {
            step.status = 'fail';
            step.message = 'Утверждение «' + block.expr + '» нарушено для ' + failedCount + ' из ' + data.length;
            ctx.failed = true;
            if (block.stopOnFail) {
              step.message += ' — выполнение остановлено';
              ctx.stopped = true;
            }
          } else {
            step.message = 'Утверждение «' + block.expr + '» верно для всех (' + data.length + ')';
          }
          pushStep(ctx, step);
          return data;
        }

        case 'sort': {
          const keyed = data.map((x, i) => ({
            x, i, k: evaluate(block.expr, ['x', 'i', 'data'], [x, i, data]),
          }));
          const dir = block.order === 'desc' ? -1 : 1;
          keyed.sort((a, b) => {
            if (a.k < b.k) return -1 * dir;
            if (a.k > b.k) return 1 * dir;
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
          let acc = evaluate(block.init == null || block.init === '' ? 'undefined' : String(block.init), [], []);
          const history = [];
          data.forEach((x, i) => {
            const prev = acc;
            acc = evaluate(block.expr, ['acc', 'x', 'i', 'data'], [acc, x, i, data]);
            history.push({ index: i, status: 'folded', from: clone(prev), to: clone(acc) });
          });
          step.marks = history;
          step.after = [clone(acc)];
          step.message = 'Результат: ' + JSON.stringify(acc);
          pushStep(ctx, step);
          return [acc];
        }

        case 'branch': {
          const yes = [];
          const no = [];
          data.forEach((x, i) => {
            const cond = asBool(evaluate(block.expr, ['x', 'i', 'data'], [x, i, data]));
            step.marks.push({ index: i, status: cond ? 'yes' : 'no' });
            (cond ? yes : no).push(x);
          });
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
              blockId: block.id,
              type: 'merge',
              title: 'Слияние веток',
              depth,
              path,
              before: clone(data),
              after: clone(merged),
              split: { yes: clone(yesOut), no: clone(noOut) },
              marks: merged.map((_, i) => ({ index: i, status: i < yesOut.length ? 'yes' : 'no' })),
              status: 'ok',
              message: 'Объединено: ' + yesOut.length + ' (да) + ' + noOut.length + ' (нет)',
            });
          }
          return merged;
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
        ctx.steps.push(Object.assign(step, { index: ctx.steps.length }));
      }
      throw e;
    }
  }

  /** Найти блок по id в дереве (с учётом веток). Возвращает {block, list, index}. */
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

  /** Проверить структуру схемы (для импорта из JSON). */
  function validate(blocks) {
    const errors = [];
    (function walk(list, where) {
      if (!Array.isArray(list)) { errors.push(where + ': ожидался список блоков'); return; }
      list.forEach((b, i) => {
        const at = where + '[' + i + ']';
        if (!b || typeof b !== 'object') { errors.push(at + ': не объект'); return; }
        if (!BLOCK_TYPES[b.type]) errors.push(at + ': неизвестный тип «' + b.type + '»');
        if (BLOCK_TYPES[b.type] && BLOCK_TYPES[b.type].hasExpr && typeof b.expr !== 'string') {
          errors.push(at + ': нет выражения');
        }
        if (b.type === 'branch') { walk(b.yes || [], at + '.yes'); walk(b.no || [], at + '.no'); }
      });
    })(blocks, 'blocks');
    return errors;
  }

  return { BLOCK_TYPES, AlgoError, parseInput, createBlock, run, findBlock, validate };
});
