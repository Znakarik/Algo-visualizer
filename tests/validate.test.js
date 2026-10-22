// Проверка скрипта tools/validate.js, которым агент проверяет собранные алгоритмы.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../engine.js');
const X = require('../examples.js');

const tool = path.join(__dirname, '..', 'tools', 'validate.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-validate-'));
const R = E.rule;
const B = (t, p) => E.createBlock(t, p);

function write(name, obj) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
}
function validate(...args) {
  const r = spawnSync(process.execPath, [tool, '--json', '--today', '2026-10-22', ...args], { encoding: 'utf8' });
  return { code: r.status, report: JSON.parse(r.stdout || '[]'), stderr: r.stderr };
}

test('примеры из algorithms/ проходят без ошибок', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'algorithms')).filter(f => f.endsWith('.algo.json'))
    .map(f => path.join(__dirname, '..', 'algorithms', f));
  assert.ok(files.length >= 2);
  const { code, report } = validate(...files);
  assert.equal(code, 0, JSON.stringify(report.map(r => r.errors)));
});

test('сценарии: ожидаемый результат совпал и не совпал', () => {
  const extra = JSON.parse(JSON.stringify(X.byKey.cards.extra));
  const ok = write('ok.algo.json', E.serialize('ok', X.byKey.cards.make(), extra));
  assert.equal(validate(ok).code, 0);

  extra.scenarios[0].expect = ['нет такой карты'];
  const bad = write('bad.algo.json', E.serialize('bad', X.byKey.cards.make(), extra));
  const { code, report } = validate(bad);
  assert.equal(code, 1);
  assert.match(report[0].errors.join('\n'), /Сценарий «по умолчанию»: ожидалось \["нет такой карты"\]/);
});

test('сценарий с неизвестным параметром — ошибка', () => {
  const f = write('p.algo.json', E.serialize('p', X.byKey.cards.make(), { scenarios: [{ name: 'x', params: { nope: 1 } }] }));
  const { code, report } = validate(f);
  assert.equal(code, 1);
  assert.match(report[0].errors.join('\n'), /неизвестный параметр «nope»/);
});

test('ошибки структуры: нет входных данных первым, ссылка на несуществующий параметр, плохая операция', () => {
  const f1 = write('noinput.algo.json', { blocks: [B('filter', { cond: { join: 'and', rules: [] } })] });
  assert.match(validate(f1).report[0].errors.join('\n'), /Первым блоком/);

  const f2 = write('param.algo.json', { blocks: [
    B('input', { data: '[{"a":1}]' }),
    B('filter', { cond: { join: 'and', rules: [R('param', 'creditAllowed', 'isTrue')] } }),
  ] });
  assert.match(validate(f2).report[0].errors.join('\n'), /нет параметра «creditAllowed»/);

  const f3 = write('op.algo.json', { blocks: [
    B('input', { data: '[{"a":1}]' }),
    B('filter', { cond: { join: 'and', rules: [{ left: { kind: 'field', name: 'a' }, op: 'between', right: { kind: 'const', value: '1' } }] } }),
  ] });
  assert.match(validate(f3).report[0].errors.join('\n'), /неизвестная операция «between»/);

  const f4 = write('json.algo.json', '{ не json');
  assert.equal(validate(f4).code, 1);
});

test('предупреждения: поле не из данных, нет покрытия, нет source при source у файла', () => {
  const f = write('w.algo.json', {
    source: 'src/CardSelector.java',
    blocks: [
      B('input', { data: '[{"id":"1","balance":10},{"id":"2","balance":20}]' }),
      B('filter', { label: 'Опечатка в поле', source: 'src/CardSelector.java:10', cond: { join: 'or', rules: [R('field', 'balanse', 'gte', 'const', '0'), R('field', 'balance', 'gte', 'const', '0')] } }),
      B('filter', { label: 'Без source', cond: { join: 'and', rules: [R('field', 'balance', 'gt', 'const', '15')] } }),
    ],
  });
  const { code, report } = validate(f);
  assert.equal(code, 0, 'предупреждения не ломают проверку');
  const w = report[0].warnings.join('\n');
  assert.match(w, /поля «balanse» нет в тестовых данных/);
  assert.match(w, /balance ≥ 0» ни разу не было ложным/);
  assert.match(w, /Без source: нет source/);
});

test('serialize/deserialize сохраняют description, source и scenarios', () => {
  const s = E.serialize('n', [B('input')], { description: 'd', source: 'src/x', scenarios: [{ name: 'a', params: {} }], junk: 1 });
  assert.equal(s.description, 'd');
  assert.equal(s.junk, undefined);
  const back = E.deserialize(JSON.stringify(s));
  assert.deepEqual(back.extra, { description: 'd', source: 'src/x', scenarios: [{ name: 'a', params: {} }] });
});

test('withParams не меняет исходный алгоритм', () => {
  const blocks = X.byKey.cards.make();
  const copy = E.withParams(blocks, { creditAllowed: true });
  assert.equal(copy[0].params[0].value, true);
  assert.equal(blocks[0].params[0].value, false);
});

test('возвраты: несработавший возврат и недостижимые блоки — предупреждения; data в сценарии', () => {
  const ex = X.byKey.cardsReturn;
  // без сценариев: «карт нет» не срабатывает, блоки после возврата дебетовых не выполняются
  const bare = write('ret-bare.algo.json', E.serialize('r', ex.make(), {}));
  const w = validate(bare).report[0].warnings.join('\n');
  assert.match(w, /Карт нет: вернуть пустой: возврат ни разу не сработал/);
  assert.match(w, /Остаются кредитные: не выполнялся ни в одном запуске/);

  // со сценариями из примера (включая «карт нет» с data: []) всё покрыто
  const full = write('ret-full.algo.json', E.serialize('r', ex.make(), ex.extra));
  const { code, report } = validate(full);
  assert.equal(code, 0, report[0].errors.join('\n'));
  assert.doesNotMatch(report[0].warnings.join('\n'), /ни разу не сработал|не выполнялся/);
  assert.deepEqual(report[0].scenarios.find(s => s.name === 'карт нет').output, []);
});
