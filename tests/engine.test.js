const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

const B = (type, props) => E.createBlock(type, props);

test('parseInput: JSON, одно значение, список через запятую', () => {
  assert.deepEqual(E.parseInput('[1, 2, 3]'), [1, 2, 3]);
  assert.deepEqual(E.parseInput('{"a":1}'), [{ a: 1 }]);
  assert.deepEqual(E.parseInput('4, 5, кот'), [4, 5, 'кот']);
  assert.deepEqual(E.parseInput(''), []);
});

test('input + filter: в трассе видно, что отброшено', () => {
  const r = E.run([B('input', { data: '[5, 3, 8, 1]' }), B('filter', { expr: 'x > 2' })]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.output, [5, 3, 8]);
  assert.equal(r.steps.length, 2);
  const f = r.steps[1];
  assert.deepEqual(f.before, [5, 3, 8, 1]);
  assert.deepEqual(f.marks.map(m => m.status), ['kept', 'kept', 'kept', 'dropped']);
});

test('map: запоминает старое и новое значение', () => {
  const r = E.run([B('input', { data: '[1, 2]' }), B('map', { expr: 'x * 10' })]);
  assert.deepEqual(r.output, [10, 20]);
  assert.deepEqual(r.steps[1].marks[1], { index: 1, status: 'changed', from: 2, to: 20 });
});

test('map и filter работают с объектами', () => {
  const r = E.run([
    B('input', { data: '[{"name":"Аня","age":17},{"name":"Олег","age":30}]' }),
    B('filter', { expr: 'x.age >= 18' }),
    B('map', { expr: 'x.name' }),
  ]);
  assert.deepEqual(r.output, ['Олег']);
});

test('assert: нарушение помечает шаг и весь запуск', () => {
  const r = E.run([B('input', { data: '[1, -2, 3]' }), B('assert', { expr: 'x > 0' }), B('map', { expr: 'x + 1' })]);
  assert.equal(r.ok, false);
  assert.equal(r.steps[1].status, 'fail');
  assert.deepEqual(r.steps[1].marks.map(m => m.status), ['pass', 'fail', 'pass']);
  assert.deepEqual(r.output, [2, -1, 4], 'без stopOnFail выполнение продолжается');
});

test('assert со stopOnFail останавливает выполнение', () => {
  const r = E.run([
    B('input', { data: '[1, -2]' }),
    B('assert', { expr: 'x > 0', stopOnFail: true }),
    B('map', { expr: 'x + 1' }),
  ]);
  assert.equal(r.steps.length, 2);
  assert.deepEqual(r.output, [1, -2]);
});

test('branch: разделяет, выполняет ветки и сливает', () => {
  const r = E.run([
    B('input', { data: '[1, 2, 3, 4]' }),
    B('branch', {
      expr: 'x % 2 === 0',
      yes: [B('map', { expr: 'x * 100' })],
      no: [B('filter', { expr: 'x > 1' })],
    }),
  ]);
  assert.deepEqual(r.output, [200, 400, 3]);
  const types = r.steps.map(s => s.type);
  assert.deepEqual(types, ['input', 'branch', 'map', 'filter', 'merge']);
  assert.deepEqual(r.steps[1].split, { yes: [2, 4], no: [1, 3] });
  assert.equal(r.steps[2].path, 'да');
  assert.equal(r.steps[3].path, 'нет');
  assert.equal(r.steps[2].depth, 1);
});

test('вложенные ветвления', () => {
  const r = E.run([
    B('input', { data: '[1, 2, 3, 4, 5, 6]' }),
    B('branch', {
      expr: 'x > 3',
      yes: [B('branch', { expr: 'x % 2 === 0', yes: [B('map', { expr: '"чёт"' })], no: [] })],
      no: [],
    }),
  ]);
  // слияние: сначала результат ветки «да», затем «нет»
  assert.deepEqual(r.output, ['чёт', 'чёт', 5, 1, 2, 3]);
  assert.ok(r.steps.some(s => s.path === 'да › да'));
});

test('sort по ключу и направлению, устойчивая', () => {
  const r = E.run([
    B('input', { data: '[{"n":"a","v":2},{"n":"b","v":1},{"n":"c","v":2}]' }),
    B('sort', { expr: 'x.v', order: 'desc' }),
    B('map', { expr: 'x.n' }),
  ]);
  assert.deepEqual(r.output, ['a', 'c', 'b']);
});

test('reduce: сумма и история накопителя', () => {
  const r = E.run([B('input', { data: '[1, 2, 3]' }), B('reduce', { expr: 'acc + x', init: '0' })]);
  assert.deepEqual(r.output, [6]);
  assert.deepEqual(r.steps[1].marks.map(m => m.to), [1, 3, 6]);
});

test('ошибка в выражении не роняет программу, а попадает в трассу', () => {
  const r = E.run([B('input', { data: '[1]' }), B('filter', { expr: 'x >' }), B('map', { expr: 'x' })]);
  assert.equal(r.ok, false);
  assert.match(r.error, /Ошибка в выражении/);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[1].status, 'error');
});

test('ошибка во время вычисления внутри ветки', () => {
  const r = E.run([
    B('input', { data: '[1]' }),
    B('branch', { expr: 'true', yes: [B('map', { expr: 'x.a.b' })], no: [] }),
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.steps.at(-1).status, 'error');
  assert.equal(r.steps.at(-1).path, 'да');
});

test('трасса хранит копии: изменения не влияют на прошлые шаги', () => {
  const r = E.run([B('input', { data: '[{"a":1}]' }), B('map', { expr: '(x.a = 5, x)' })]);
  assert.deepEqual(r.steps[0].after, [{ a: 1 }]);
  assert.deepEqual(r.output, [{ a: 5 }]);
});

test('findBlock находит блок внутри ветки', () => {
  const inner = B('map', { expr: 'x' });
  const blocks = [B('input'), B('branch', { yes: [], no: [inner] })];
  const f = E.findBlock(blocks, inner.id);
  assert.equal(f.block, inner);
  assert.equal(f.index, 0);
});

test('validate ловит неизвестный тип и пустое выражение', () => {
  assert.deepEqual(E.validate([B('input'), B('filter')]), []);
  const errs = E.validate([{ type: 'zzz' }, { type: 'branch', yes: [{ type: 'map' }] }]);
  assert.equal(errs.length, 3);
});

test('пустой алгоритм', () => {
  const r = E.run([]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.output, []);
});
