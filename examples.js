/* Готовые примеры алгоритмов. Используются в интерфейсе и в тестах. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.AlgoExamples = factory(root.AlgoEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  const B = (type, props) => E.createBlock(type, props);
  const R = E.rule;

  const CARDS = [
    { id: '4276 •• 1111', name: 'Зарплатная', type: 'debit', balance: 15000, expires: '2027-03', currency: 'RUB', blocked: false },
    { id: '5536 •• 2222', name: 'Кредитка Platinum', type: 'credit', balance: 120000, expires: '2028-11', currency: 'RUB', blocked: false },
    { id: '2200 •• 3333', name: 'Старая дебетовая', type: 'debit', balance: 800, expires: '2025-08', currency: 'RUB', blocked: false },
    { id: '4111 •• 4444', name: 'Кредитка Travel', type: 'credit', balance: 3000, expires: '2027-01', currency: 'USD', blocked: false },
    { id: '2202 •• 5555', name: 'Накопительная', type: 'debit', balance: 56000, expires: '2026-12', currency: 'RUB', blocked: true },
    { id: '2200 •• 6666', name: 'Мир', type: 'debit', balance: 7300, expires: '2029-05', currency: 'RUB', blocked: false },
  ];

  const list = [
    {
      key: 'cards',
      title: 'Пример: выбор карт',
      extra: {
        description: 'Подбор карт для оплаты: действующие, не заблокированные, кредитные только если разрешены, с балансом не меньше минимального.',
        scenarios: [
          { name: 'по умолчанию', params: {}, expect: ['4276 •• 1111', '2200 •• 6666'] },
          { name: 'кредитные разрешены, минимум 10000', params: { creditAllowed: true, minAmount: 10000 }, expect: ['5536 •• 2222', '4276 •• 1111'] },
          { name: 'кредитные разрешены, минимума нет', params: { creditAllowed: true, hasMinAmount: false }, expect: ['5536 •• 2222', '4276 •• 1111', '2200 •• 6666', '4111 •• 4444'] },
        ],
      },
      make: () => [
        B('input', {
          label: 'Карты клиента',
          params: [
            { name: 'creditAllowed', type: 'boolean', value: false },
            { name: 'hasMinAmount', type: 'boolean', value: true },
            { name: 'minAmount', type: 'number', value: 5000 },
          ],
          data: JSON.stringify(CARDS, null, 1),
        }),
        B('filter', { label: 'Срок не истёк', cond: { join: 'and', rules: [R('field', 'expires', 'gte', 'today')] } }),
        B('filter', { label: 'Не заблокирована', cond: { join: 'and', rules: [R('field', 'blocked', 'isFalse')] } }),
        B('filter', {
          label: 'Кредитные разрешены?',
          cond: { join: 'or', rules: [R('param', 'creditAllowed', 'isTrue'), R('field', 'type', 'ne', 'const', 'credit')] },
        }),
        B('filter', {
          label: 'Хватает минимальной суммы',
          cond: { join: 'or', rules: [R('param', 'hasMinAmount', 'isFalse'), R('field', 'balance', 'gte', 'param', 'minAmount')] },
        }),
        B('assert', { label: 'Все карты в рублях', cond: { join: 'and', rules: [R('field', 'currency', 'eq', 'const', 'RUB')] } }),
        B('sort', { label: 'Сначала с большим балансом', expr: 'x.balance', order: 'desc' }),
      ],
    },
    {
      key: 'cardsBranch',
      title: 'Пример: карты с ветвлением',
      extra: {
        description: 'Кредитные и дебетовые карты проверяются по разным порогам.',
        scenarios: [
          { name: 'кредитные запрещены', params: { creditAllowed: false }, expect: ['4276 •• 1111', '2200 •• 6666'] },
          { name: 'высокий минимум для дебетовых', params: { minAmount: 10000 }, expect: ['5536 •• 2222', '4276 •• 1111'] },
        ],
      },
      make: () => [
        B('input', {
          label: 'Карты клиента',
          params: [
            { name: 'creditAllowed', type: 'boolean', value: true },
            { name: 'minAmount', type: 'number', value: 5000 },
            { name: 'creditMinAmount', type: 'number', value: 50000 },
          ],
          data: JSON.stringify(CARDS, null, 1),
        }),
        B('filter', { label: 'Действующие', cond: { join: 'and', rules: [R('field', 'expires', 'gte', 'today'), R('field', 'blocked', 'isFalse')] } }),
        B('branch', {
          label: 'Кредитная?',
          cond: { join: 'and', rules: [R('field', 'type', 'eq', 'const', 'credit')] },
          yes: [
            B('filter', { label: 'Кредитные разрешены', cond: { join: 'and', rules: [R('param', 'creditAllowed', 'isTrue')] } }),
            B('filter', { label: 'Лимит не меньше порога', cond: { join: 'and', rules: [R('field', 'balance', 'gte', 'param', 'creditMinAmount')] } }),
          ],
          no: [
            B('filter', { label: 'Баланс ≥ минимума', cond: { join: 'and', rules: [R('field', 'balance', 'gte', 'param', 'minAmount')] } }),
          ],
        }),
      ],
    },
    {
      key: 'cardsReturn',
      title: 'Пример: ранние возвраты',
      extra: {
        description: 'Как метод на Java с несколькими return: пустой список, предпочтённая карта, дебетовые с достаточным балансом, иначе кредитные (если разрешены).',
        scenarios: [
          { name: 'есть дебетовые с балансом', params: {}, expect: ['4276 •• 1111', '2200 •• 6666'] },
          { name: 'выбрана предпочтённая карта', params: { preferredId: '5536 •• 2222' }, expect: ['5536 •• 2222'] },
          { name: 'дебетовых не хватает, кредитные запрещены', params: { minAmount: 20000 }, expect: [] },
          { name: 'дебетовых не хватает, кредитные разрешены', params: { minAmount: 20000, creditAllowed: true }, expect: ['5536 •• 2222', '4111 •• 4444'] },
          { name: 'карт нет', params: {}, data: [], expect: [] },
        ],
      },
      make: () => [
        B('input', {
          label: 'Карты клиента',
          params: [
            { name: 'creditAllowed', type: 'boolean', value: false },
            { name: 'preferredId', type: 'string', value: '' },
            { name: 'minAmount', type: 'number', value: 5000 },
          ],
          data: JSON.stringify(CARDS, null, 1),
        }),
        B('return', { label: 'Карт нет: вернуть пустой', trigger: 'ifNone', value: 'empty', cond: { join: 'and', rules: [] } }),
        B('filter', { label: 'Действующие', cond: { join: 'and', rules: [R('field', 'expires', 'gte', 'today'), R('field', 'blocked', 'isFalse')] } }),
        B('return', { label: 'Есть предпочтённая: вернуть её', trigger: 'ifMatched', value: 'first', cond: { join: 'and', rules: [R('field', 'id', 'eq', 'param', 'preferredId')] } }),
        B('return', {
          label: 'Есть дебетовые с балансом: вернуть их', trigger: 'ifMatched', value: 'matched',
          cond: { join: 'and', rules: [R('field', 'type', 'eq', 'const', 'debit'), R('field', 'balance', 'gte', 'param', 'minAmount')] },
        }),
        B('return', { label: 'Кредитные запрещены: вернуть пустой', trigger: 'ifMatched', value: 'empty', cond: { join: 'and', rules: [R('param', 'creditAllowed', 'isFalse')] } }),
        B('filter', { label: 'Остаются кредитные', cond: { join: 'and', rules: [R('field', 'type', 'eq', 'const', 'credit')] } }),
      ],
    },
    {
      key: 'numbers',
      title: 'Пример: числа и выражения',
      make: () => [
        B('input', { label: 'Числа', data: '[7, 2, 9, 4, 12, 5, 8, 1]' }),
        B('filter', { label: 'Убрать единицы', condMode: 'code', expr: 'x > 1' }),
        B('branch', {
          label: 'Чётное?', condMode: 'code', expr: 'x % 2 === 0',
          yes: [B('map', { label: 'Половина', expr: 'x / 2' })],
          no: [B('map', { label: 'Утроить и +1', expr: 'x * 3 + 1' })],
        }),
        B('sort', { expr: 'x', order: 'asc' }),
        B('reduce', { label: 'Сумма', expr: 'acc + x', init: '0' }),
      ],
    },
  ];

  return { CARDS, list, byKey: Object.fromEntries(list.map(e => [e.key, e])) };
});
