import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMinorCurrency, parseRupeesToMinor } from '../src/money.js';

test('rupee input converts decimal text to exact minor units', () => {
  assert.equal(parseRupeesToMinor('0.01'), 1);
  assert.equal(parseRupeesToMinor('25'), 2500);
  assert.equal(parseRupeesToMinor('1234.5'), 123450);
  assert.equal(parseRupeesToMinor('10.09'), 1009);
});

test('money input rejects invalid precision, zero, negatives and values over the API limit', () => {
  for (const value of ['0', '-1', '1.001', '1e3', '01.00', '1000000.01']) {
    assert.throws(() => parseRupeesToMinor(value));
  }
});

test('minor units display with exact paise and Indian digit grouping', () => {
  assert.equal(formatMinorCurrency('123456789', 'INR'), '₹12,34,567.89');
  assert.equal(formatMinorCurrency('1', 'INR'), '₹0.01');
  assert.equal(formatMinorCurrency('-125', 'INR'), '−₹1.25');
  assert.equal(formatMinorCurrency('not-money', 'INR'), '—');
});
