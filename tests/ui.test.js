// Проверка интерфейса в настоящем браузере (Playwright).
// Если Playwright не установлен, тест пропускается:
//   npm i -D playwright && npx playwright install chromium
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (_) { /* нет playwright */ }

const url = 'file://' + path.join(__dirname, '..', 'index.html');

test('интерфейс: пример выполняется, шаги листаются, блоки добавляются', { skip: !chromium && 'playwright не установлен' }, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.googleapis|ERR_/.test(m.text())) errors.push(m.text()); });

  // шрифты из интернета в тесте не нужны — не ждём их
  await page.route(/^https?:/, r => r.abort());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.block');

  // пример по умолчанию: 6 блоков верхнего уровня + 2 в ветках
  assert.equal(await page.locator('#editor .block').count(), 8);
  assert.match(await page.textContent('#summary'), /успешно/);
  assert.match(await page.textContent('#summary'), /\[79\]/); // сумма в примере

  // первый шаг — входные данные
  assert.match(await page.textContent('#counter'), /^1 \/ \d+/);
  assert.match(await page.textContent('#step'), /Входные данные|Числа/);

  // шаг вперёд — фильтр, есть отброшенный элемент
  await page.click('#btn-next');
  assert.equal(await page.locator('#step .chip.dropped').count(), 1);
  assert.equal(await page.locator('.block.active').count(), 1);

  // ломаем выражение — появляется ошибка на блоке
  const expr = page.locator('.block.t-filter .expr').first();
  await expr.fill('x >');
  await page.waitForSelector('.block.has-error');
  assert.match(await page.textContent('#summary'), /ошибка/);
  await expr.fill('x > 1');
  await page.waitForFunction(() => !document.querySelector('.block.has-error'));

  // добавляем утверждение в конец, которое нарушится
  const before = await page.locator('#editor .block').count();
  await page.locator('#editor > .flow > .add-wrap > .add-btn').click();
  await page.locator('.add-menu button', { hasText: 'Утверждение' }).click();
  assert.equal(await page.locator('#editor .block').count(), before + 1);
  await page.locator('.block.t-assert .expr').last().fill('x < 10');
  await page.waitForSelector('.block.has-fail');
  assert.match(await page.textContent('#summary'), /нарушено/);

  // загружаем другой пример через список
  await page.selectOption('#preset', 'students');
  await page.waitForFunction(() => /пересдача/.test(document.querySelector('#summary').textContent));

  // телефонная ширина: нет горизонтальной прокрутки
  await page.setViewportSize({ width: 390, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, 'горизонтальная прокрутка на телефоне: ' + overflow + 'px');

  assert.deepEqual(errors, []);
  await browser.close();
});
