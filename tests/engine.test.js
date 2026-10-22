const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');
const X = require('../examples.js');

const B = (type, props) => E.createBlock(type, props);
const R = E.rule;
const TODAY = '2026-10-22';
const run = blocks => E.run(blocks, { today: TODAY });
const names = r => r.output.map(c => c.name);

// ---------- разбор входных данных ----------

test('parseInput: JSON, одно значение, список через запятую', () => {
  assert.deepEqual(E.parseInput('[1, 2, 3]'), [1, 2, 3]);
  assert.deepEqual(E.parseInput('{"a":1}'), [{ a: 1 }]);
  assert.deepEqual(E.parseInput('4, 5, кот'), [4, 5, 'кот']);
  assert.deepEqual(E.parseInput(''), []);
});

test('parseInput: сломанный JSON — понятная ошибка, а не список строк', () => {
  assert.throws(() => E.parseInput('[{"a": 1,}'), /неверный JSON/);
});

test('параметры приводятся к своим типам', () => {
  const p = E.paramsObject([
    { name: 'creditAllowed', type: 'boolean', value: 'false' },
    { name: 'flag', type: 'boolean', value: true },
    { name: 'minAmount', type: 'number', value: '5000' },
    { name: 'empty', type: 'number', value: '' },
    { name: 'city', type: 'string', value: 'Алматы' },
    { name: '', type: 'string', value: 'без имени — пропускается' },
  ]);
  assert.deepEqual(p, { creditAllowed: false, flag: true, minAmount: 5000, empty: null, city: 'Алматы' });
});

test('parseConst: числа, да/нет, строки в кавычках', () => {
  assert.equal(E.parseConst('5000'), 5000);
  assert.equal(E.parseConst('true'), true);
  assert.equal(E.parseConst('нет'), false);
  assert.equal(E.parseConst('credit'), 'credit');
  assert.equal(E.parseConst('"123"'), '123');
});

// ---------- даты и сравнение ----------

test('dateKey: разные форматы срока действия', () => {
  assert.equal(E.dateKey('2027-03-15'), '2027-03-15');
  assert.equal(E.dateKey('2027-02'), '2027-02-28', 'месяц — до последнего дня');
  assert.equal(E.dateKey('2028-02'), '2028-02-29', 'високосный год');
  assert.equal(E.dateKey('03/27'), '2027-03-31', 'как на карте MM/YY');
  assert.equal(E.dateKey('15.03.2027'), '2027-03-15');
  assert.equal(E.dateKey('кот'), null);
});

test('карта действует до конца месяца, указанного на ней', () => {
  const blocks = [
    B('input', { data: JSON.stringify([{ e: '10/26' }, { e: '09/26' }, { e: '2026-10' }]) }),
    B('filter', { cond: { join: 'and', rules: [R('field', 'e', 'gte', 'today')] } }),
  ];
  assert.deepEqual(run(blocks).output.map(c => c.e), ['10/26', '2026-10']);
});

test('compare: числа как числа, строки-числа тоже', () => {
  assert.ok(E.compare(10, 9) > 0);
  assert.ok(E.compare('10', 9) > 0);
  assert.ok(E.compare('b', 'a') > 0);
});

// ---------- правила ----------

test('правило: поле против константы', () => {
  const r = E.evalRule(R('field', 'balance', 'gte', 'const', '5000'), { balance: 7300 }, {}, TODAY);
  assert.deepEqual(r, { ok: true, left: 7300, right: 5000 });
});

test('правило: поле против параметра', () => {
  const rule = R('field', 'balance', 'gte', 'param', 'minAmount');
  assert.equal(E.evalRule(rule, { balance: 800 }, { minAmount: 5000 }, TODAY).ok, false);
});

test('правило: вложенное поле через точку', () => {
  const rule = R('field', 'owner.age', 'gte', 'const', '18');
  assert.equal(E.evalRule(rule, { owner: { age: 20 } }, {}, TODAY).ok, true);
});

test('правило: несуществующий параметр — ошибка с его именем', () => {
  assert.throws(() => E.evalRule(R('param', 'nope', 'isTrue'), {}, {}, TODAY), /Нет параметра «nope»/);
});

test('операции: да/нет, задано/не задано, содержит, равно', () => {
  const t = (op, a, b) => E.evalRule(R('field', 'v', op, 'const', b), { v: a }, {}, TODAY).ok;
  assert.equal(t('isTrue', true), true);
  assert.equal(t('isFalse', false), true);
  assert.equal(t('isFalse', undefined), true, 'отсутствующее поле считается «нет»');
  assert.equal(t('isEmpty', ''), true);
  assert.equal(t('notEmpty', 0), true);
  assert.equal(t('contains', 'Кредитка Travel', 'travel'), true, 'без учёта регистра');
  assert.equal(t('contains', ['a', 'b'], 'b'), true);
  assert.equal(t('eq', 'credit', 'credit'), true);
  assert.equal(t('ne', 'debit', 'credit'), true);
  assert.equal(t('eq', true, 'true'), true);
});

test('условие И / ИЛИ и результат по каждому правилу', () => {
  const cond = { join: 'or', rules: [R('param', 'creditAllowed', 'isTrue'), R('field', 'type', 'ne', 'const', 'credit')] };
  assert.deepEqual(E.evalCond(cond, { type: 'credit' }, { creditAllowed: false }, TODAY), { ok: false, rules: [false, false] });
  assert.deepEqual(E.evalCond(cond, { type: 'debit' }, { creditAllowed: false }, TODAY), { ok: true, rules: [false, true] });
  assert.deepEqual(E.evalCond({ ...cond, join: 'and' }, { type: 'debit' }, { creditAllowed: true }, TODAY), { ok: true, rules: [true, true] });
  assert.deepEqual(E.evalCond({ join: 'and', rules: [] }, {}, {}, TODAY), { ok: true, rules: [] }, 'пустое условие пропускает всё');
});

test('текст условия для показа', () => {
  const b = B('filter', { cond: { join: 'or', rules: [R('param', 'creditAllowed', 'isTrue'), R('field', 'balance', 'gte', 'param', 'minAmount')] } });
  assert.equal(E.condText(b), 'параметр creditAllowed да (true) ИЛИ balance ≥ параметр minAmount');
});

// ---------- примеры с картами ----------

test('пример «выбор карт»: кредитные запрещены', () => {
  const r = run(X.byKey.cards.make());
  assert.equal(r.ok, true, r.error || '');
  assert.deepEqual(names(r), ['Зарплатная', 'Мир']);
  assert.deepEqual(r.params, { creditAllowed: false, hasMinAmount: true, minAmount: 5000 });
  // в шаге фильтра по кредитным видно, какое правило сработало
  const step = r.steps.find(s => s.title === 'Кредитные разрешены?');
  assert.deepEqual(step.ruleLabels, ['параметр creditAllowed да (true)', 'type ≠ «credit»']);
  const platinum = step.before.findIndex(c => c.name === 'Кредитка Platinum');
  assert.deepEqual(step.marks[platinum], { index: platinum, status: 'dropped', rules: [false, false] });
});

test('пример «выбор карт»: меняем параметры — меняется результат', () => {
  const blocks = X.byKey.cards.make();
  const params = blocks[0].params;
  params.find(p => p.name === 'creditAllowed').value = true;
  params.find(p => p.name === 'minAmount').value = 10000;
  const r = run(blocks);
  // Travel и Мир отсеиваются по минимальной сумме 10000
  assert.deepEqual(names(r), ['Кредитка Platinum', 'Зарплатная']);
  params.find(p => p.name === 'hasMinAmount').value = false;
  const r2 = run(blocks);
  assert.deepEqual(names(r2), ['Кредитка Platinum', 'Зарплатная', 'Мир', 'Кредитка Travel']);
  assert.equal(r2.ok, false, 'Travel в долларах нарушает утверждение');
  assert.equal(r2.steps.find(s => s.type === 'assert').status, 'fail');
});

test('пример с ветвлением по типу карты', () => {
  const r = run(X.byKey.cardsBranch.make());
  assert.equal(r.ok, true, r.error || '');
  assert.deepEqual(names(r), ['Кредитка Platinum', 'Зарплатная', 'Мир']);
  assert.ok(r.steps.some(s => s.path === 'да' && s.title === 'Лимит не меньше порога'));
});

test('пример с числами (выражения JS)', () => {
  const r = run(X.byKey.numbers.make());
  assert.equal(r.ok, true, r.error || '');
  assert.deepEqual(r.output, [79]);
});

// ---------- «только первый совпавший» ----------

test('фильтр «только первая»: берёт первую совпавшую карту, порядок важен', () => {
  const blocks = X.byKey.cards.make();
  // сортируем по балансу до фильтра, чтобы «первая» = с наибольшим балансом
  blocks.splice(1, 0, B('sort', { expr: 'x.balance', order: 'desc' }));
  blocks.push(B('filter', { label: 'Одна карта', take: 'first', cond: { join: 'and', rules: [R('field', 'balance', 'gte', 'const', '1000')] } }));
  const r = run(blocks);
  assert.deepEqual(names(r), ['Зарплатная']);
  const step = r.steps.at(-1);
  assert.equal(step.take, 'first');
  assert.deepEqual(step.marks.map(m => m.status), ['kept', 'skipped']);
  assert.match(step.message, /Взят первый совпавший \(№0\), совпало всего 2 из 2/);
});

test('фильтр «только первая»: нет совпадений — пустой результат', () => {
  const r = run([
    B('input', { data: '[1, 2, 3]' }),
    B('filter', { take: 'first', condMode: 'code', expr: 'x > 10' }),
  ]);
  assert.deepEqual(r.output, []);
  assert.equal(r.steps[1].message, 'Совпадений нет');
});

test('фильтр «все» — поведение по умолчанию', () => {
  const r = run([B('input', { data: '[1, 2, 3]' }), B('filter', { condMode: 'code', expr: 'x > 1' })]);
  assert.deepEqual(r.output, [2, 3]);
  assert.equal(r.steps[1].take, 'all');
});

test('ветвление «только первая»: в «да» первый совпавший, остальные в «нет»', () => {
  const r = run([
    B('input', { data: '[1, 4, 6, 3, 8]' }),
    B('branch', {
      take: 'first', condMode: 'code', expr: 'x % 2 === 0',
      yes: [B('map', { expr: '"выбран " + x' })],
      no: [],
    }),
  ]);
  assert.deepEqual(r.steps[1].split, { yes: [4], no: [1, 6, 3, 8] });
  assert.deepEqual(r.steps[1].marks.map(m => m.status), ['no', 'yes', 'skipped', 'no', 'skipped']);
  assert.deepEqual(r.output, ['выбран 4', 1, 6, 3, 8]);
  assert.match(r.steps[1].message, /только первый совпавший/);
});

// ---------- общие механизмы ----------

test('выражения видят параметры через p', () => {
  const r = run([
    B('input', { params: [{ name: 'k', type: 'number', value: 3 }], data: '[1, 2]' }),
    B('map', { expr: 'x * p.k' }),
    B('filter', { condMode: 'code', expr: 'x > p.k' }),
  ]);
  assert.deepEqual(r.output, [6]);
});

test('утверждение со stopOnFail останавливает выполнение', () => {
  const r = run([
    B('input', { data: '[1, -2]' }),
    B('assert', { condMode: 'code', expr: 'x > 0', stopOnFail: true }),
    B('map', { expr: 'x + 1' }),
  ]);
  assert.equal(r.steps.length, 2);
  assert.deepEqual(r.output, [1, -2]);
  assert.equal(r.ok, false);
});

test('ветвление: разделяет, выполняет ветки и сливает', () => {
  const r = run([
    B('input', { data: '[1, 2, 3, 4]' }),
    B('branch', {
      condMode: 'code', expr: 'x % 2 === 0',
      yes: [B('map', { expr: 'x * 100' })],
      no: [B('filter', { condMode: 'code', expr: 'x > 1' })],
    }),
  ]);
  assert.deepEqual(r.output, [200, 400, 3]);
  assert.deepEqual(r.steps.map(s => s.type), ['input', 'branch', 'map', 'filter', 'merge']);
  assert.deepEqual(r.steps[1].split, { yes: [2, 4], no: [1, 3] });
  assert.equal(r.steps[2].path, 'да');
  assert.equal(r.steps[3].path, 'нет');
});

test('сортировка: по убыванию, устойчивая, даты как даты', () => {
  const r = run([
    B('input', { data: JSON.stringify([{ n: 'a', d: '12/27' }, { n: 'b', d: '2027-01' }, { n: 'c', d: '12/27' }]) }),
    B('sort', { expr: 'x.d', order: 'desc' }),
  ]);
  assert.deepEqual(r.output.map(x => x.n), ['a', 'c', 'b']);
});

test('ошибка в выражении попадает в трассу и не роняет программу', () => {
  const r = run([B('input', { data: '[1]' }), B('filter', { condMode: 'code', expr: 'x >' }), B('map', { expr: 'x' })]);
  assert.equal(r.ok, false);
  assert.match(r.error, /Ошибка в выражении/);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[1].status, 'error');
});

test('правило без выбранного поля — понятная ошибка', () => {
  const r = run([B('input', { data: '[{"a":1}]' }), B('filter', { cond: { join: 'and', rules: [{ left: { kind: 'field', name: '' }, op: 'eq', right: { kind: 'const', value: '1' } }] } })]);
  assert.match(r.error, /не выбрано/);
});

test('трасса хранит копии', () => {
  const r = run([B('input', { data: '[{"a":1}]' }), B('map', { expr: '(x.a = 5, x)' })]);
  assert.deepEqual(r.steps[0].after, [{ a: 1 }]);
  assert.deepEqual(r.output, [{ a: 5 }]);
});

// ---------- поля, проверка схемы, сохранение ----------

test('fieldsOf: поля карт и их типы', () => {
  const f = Object.fromEntries(E.fieldsOf(X.CARDS).map(x => [x.name, x.type]));
  assert.deepEqual(f, { id: 'string', name: 'string', type: 'string', balance: 'number', expires: 'date', currency: 'string', blocked: 'boolean' });
  const nested = E.fieldsOf([{ owner: { age: 3 } }]);
  assert.equal(nested[0].name, 'owner.age');
});

test('validate ловит неизвестный тип и пустое условие', () => {
  assert.deepEqual(E.validate(X.byKey.cards.make()), []);
  assert.deepEqual(E.validate(X.byKey.numbers.make()), []);
  const errs = E.validate([{ type: 'zzz' }, { type: 'branch', cond: { rules: [] }, yes: [{ type: 'map' }] }, { type: 'filter' }]);
  assert.equal(errs.length, 3);
});

test('сохранение и загрузка алгоритма', () => {
  const saved = E.serialize('Подбор карт', X.byKey.cards.make());
  const text = JSON.stringify(saved);
  const loaded = E.deserialize(text);
  assert.equal(loaded.name, 'Подбор карт');
  assert.deepEqual(names(run(loaded.blocks)), ['Зарплатная', 'Мир']);
  // старый формат — просто массив блоков
  assert.equal(E.deserialize(saved.blocks).blocks.length, saved.blocks.length);
  assert.throws(() => E.deserialize('{"blocks": [{"type": "zzz"}]}'), /не подходит/);
  assert.throws(() => E.deserialize('не json'), /не JSON/);
});

test('findBlock находит блок внутри ветки', () => {
  const inner = B('map', { expr: 'x' });
  const blocks = [B('input'), B('branch', { yes: [], no: [inner] })];
  assert.equal(E.findBlock(blocks, inner.id).block, inner);
});

test('пустой алгоритм', () => {
  const r = run([]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.output, []);
});
