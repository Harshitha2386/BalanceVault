const MAX_AMOUNT_MINOR = 100_000_000n;

function parseRupeesToMinor(value) {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(normalized)) {
    throw new Error('Enter a valid amount with up to two decimal places.');
  }
  const [whole, fraction = ''] = normalized.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor <= 0n) throw new Error('Amount must be greater than zero.');
  if (minor > MAX_AMOUNT_MINOR) throw new Error('The maximum amount is ₹10,00,000.00.');
  return Number(minor);
}

function formatMinorCurrency(minor, currency = 'INR') {
  if (!/^-?\d+$/u.test(String(minor))) return '—';
  const amount = BigInt(minor);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const rupees = absolute / 100n;
  const paise = (absolute % 100n).toString().padStart(2, '0');
  const formattedRupees = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 0,
  }).format(rupees);
  return `${negative ? '−' : ''}${currency === 'INR' ? '₹' : `${currency} `}${formattedRupees}.${paise}`;
}

export { MAX_AMOUNT_MINOR, formatMinorCurrency, parseRupeesToMinor };
