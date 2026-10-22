// Проверка интерфейса в настоящем браузере (Playwright).
// Если Playwright не установлен, тест пропускается:
//   npm i -D playwright && npx playwright install chromium
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (_) { /* нет playwright */ }

const url = 'file://' + path.join(__dirname, '..', 'index.html');
const skip = !chromium && 'playwright не установлен';

// По умолчанию отключаем системные окна выбора файла: в автотесте их некому закрыть.
const NO_PICKERS = () => { delete window.showSaveFilePicker; delete window.showOpenFilePicker; };

async function openPage(browser, ctx, init) {
  const page = await (ctx || browser).newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(init || NO_PICKERS);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:/, r => r.abort()); // шрифты из интернета в тесте не нужны
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.block');
  return { page, errors };
}
const summary = page => page.textContent('#summary');

test('карты: параметры, накликивание правил, ошибки', { skip }, async () => {
  const browser = await chromium.launch();
  const { page, errors } = await openPage(browser);

  // пример по умолчанию — выбор карт
  assert.match(await summary(page), /Результат \(2\): Зарплатная, Мир/);
  assert.equal(await page.locator('.block.t-filter').count(), 4);

  // включаем кредитные карты в панели параметров
  await page.locator('#params-panel .qp', { hasText: 'creditAllowed' }).locator('input[type=checkbox]').check();
  await page.waitForFunction(() => /Кредитка Platinum/.test(document.querySelector('#summary').textContent));
  // и в блоке входных данных значение тоже обновилось
  await page.waitForFunction(() => document.querySelector('.block.t-input .param-row input[type=checkbox]').checked);

  // переход к шагу фильтра — таблица с колонками правил П1/П2
  await page.locator('.block.t-filter .type-tag').nth(2).click();
  assert.match(await page.textContent('#step'), /Кредитные разрешены\?/);
  assert.equal(await page.locator('#step th.rule-col').count(), 2);
  assert.ok(await page.locator('#step tr.row-kept').count() > 0);

  // добавляем фильтр кликами: currency = RUB
  await page.locator('#editor > .flow > .add-wrap > .add-btn').click();
  await page.locator('.add-menu button', { hasText: 'Фильтр' }).click();
  const last = page.locator('.block.t-filter').last();
  await last.locator('select.operand').first().selectOption('field:currency');
  await last.locator('select.op').selectOption('eq');
  await last.locator('input.rvalue').fill('USD');
  await page.waitForFunction(() => /Результат \(1\): Кредитка Travel|Результат \(0\)/.test(document.querySelector('#summary').textContent));
  // счётчик «сколько прошло» у правила
  assert.match(await last.locator('.rule-status').first().textContent(), /^\d+\/\d+$/);

  // правило сравнения с параметром: balance ≥ p.minAmount
  await last.locator('.link-btn', { hasText: '+ условие' }).click();
  const rule2 = last.locator('.rule').nth(1);
  await rule2.locator('select.operand').first().selectOption('field:balance');
  await rule2.locator('select.op').selectOption('gte');
  await rule2.locator('select.rkind').selectOption('param');
  await rule2.locator('select.operand').nth(1).selectOption('param:minAmount');
  await page.waitForFunction(() => /Результат \(0\)/.test(document.querySelector('#summary').textContent));

  // переключаем на ИЛИ
  await last.locator('select.join-select').selectOption('or');
  await page.waitForFunction(() => /Результат \(\d\)/.test(document.querySelector('#summary').textContent) && !/Результат \(0\)/.test(document.querySelector('#summary').textContent));

  // ссылка на несуществующий параметр — понятная ошибка
  const pname = page.locator('#editor .block.t-input input.p-name').nth(2);
  await pname.fill('minSum');
  await pname.blur();
  await page.waitForFunction(() => /Нет параметра «minAmount»/.test(document.querySelector('#summary').textContent));
  assert.ok(await page.locator('.block.has-error').count() > 0);

  // режим «Код»
  await last.locator('.seg button', { hasText: 'Код' }).click();
  assert.match(await last.locator('input.expr').inputValue(), /x\.currency === "USD"/);

  // телефонная ширина: нет горизонтальной прокрутки
  await page.setViewportSize({ width: 390, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, 'горизонтальная прокрутка на телефоне: ' + overflow + 'px');

  assert.deepEqual(errors, []);
  await browser.close();
});

test('сохранение: в браузере и в файл', { skip }, async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const { page, errors } = await openPage(browser, ctx);

  // без названия не сохраняется
  await page.click('#btn-save');
  assert.match(await page.textContent('#save-state'), /Введите название/);

  await page.fill('#algo-name', 'Подбор карт');
  await page.click('#btn-save');
  assert.match(await page.textContent('#save-state'), /Сохранено/);

  // меняем — появляется «несохранённые изменения»
  await page.locator('#params-panel input[type=number]').first().fill('100');
  await page.waitForFunction(() => /несохранённые/.test(document.querySelector('#save-state').textContent) || /Сохранено/.test(document.querySelector('#save-state').textContent));
  await page.waitForTimeout(2700);
  assert.match(await page.textContent('#save-state'), /несохранённые/);

  // скачиваем файл (латинское имя: headless-браузер в тестовой среде
  // не умеет сохранять кириллические имена файлов, обычный браузер умеет)
  await page.fill('#algo-name', 'cards-v1');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-download')]);
  assert.equal(dl.suggestedFilename(), 'cards-v1.algo.json');
  await page.fill('#algo-name', 'Подбор карт');
  const file = path.join(os.tmpdir(), 'algo-test-' + Date.now() + '.algo.json');
  await dl.saveAs(file);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.format, 'algo-visualizer');
  assert.equal(saved.name, 'cards-v1');

  // открываем другой пример, потом сохранённый из списка
  await page.selectOption('#preset', 'numbers');
  await page.waitForFunction(() => /79/.test(document.querySelector('#summary').textContent));
  await page.selectOption('#library', 'Подбор карт');
  await page.waitForFunction(() => /Зарплатная/.test(document.querySelector('#summary').textContent));
  assert.equal(await page.inputValue('#algo-name'), 'Подбор карт');

  // после перезагрузки страницы алгоритм на месте
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.block');
  assert.equal(await page.inputValue('#algo-name'), 'Подбор карт');
  assert.ok((await page.locator('#library option').allTextContents()).some(t => t.startsWith('Подбор карт')));

  // открываем файл (с изменённым minAmount=100 — Старая дебетовая всё равно истекла)
  await page.selectOption('#preset', 'numbers');
  saved.name = 'Из файла';
  fs.writeFileSync(file, JSON.stringify(saved));
  await page.setInputFiles('#file-input', file);
  await page.waitForFunction(() => document.querySelector('#algo-name').value === 'Из файла');
  assert.match(await summary(page), /Зарплатная/);

  // удаление в два клика
  await page.selectOption('#library', 'Подбор карт');
  await page.click('#btn-delete');
  assert.equal(await page.textContent('#btn-delete'), 'Точно удалить?');
  await page.click('#btn-delete');
  assert.ok(!(await page.locator('#library option').allTextContents()).some(t => t.startsWith('Подбор карт')));

  fs.unlinkSync(file);
  assert.deepEqual(errors, []);
  await browser.close();
});

test('«только первая совпавшая» в фильтре и ветвлении', { skip }, async () => {
  const browser = await chromium.launch();
  const { page, errors } = await openPage(browser);
  // в примере после фильтров остаются Зарплатная и Мир; на последнем фильтре берём только первую
  const f = page.locator('.block.t-filter').nth(3);
  await f.locator('select.take-select').selectOption('first');
  await page.waitForFunction(() => /Результат \(1\): Зарплатная/.test(document.querySelector('#summary').textContent));
  await page.locator('.block.t-filter').nth(3).locator('.type-tag').click();
  assert.equal(await page.locator('#step tr.row-skipped').count(), 1);
  // в блоках без выбора режима не должно появляться лишнего текста
  assert.doesNotMatch(await page.textContent('#editor'), /null|undefined/);
  assert.match(await page.textContent('#step'), /совпал, не первый/);

  // ветвление: в «да» уходит одна карта
  await page.selectOption('#preset', 'cardsBranch');
  await page.waitForSelector('.block.t-branch');
  await page.locator('.block.t-branch select.take-select').first().selectOption('first');
  await page.locator('.block.t-branch .type-tag').first().click();
  assert.match(await page.textContent('#step'), /Да: 1, нет: 3/);
  assert.deepEqual(errors, []);
  await browser.close();
});

test('внешний файл: выбранный файл перезаписывается при каждом сохранении (Chrome)', { skip }, async () => {
  const browser = await chromium.launch();
  // подменяем системное окно выбора файла: файл «живёт» в window.__files
  const fakePickers = () => {
    window.__files = {};
    const handle = name => ({
      name,
      async createWritable() { let buf = ''; return { async write(d) { buf += d; }, async close() { window.__files[name] = buf; } }; },
      async getFile() { const t = window.__files[name]; return { name, text: async () => t }; },
    });
    window.showSaveFilePicker = async opts => handle(opts.suggestedName);
    window.showOpenFilePicker = async () => [handle('Подбор карт.algo.json')];
  };
  const { page, errors } = await openPage(browser, null, fakePickers);
  await page.fill('#algo-name', 'Подбор карт');
  await page.click('#btn-download');
  await page.waitForFunction(() => !!window.__files['Подбор карт.algo.json']);
  assert.match(await page.textContent('#file-link'), /файл: Подбор карт\.algo\.json/);
  assert.equal(await page.textContent('#btn-download'), 'Записать в файл');

  // меняем параметр и жмём «Сохранить» — файл обновляется
  await page.locator('#params-panel input[type=number]').first().fill('777');
  await page.click('#btn-save');
  await page.waitForFunction(() => /777/.test(window.__files['Подбор карт.algo.json']));
  const saved = JSON.parse(await page.evaluate(() => window.__files['Подбор карт.algo.json']));
  assert.equal(saved.blocks[0].params.find(p => p.name === 'minAmount').value, 777);

  // открываем другой пример (файл отвязывается), потом открываем файл снова
  await page.selectOption('#preset', 'numbers');
  assert.equal(await page.isHidden('#file-link'), true);
  await page.click('#btn-open-file');
  await page.waitForFunction(() => document.querySelector('#algo-name').value === 'Подбор карт');
  assert.equal(await page.isVisible('#file-link'), true);
  assert.deepEqual(errors, []);
  await browser.close();
});

test('claude.ai: список алгоритмов в хранилище страницы, файл через платформу', { skip }, async () => {
  const browser = await chromium.launch();
  // подменяем возможности claude.ai: db (в памяти) и downloads
  const fakeClaude = () => {
    delete window.showSaveFilePicker; delete window.showOpenFilePicker;
    const store = (window.__db = { algorithms: {} });
    const listeners = [];
    const snap = () => ({ docs: Object.entries(store.algorithms).map(([id, v]) => ({ id, exists: true, data: () => v })) });
    const emit = () => listeners.forEach(fn => fn(snap()));
    const db = {
      collection: p => ({
        doc: id => ({
          async set(v) { store[p][id] = JSON.parse(JSON.stringify(v)); setTimeout(emit, 0); },
          async delete() { delete store[p][id]; setTimeout(emit, 0); },
        }),
        onSnapshot(fn) { listeners.push(fn); setTimeout(() => fn(snap()), 0); return () => {}; },
      }),
    };
    window.__downloads = [];
    const downloads = { async save(r) { window.__downloads.push(r); return { status: 'saved' }; } };
    window.claude = { use: async name => (name === 'db' ? db : name === 'downloads' ? downloads : null) };
  };
  const { page, errors } = await openPage(browser, null, fakeClaude);
  await page.waitForFunction(() => window.__db !== undefined);

  await page.fill('#algo-name', 'Подбор карт');
  await page.click('#btn-save');
  await page.waitForFunction(() => Object.values(window.__db.algorithms).some(v => v.name === 'Подбор карт'));
  const doc = await page.evaluate(() => Object.values(window.__db.algorithms)[0]);
  assert.equal(JSON.parse(doc.blocks)[0].type, 'input');
  await page.waitForFunction(() => [...document.querySelectorAll('#library option')].some(o => o.textContent.startsWith('Подбор карт')));

  // файл — через платформу, с правильным именем
  await page.click('#btn-download');
  await page.waitForFunction(() => window.__downloads.length === 1);
  const dl = await page.evaluate(() => window.__downloads[0]);
  assert.equal(dl.filename, 'Подбор карт.algo.json');
  assert.equal(JSON.parse(dl.data).name, 'Подбор карт');

  // удаление из хранилища
  await page.click('#btn-delete');
  await page.click('#btn-delete');
  await page.waitForFunction(() => Object.keys(window.__db.algorithms).length === 0);
  assert.deepEqual(errors, []);
  await browser.close();
});
