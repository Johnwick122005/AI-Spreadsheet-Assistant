/*======================================================================
  Formula Engine — parser, evaluator, and function library

  Supports:
    - A1 references, absolute references ($A$1), ranges (A1:B10)
    - Cross-sheet references (Sheet2!A1, 'Sheet 2'!A1:B4)
    - 100+ functions across math, stats, text, dates, lookup, logic
    - Error values, cycle detection, formula translation for fill/copy

  The engine is deliberately dependency-free and synchronous. The grid
  supplies the workbook (all sheets) so a formula can read another sheet.
======================================================================*/

const MAX_PARSE_CACHE = 1200;
const PARSE_CACHE = new Map();

const ERROR_VALUES = new Set([
  '#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!',
  '#VALUE!', '#CYCLE', '#ERROR',
]);

function isError(value) {
  return typeof value === 'string' && value.startsWith('#');
}

function isNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' && value.trim() !== '') return !isNaN(Number(value));
  return false;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === '' || value === null || value === undefined) return 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return 0;
    const n = Number(trimmed.replace(/,/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '#NUM!';
    return String(value);
  }
  return String(value);
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (value === '' || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const upper = value.trim().toUpperCase();
    if (upper === 'TRUE') return true;
    if (upper === 'FALSE') return false;
    return upper !== '';
  }
  return !!value;
}

function normalize(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '#VALUE!';
    if (!Number.isFinite(value)) return '#NUM!';
    return value;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '#VALUE!' : value.toISOString().slice(0, 10);
  }
  return value;
}

function flatten(args) {
  return args.flat(Infinity);
}

function numericValues(args) {
  const out = [];
  for (const value of flatten(args)) {
    if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
    else if (typeof value === 'string' && value.trim() !== '' && !isError(value)) {
      const n = Number(value.replace(/,/g, ''));
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

function textValues(args) {
  return flatten(args).filter((value) => !isError(value));
}

function parseAddress(address) {
  const match = String(address || '').match(/^\$?([A-Za-z]+)\$?(\d+)$/);
  if (!match) return null;
  return { col: match[1].toUpperCase(), row: parseInt(match[2], 10) };
}

function columnIndex(col) {
  return [...String(col).toUpperCase()].reduce(
    (n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0,
  ) - 1;
}

function columnLetter(index) {
  let n = index;
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel's 1900 date system (with the conventional 1899-12-30 epoch).
    const ms = Math.round((value - 25569) * 86400000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const d = new Date(Date.UTC(
      Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]),
      Number(iso[4] || 0), Number(iso[5] || 0), Number(iso[6] || 0),
    ));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(value) {
  if (!value) return '#VALUE!';
  return value.toISOString().slice(0, 10);
}

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T`
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function utcDate(year, month, day) {
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateNumber(value) {
  const d = parseDate(value);
  if (!d) return null;
  return { d, time: d.getTime() };
}

function compareValues(a, b) {
  if (isError(a)) return { error: a };
  if (isError(b)) return { error: b };
  if (a === '' && b === '') return 0;
  const aNum = typeof a === 'number' ? a : (typeof a === 'string' && isNumeric(a) ? Number(a) : null);
  const bNum = typeof b === 'number' ? b : (typeof b === 'string' && isNumeric(b) ? Number(b) : null);
  if (aNum !== null && bNum !== null) return aNum === bNum ? 0 : (aNum < bNum ? -1 : 1);
  const aText = toText(a).toLowerCase();
  const bText = toText(b).toLowerCase();
  return aText === bText ? 0 : (aText < bText ? -1 : 1);
}

function wildcardPattern(pattern) {
  let out = '^';
  for (const ch of String(pattern)) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$', 'i');
}

function criterionMatcher(criterion) {
  if (typeof criterion === 'number' || typeof criterion === 'boolean') {
    return (value) => compareValues(value, criterion) === 0;
  }
  const raw = String(criterion ?? '');
  const match = raw.match(/^(<=|>=|<>|=|<|>)([\s\S]*)$/);
  const op = match ? match[1] : '=';
  const rhsText = match ? match[2] : raw;
  const rhsNumber = rhsText.trim() !== '' && !isNaN(Number(rhsText)) ? Number(rhsText) : null;
  const wildcard = rhsText.includes('*') || rhsText.includes('?');
  const pattern = wildcard ? wildcardPattern(rhsText) : null;

  return (value) => {
    if (op === '=' || op === '<>') {
      let equal;
      if (wildcard && typeof value === 'string') equal = pattern.test(value);
      else if (rhsNumber !== null && isNumeric(value)) equal = Number(value) === rhsNumber;
      else equal = compareValues(value, rhsText) === 0;
      return op === '=' ? equal : !equal;
    }
    const cmp = compareValues(value, rhsNumber !== null ? rhsNumber : rhsText);
    if (cmp && cmp.error) return false;
    switch (op) {
      case '<': return cmp < 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '>=': return cmp >= 0;
      default: return false;
    }
  };
}

function matrixOf(range) {
  const meta = range && range.__range;
  if (!meta) return [Array.isArray(range) ? range.slice() : [range]];
  const rows = [];
  for (let r = 0; r < meta.rows; r++) {
    rows.push(range.slice(r * meta.cols, (r + 1) * meta.cols));
  }
  return rows;
}

function rangeSize(range) {
  const meta = range && range.__range;
  if (meta) return { rows: meta.rows, cols: meta.cols };
  return { rows: 1, cols: Array.isArray(range) ? range.length : 1 };
}

function matchIndex(search, values, mode = 0) {
  let best = null;
  for (let i = 0; i < values.length; i++) {
    const cmp = compareValues(values[i], search);
    if (cmp && cmp.error) continue;
    if (mode === 0) {
      if (cmp === 0) return i + 1;
    } else if (mode > 0) {
      if (cmp <= 0) best = i + 1;
      else break;
    } else if (cmp >= 0) {
      best = i + 1;
    } else {
      break;
    }
  }
  return best;
}

function textFormat(value, format) {
  const fmt = String(format ?? '');
  const numeric = typeof value === 'number' ? value : Number(toText(value).replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return toText(value);
  if (/%/.test(fmt)) {
    const decimals = (fmt.split('.')[1] || '').replace(/[^0#]/g, '').length;
    return `${(numeric * 100).toFixed(decimals)}%`;
  }
  if (/[$₹€£]/.test(fmt)) {
    const symbol = fmt.match(/[$₹€£]/)[0];
    const decimals = (fmt.split('.')[1] || '').replace(/[^0#]/g, '').length;
    const sign = numeric < 0 ? '-' : '';
    return `${sign}${symbol}${Math.abs(numeric).toLocaleString('en-US', {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    })}`;
  }
  if (/[ymd]/i.test(fmt)) {
    const d = parseDate(value);
    if (d) {
      if (/yyyy/i.test(fmt) && /mm/i.test(fmt) && /dd/i.test(fmt)) return formatDate(d);
      return d.toLocaleDateString('en-US');
    }
  }
  const decimals = (fmt.split('.')[1] || '').replace(/[^0#]/g, '').length;
  const useCommas = /#,##/.test(fmt);
  return numeric.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: useCommas,
  });
}

function pmt(rate, nper, pv, fv = 0, type = 0) {
  const r = Number(rate);
  const n = Number(nper);
  const p = Number(pv);
  const f = Number(fv);
  const t = type ? 1 : 0;
  if (n === 0) return '#DIV/0!';
  if (r === 0) return -(p + f) / n;
  const factor = Math.pow(1 + r, n);
  return -(r * (p * factor + f)) / ((factor - 1) * (1 + r * t));
}

const FUNCTIONS = {
  /* ---------- Math ---------- */
  SUM: (...args) => numericValues(args).reduce((a, b) => a + b, 0),
  PRODUCT: (...args) => {
    const nums = numericValues(args);
    return nums.length ? nums.reduce((a, b) => a * b, 1) : 0;
  },
  SUMPRODUCT: (...args) => {
    const arrays = args.map((a) => flatten([a]));
    if (!arrays.length) return 0;
    const length = arrays[0].length;
    if (arrays.some((a) => a.length !== length)) return '#VALUE!';
    let total = 0;
    for (let i = 0; i < length; i++) {
      let product = 1;
      for (const arr of arrays) {
        const n = toNumber(arr[i]);
        if (!Number.isFinite(n)) { product = 0; break; }
        product *= n;
      }
      total += product;
    }
    return total;
  },
  ABS: (value) => Math.abs(toNumber(value)),
  ROUND: (value, places = 0) => {
    const p = Math.trunc(toNumber(places));
    const factor = Math.pow(10, p);
    return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor;
  },
  ROUNDUP: (value, places = 0) => {
    const p = Math.trunc(toNumber(places));
    const factor = Math.pow(10, p);
    return Math.ceil((toNumber(value) - Number.EPSILON) * factor) / factor;
  },
  ROUNDDOWN: (value, places = 0) => {
    const p = Math.trunc(toNumber(places));
    const factor = Math.pow(10, p);
    return Math.floor((toNumber(value) + Number.EPSILON) * factor) / factor;
  },
  INT: (value) => Math.floor(toNumber(value)),
  TRUNC: (value, places = 0) => {
    const factor = Math.pow(10, Math.trunc(toNumber(places)));
    return Math.trunc(toNumber(value) * factor) / factor;
  },
  MOD: (a, b) => {
    const divisor = toNumber(b);
    if (divisor === 0) return '#DIV/0!';
    return ((toNumber(a) % divisor) + divisor) % divisor;
  },
  POWER: (a, b) => Math.pow(toNumber(a), toNumber(b)),
  SQRT: (value) => {
    const n = toNumber(value);
    return n < 0 ? '#NUM!' : Math.sqrt(n);
  },
  EXP: (value) => Math.exp(toNumber(value)),
  LN: (value) => {
    const n = toNumber(value);
    return n <= 0 ? '#NUM!' : Math.log(n);
  },
  LOG: (value, base = 10) => {
    const n = toNumber(value);
    const b = toNumber(base);
    return n <= 0 || b <= 0 || b === 1 ? '#NUM!' : Math.log(n) / Math.log(b);
  },
  LOG10: (value) => {
    const n = toNumber(value);
    return n <= 0 ? '#NUM!' : Math.log10(n);
  },
  PI: () => Math.PI,
  RAND: () => Math.random(),
  RANDBETWEEN: (low, high) => {
    const a = Math.ceil(toNumber(low));
    const b = Math.floor(toNumber(high));
    if (a > b) return '#NUM!';
    return Math.floor(Math.random() * (b - a + 1)) + a;
  },
  SIGN: (value) => Math.sign(toNumber(value)),
  CEILING: (value, significance = 1) => {
    const s = toNumber(significance);
    if (s === 0) return 0;
    return Math.ceil(toNumber(value) / s) * s;
  },
  FLOOR: (value, significance = 1) => {
    const s = toNumber(significance);
    if (s === 0) return '#DIV/0!';
    return Math.floor(toNumber(value) / s) * s;
  },
  GCD: (...args) => {
    const nums = numericValues(args).map((n) => Math.abs(Math.trunc(n)));
    const gcd2 = (a, b) => (b === 0 ? a : gcd2(b, a % b));
    return nums.reduce((a, b) => gcd2(a, b), 0);
  },
  LCM: (...args) => {
    const nums = numericValues(args).map((n) => Math.abs(Math.trunc(n)));
    const gcd2 = (a, b) => (b === 0 ? a : gcd2(b, a % b));
    return nums.reduce((a, b) => (a && b ? Math.abs(a * b) / gcd2(a, b) : 0), 1);
  },
  FACT: (value) => {
    const n = Math.trunc(toNumber(value));
    if (n < 0) return '#NUM!';
    let out = 1;
    for (let i = 2; i <= n; i++) out *= i;
    return out;
  },

  /* ---------- Statistics ---------- */
  AVERAGE: (...args) => {
    const nums = numericValues(args);
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : '#DIV/0!';
  },
  MIN: (...args) => {
    const nums = numericValues(args);
    return nums.length ? Math.min(...nums) : 0;
  },
  MAX: (...args) => {
    const nums = numericValues(args);
    return nums.length ? Math.max(...nums) : 0;
  },
  COUNT: (...args) => numericValues(args).length,
  COUNTA: (...args) => flatten(args).filter((v) => v !== '' && v !== null && v !== undefined).length,
  COUNTBLANK: (range) => flatten([range]).filter((v) => v === '' || v === null || v === undefined).length,
  MEDIAN: (...args) => {
    const nums = numericValues(args).sort((a, b) => a - b);
    if (!nums.length) return '#NUM!';
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  },
  MODE: (...args) => {
    const nums = numericValues(args);
    const counts = new Map();
    nums.forEach((n) => counts.set(n, (counts.get(n) || 0) + 1));
    let best = null;
    let bestCount = 0;
    counts.forEach((count, value) => {
      if (count > bestCount) { best = value; bestCount = count; }
    });
    return bestCount > 1 ? best : '#N/A';
  },
  STDEV: (...args) => {
    const nums = numericValues(args);
    if (nums.length < 2) return '#DIV/0!';
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    return Math.sqrt(nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (nums.length - 1));
  },
  STDEVP: (...args) => {
    const nums = numericValues(args);
    if (!nums.length) return '#DIV/0!';
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    return Math.sqrt(nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length);
  },
  VAR: (...args) => {
    const nums = numericValues(args);
    if (nums.length < 2) return '#DIV/0!';
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    return nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (nums.length - 1);
  },
  VARP: (...args) => {
    const nums = numericValues(args);
    if (!nums.length) return '#DIV/0!';
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    return nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length;
  },
  LARGE: (range, k) => {
    const nums = numericValues([range]).sort((a, b) => b - a);
    const index = Math.trunc(toNumber(k));
    return index >= 1 && index <= nums.length ? nums[index - 1] : '#NUM!';
  },
  SMALL: (range, k) => {
    const nums = numericValues([range]).sort((a, b) => a - b);
    const index = Math.trunc(toNumber(k));
    return index >= 1 && index <= nums.length ? nums[index - 1] : '#NUM!';
  },
  RANK: (value, range, order = 0) => {
    const nums = numericValues([range]).sort((a, b) => (order ? a - b : b - a));
    const target = toNumber(value);
    const found = nums.findIndex((n) => n === target);
    return found === -1 ? '#N/A' : found + 1;
  },
  PERCENTILE: (range, k) => {
    const nums = numericValues([range]).sort((a, b) => a - b);
    const p = toNumber(k);
    if (!nums.length || p < 0 || p > 1) return '#NUM!';
    const index = (nums.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return nums[lower];
    return nums[lower] + (nums[upper] - nums[lower]) * (index - lower);
  },
  QUARTILE: (range, quart) => FUNCTIONS.PERCENTILE(range, toNumber(quart) / 4),

  /* ---------- Conditional aggregation ---------- */
  COUNTIF: (range, criterion) => {
    const match = criterionMatcher(criterion);
    return flatten([range]).filter((v) => match(v)).length;
  },
  COUNTIFS: (...args) => {
    if (args.length < 2 || args.length % 2) return '#VALUE!';
    const ranges = [];
    const matchers = [];
    for (let i = 0; i < args.length; i += 2) {
      ranges.push(flatten([args[i]]));
      matchers.push(criterionMatcher(args[i + 1]));
    }
    const length = ranges[0].length;
    if (ranges.some((r) => r.length !== length)) return '#VALUE!';
    let count = 0;
    for (let i = 0; i < length; i++) {
      if (matchers.every((m, j) => m(ranges[j][i]))) count++;
    }
    return count;
  },
  SUMIF: (range, criterion, sumRange = null) => {
    const values = flatten([range]);
    const sums = sumRange ? flatten([sumRange]) : values;
    const match = criterionMatcher(criterion);
    let total = 0;
    values.forEach((v, i) => {
      if (!match(v)) return;
      const n = toNumber(sums[i]);
      if (Number.isFinite(n)) total += n;
    });
    return total;
  },
  SUMIFS: (sumRange, ...args) => {
    const sums = flatten([sumRange]);
    if (args.length < 2 || args.length % 2) return '#VALUE!';
    let count = 0;
    const ranges = [];
    const matchers = [];
    for (let i = 0; i < args.length; i += 2) {
      ranges.push(flatten([args[i]]));
      matchers.push(criterionMatcher(args[i + 1]));
    }
    if (ranges.some((r) => r.length !== sums.length)) return '#VALUE!';
    let total = 0;
    for (let i = 0; i < sums.length; i++) {
      if (matchers.every((m, j) => m(ranges[j][i]))) {
        const n = toNumber(sums[i]);
        if (Number.isFinite(n)) { total += n; count++; }
      }
    }
    return total;
  },
  AVERAGEIF: (range, criterion, avgRange = null) => {
    const values = flatten([range]);
    const avgs = avgRange ? flatten([avgRange]) : values;
    const match = criterionMatcher(criterion);
    const nums = [];
    values.forEach((v, i) => {
      if (!match(v)) return;
      const n = toNumber(avgs[i]);
      if (Number.isFinite(n)) nums.push(n);
    });
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : '#DIV/0!';
  },
  AVERAGEIFS: (avgRange, ...args) => {
    const avgs = flatten([avgRange]);
    if (args.length < 2 || args.length % 2) return '#VALUE!';
    const ranges = [];
    const matchers = [];
    for (let i = 0; i < args.length; i += 2) {
      ranges.push(flatten([args[i]]));
      matchers.push(criterionMatcher(args[i + 1]));
    }
    if (ranges.some((r) => r.length !== avgs.length)) return '#VALUE!';
    const nums = [];
    for (let i = 0; i < avgs.length; i++) {
      if (matchers.every((m, j) => m(ranges[j][i]))) {
        const n = toNumber(avgs[i]);
        if (Number.isFinite(n)) nums.push(n);
      }
    }
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : '#DIV/0!';
  },

  /* ---------- Text ---------- */
  CONCATENATE: (...args) => flatten(args).map(toText).join(''),
  CONCAT: (...args) => flatten(args).map(toText).join(''),
  TEXTJOIN: (delimiter, ignoreEmpty, ...args) => {
    const parts = flatten(args).map(toText);
    return (toBool(ignoreEmpty) ? parts.filter((p) => p !== '') : parts).join(toText(delimiter));
  },
  LEFT: (text, count = 1) => toText(text).slice(0, Math.max(0, Math.trunc(toNumber(count)))),
  RIGHT: (text, count = 1) => {
    const s = toText(text);
    const n = Math.max(0, Math.trunc(toNumber(count)));
    return n === 0 ? '' : s.slice(-n);
  },
  MID: (text, start, count) => {
    const s = toText(text);
    const from = Math.max(1, Math.trunc(toNumber(start)));
    const n = Math.max(0, Math.trunc(toNumber(count)));
    return s.slice(from - 1, from - 1 + n);
  },
  LEN: (text) => toText(text).length,
  LOWER: (text) => toText(text).toLowerCase(),
  UPPER: (text) => toText(text).toUpperCase(),
  PROPER: (text) => toText(text).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  TRIM: (text) => toText(text).replace(/\s+/g, ' ').trim(),
  CLEAN: (text) => toText(text).replace(/[\u0000-\u001F]/g, ''),
  SUBSTITUTE: (text, oldText, newText, instance = null) => {
    const source = toText(text);
    const find = toText(oldText);
    const replace = toText(newText);
    if (!find) return source;
    if (instance === null || instance === '' || instance === undefined) {
      return source.split(find).join(replace);
    }
    const nth = Math.trunc(toNumber(instance));
    if (nth < 1) return '#VALUE!';
    let count = 0;
    let index = 0;
    while (index < source.length) {
      const found = source.indexOf(find, index);
      if (found === -1) return source;
      count++;
      if (count === nth) return source.slice(0, found) + replace + source.slice(found + find.length);
      index = found + find.length;
    }
    return source;
  },
  REPLACE: (text, start, count, newText) => {
    const s = toText(text);
    const from = Math.max(1, Math.trunc(toNumber(start)));
    const n = Math.max(0, Math.trunc(toNumber(count)));
    return s.slice(0, from - 1) + toText(newText) + s.slice(from - 1 + n);
  },
  FIND: (findText, withinText, start = 1) => {
    const needle = toText(findText);
    const haystack = toText(withinText);
    const from = Math.max(1, Math.trunc(toNumber(start)));
    const index = haystack.indexOf(needle, from - 1);
    return index === -1 ? '#VALUE!' : index + 1;
  },
  SEARCH: (findText, withinText, start = 1) => {
    const needle = toText(findText).toLowerCase();
    const haystack = toText(withinText).toLowerCase();
    const from = Math.max(1, Math.trunc(toNumber(start)));
    if (!needle.includes('*') && !needle.includes('?')) {
      const index = haystack.indexOf(needle, from - 1);
      return index === -1 ? '#VALUE!' : index + 1;
    }
    const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\?/g, '.'), 'i');
    const match = haystack.slice(from - 1).match(pattern);
    return match ? from + match.index : '#VALUE!';
  },
  EXACT: (a, b) => toText(a) === toText(b),
  VALUE: (text) => {
    const cleaned = toText(text).replace(/[$,%]/g, '').trim();
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return '#VALUE!';
    return toText(text).includes('%') ? n / 100 : n;
  },
  TEXT: (value, format) => textFormat(value, format),
  CHAR: (code) => String.fromCharCode(Math.trunc(toNumber(code))),
  CODE: (text) => {
    const s = toText(text);
    return s ? s.charCodeAt(0) : '#VALUE!';
  },
  UNICHAR: (code) => String.fromCodePoint(Math.trunc(toNumber(code))),
  UNICODE: (text) => {
    const s = toText(text);
    return s ? s.codePointAt(0) : '#VALUE!';
  },
  REPT: (text, count) => {
    const n = Math.trunc(toNumber(count));
    return n < 0 ? '#VALUE!' : toText(text).repeat(Math.min(n, 10000));
  },

  /* ---------- Dates ---------- */
  TODAY: () => todayLocal(),
  NOW: () => nowLocal(),
  DATE: (year, month, day) => {
    const d = utcDate(year, month, day);
    return d ? formatDate(d) : '#VALUE!';
  },
  YEAR: (value) => {
    const d = parseDate(value);
    return d ? d.getUTCFullYear() : '#VALUE!';
  },
  MONTH: (value) => {
    const d = parseDate(value);
    return d ? d.getUTCMonth() + 1 : '#VALUE!';
  },
  DAY: (value) => {
    const d = parseDate(value);
    return d ? d.getUTCDate() : '#VALUE!';
  },
  WEEKDAY: (value, type = 1) => {
    const d = parseDate(value);
    if (!d) return '#VALUE!';
    const day = d.getUTCDay() + 1;
    if (Number(type) === 2) return day === 1 ? 7 : day - 1;
    if (Number(type) === 3) return day === 1 ? 6 : day - 2;
    return day;
  },
  DAYS: (end, start) => {
    const a = parseDate(end);
    const b = parseDate(start);
    if (!a || !b) return '#VALUE!';
    return Math.round((a - b) / 86400000);
  },
  DATEDIF: (start, end, unit) => {
    const a = parseDate(start);
    const b = parseDate(end);
    if (!a || !b || a > b) return '#NUM!';
    const u = toText(unit).toUpperCase();
    if (u === 'D') return Math.floor((b - a) / 86400000);
    let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
    if (b.getUTCDate() < a.getUTCDate()) months--;
    if (u === 'M') return months;
    if (u === 'Y') return Math.floor(months / 12);
    if (u === 'MD') {
      if (b.getUTCDate() >= a.getUTCDate()) return b.getUTCDate() - a.getUTCDate();
      const prev = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0));
      return prev.getUTCDate() - a.getUTCDate() + b.getUTCDate();
    }
    if (u === 'YM') return months % 12;
    return '#NUM!';
  },
  EDATE: (start, months) => {
    const d = parseDate(start);
    if (!d) return '#VALUE!';
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + Math.trunc(toNumber(months)), d.getUTCDate()));
    return formatDate(target);
  },
  EOMONTH: (start, months = 0) => {
    const d = parseDate(start);
    if (!d) return '#VALUE!';
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + Math.trunc(toNumber(months)) + 1, 0));
    return formatDate(target);
  },
  NETWORKDAYS: (start, end) => {
    const a = parseDate(start);
    const b = parseDate(end);
    if (!a || !b) return '#VALUE!';
    let from = Math.min(a.getTime(), b.getTime());
    const to = Math.max(a.getTime(), b.getTime());
    let days = 0;
    while (from <= to) {
      const day = new Date(from).getUTCDay();
      if (day !== 0 && day !== 6) days++;
      from += 86400000;
    }
    return days;
  },

  /* ---------- Lookup ---------- */
  VLOOKUP: (search, table, column, sorted = true) => {
    const rows = matrixOf(table);
    if (!rows.length || !rows[0].length) return '#REF!';
    const col = Math.trunc(toNumber(column));
    if (col < 1 || col > rows[0].length) return '#REF!';
    let exact = -1;
    let approximate = -1;
    for (let i = 0; i < rows.length; i++) {
      const cmp = compareValues(rows[i][0], search);
      if (cmp && cmp.error) continue;
      if (cmp === 0) { exact = i; break; }
      if (cmp < 0) approximate = i;
      else if (sorted !== false) break;
    }
    let row = exact;
    if (row === -1 && sorted !== false) row = approximate;
    if (row === -1) return '#N/A';
    return rows[row][col - 1] ?? '';
  },
  HLOOKUP: (search, table, rowIndex, sorted = true) => {
    const rows = matrixOf(table);
    if (!rows.length || !rows[0].length) return '#REF!';
    const targetRow = Math.trunc(toNumber(rowIndex));
    if (targetRow < 1 || targetRow > rows.length) return '#REF!';
    const header = rows[0];
    let exact = -1;
    let approximate = -1;
    for (let c = 0; c < header.length; c++) {
      const cmp = compareValues(header[c], search);
      if (cmp && cmp.error) continue;
      if (cmp === 0) { exact = c; break; }
      if (cmp < 0) approximate = c;
      else if (sorted !== false) break;
    }
    let col = exact;
    if (col === -1 && sorted !== false) col = approximate;
    if (col === -1) return '#N/A';
    return rows[targetRow - 1][col] ?? '';
  },
  INDEX: (range, row, column = 1) => {
    const rows = matrixOf(range);
    const r = Math.trunc(toNumber(row));
    const c = Math.trunc(toNumber(column));
    if (!rows.length) return '#REF!';
    if (r < 1 || c < 1 || r > rows.length || c > rows[0].length) return '#REF!';
    return rows[r - 1][c - 1] ?? '';
  },
  MATCH: (search, range, mode = 0) => {
    const values = flatten([range]);
    const index = matchIndex(search, values, Math.trunc(toNumber(mode)));
    return index === null ? '#N/A' : index;
  },
  XLOOKUP: (search, lookupRange, returnRange, missing = '#N/A', matchMode = 0) => {
    const lookup = flatten([lookupRange]);
    const results = flatten([returnRange]);
    const mode = Math.trunc(toNumber(matchMode));
    let exact = -1;
    let closest = -1;
    for (let i = 0; i < lookup.length; i++) {
      const cmp = compareValues(lookup[i], search);
      if (cmp && cmp.error) continue;
      if (cmp === 0) { exact = i; break; }
      if (mode === 0 || mode === 2) continue;
      if (mode === -1 && cmp > 0) closest = i;
      if (mode === 1 && cmp < 0) closest = i;
    }
    const index = exact !== -1 ? exact : closest;
    if (index === -1) return missing;
    return results[index] ?? missing;
  },
  CHOOSE: (index, ...choices) => {
    const i = Math.trunc(toNumber(index));
    return i >= 1 && i <= choices.length ? choices[i - 1] : '#VALUE!';
  },
  ADDRESS: (row, column, absolute = 1) => {
    const r = Math.trunc(toNumber(row));
    const c = Math.trunc(toNumber(column));
    if (r < 1 || c < 1) return '#VALUE!';
    const abs = Math.trunc(toNumber(absolute));
    const col = columnLetter(c - 1);
    const rowText = String(r);
    if (abs === 4) return `${col}${rowText}`;
    if (abs === 2) return `${col}$${rowText}`;
    if (abs === 3) return `$${col}${rowText}`;
    return `$${col}$${rowText}`;
  },
  ROWS: (range) => rangeSize(range).rows,
  COLUMNS: (range) => rangeSize(range).cols,

  /* ---------- Logical / information ---------- */
  AND: (...args) => flatten(args).every(toBool),
  OR: (...args) => flatten(args).some(toBool),
  XOR: (...args) => flatten(args).filter(toBool).length % 2 === 1,
  NOT: (value) => !toBool(value),
  TRUE: () => true,
  FALSE: () => false,
  NA: () => '#N/A',
  ISBLANK: (value) => value === '' || value === null || value === undefined,
  ISNUMBER: (value) => typeof value === 'number' && Number.isFinite(value),
  ISTEXT: (value) => typeof value === 'string' && !isError(value),
  ISNONTEXT: (value) => typeof value !== 'string' || isError(value),
  ISLOGICAL: (value) => typeof value === 'boolean',
  ISERROR: (value) => isError(value),
  ISERR: (value) => isError(value) && value !== '#N/A',
  ISNA: (value) => value === '#N/A',
  TYPE: (value) => {
    if (typeof value === 'number') return 1;
    if (typeof value === 'string') return isError(value) ? 16 : 2;
    if (typeof value === 'boolean') return 4;
    if (Array.isArray(value)) return 64;
    return 1;
  },
  'ERROR.TYPE': (value) => {
    const map = {
      '#NULL!': 1, '#DIV/0!': 2, '#VALUE!': 3, '#REF!': 4,
      '#NAME?': 5, '#NUM!': 6, '#N/A': 7,
    };
    return map[value] ?? '#N/A';
  },

  /* ---------- Financial ---------- */
  PMT: (rate, nper, pv, fv = 0, type = 0) => pmt(rate, nper, pv, fv, type),
  FV: (rate, nper, payment, pv = 0, type = 0) => {
    const r = toNumber(rate);
    const n = toNumber(nper);
    const p = toNumber(payment);
    const present = toNumber(pv);
    const t = type ? 1 : 0;
    if (r === 0) return -(present + p * n);
    const factor = Math.pow(1 + r, n);
    return -(present * factor + p * (1 + r * t) * (factor - 1) / r);
  },
  PV: (rate, nper, payment, fv = 0, type = 0) => {
    const r = toNumber(rate);
    const n = toNumber(nper);
    const p = toNumber(payment);
    const future = toNumber(fv);
    const t = type ? 1 : 0;
    if (r === 0) return -(future + p * n);
    const factor = Math.pow(1 + r, n);
    return -(future + p * (1 + r * t) * (factor - 1) / r) / factor;
  },
  NPV: (rate, ...values) => {
    const r = toNumber(rate);
    const flows = numericValues(values);
    return flows.reduce((sum, value, index) => sum + value / Math.pow(1 + r, index + 1), 0);
  },
};

/*======================================================================
  Tokenizer
======================================================================*/

function readRef(formula, start) {
  const match = formula.slice(start).match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/);
  if (!match) return null;
  const row = parseInt(match[4], 10);
  if (!Number.isFinite(row) || row < 1) return null;
  return {
    col: match[2].toUpperCase(),
    row,
    absCol: match[1] === '$',
    absRow: match[3] === '$',
    end: start + match[0].length,
  };
}

function refNode(ref, sheet) {
  return {
    type: 'ref',
    sheet: sheet || null,
    col: ref.col,
    row: ref.row,
    absCol: ref.absCol,
    absRow: ref.absRow,
  };
}

function tokenize(formula) {
  const tokens = [];
  let i = 0;

  while (i < formula.length) {
    const ch = formula[i];

    if (/\s/.test(ch)) { i++; continue; }

    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < formula.length) {
        if (formula[j] === '"') {
          if (formula[j + 1] === '"') { text += '"'; j += 2; continue; }
          break;
        }
        text += formula[j++];
      }
      tokens.push({ type: 'str', value: text });
      i = j + 1;
      continue;
    }

    if (ch === '#') {
      const match = formula.slice(i).match(/^#(?:DIV\/0!|N\/A|NAME\?|REF!|VALUE!|NUM!|NULL!|CYCLE|ERROR)/i);
      if (match) {
        tokens.push({ type: 'error', value: match[0].toUpperCase() });
        i += match[0].length;
        continue;
      }
    }

    if (/[\d.]/.test(ch)) {
      const match = formula.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?/);
      if (match) {
        tokens.push({ type: 'num', value: parseFloat(match[0]) });
        i += match[0].length;
        continue;
      }
    }

    // Quoted sheet name: 'Sheet 2'!A1
    if (ch === "'") {
      let j = i + 1;
      let sheet = '';
      while (j < formula.length) {
        if (formula[j] === "'") {
          if (formula[j + 1] === "'") { sheet += "'"; j += 2; continue; }
          break;
        }
        sheet += formula[j++];
      }
      if (formula[j + 1] === '!') {
        const ref = readRef(formula, j + 2);
        if (ref) {
          tokens.push(refNode(ref, sheet));
          i = ref.end;
          if (formula[i] === ':') {
            const second = readRef(formula, i + 1);
            if (second) {
              const first = tokens.pop();
              tokens.push({
                type: 'range',
                sheet,
                from: { col: first.col, row: first.row, absCol: first.absCol, absRow: first.absRow },
                to: { col: second.col, row: second.row, absCol: second.absCol, absRow: second.absRow },
              });
              i = second.end;
            }
          }
          continue;
        }
      }
      i = j + 1;
      continue;
    }

    // Unquoted sheet name: Sheet2!A1
    const sheetMatch = formula.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\!/);
    if (sheetMatch) {
      const ref = readRef(formula, i + sheetMatch[0].length);
      if (ref) {
        tokens.push(refNode(ref, sheetMatch[1]));
        i = ref.end;
        if (formula[i] === ':') {
          const second = readRef(formula, i + 1);
          if (second) {
            const first = tokens.pop();
            tokens.push({
              type: 'range',
              sheet: sheetMatch[1],
              from: { col: first.col, row: first.row, absCol: first.absCol, absRow: first.absRow },
              to: { col: second.col, row: second.row, absCol: second.absCol, absRow: second.absRow },
            });
            i = second.end;
          }
        }
        continue;
      }
    }

    // Cell reference or range
    const ref = readRef(formula, i);
    if (ref) {
      const after = formula[ref.end] || '';
      if (after !== '(') {
        tokens.push(refNode(ref, null));
        i = ref.end;
        if (formula[i] === ':') {
          const second = readRef(formula, i + 1);
          if (second) {
            const first = tokens.pop();
            tokens.push({
              type: 'range',
              sheet: null,
              from: { col: first.col, row: first.row, absCol: first.absCol, absRow: first.absRow },
              to: { col: second.col, row: second.row, absCol: second.absCol, absRow: second.absRow },
            });
            i = second.end;
          }
        }
        continue;
      }
    }

    const wordMatch = formula.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (wordMatch) {
      const word = wordMatch[0];
      let j = i + word.length;
      while (j < formula.length && /\s/.test(formula[j])) j++;
      if (formula[j] === '(') {
        tokens.push({ type: 'func', value: word.toUpperCase() });
        i = j + 1;
        continue;
      }
      const upper = word.toUpperCase();
      if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ type: 'bool', value: upper === 'TRUE' });
      } else {
        tokens.push({ type: 'ident', value: word });
      }
      i += word.length;
      continue;
    }

    if ('+-*/^&%'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma' }); i++; continue; }
    if (ch === '=' || ch === '<' || ch === '>') {
      const two = formula.slice(i, i + 2);
      const op = ['<=', '>=', '<>'].includes(two) ? two : ch;
      tokens.push({ type: 'op', value: op });
      i += op.length;
      continue;
    }

    i++;
  }

  return tokens;
}

/*======================================================================
  Parser
======================================================================*/

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek() { return this.tokens[this.index]; }
  next() { return this.tokens[this.index++]; }

  expect(type) {
    const token = this.next();
    if (!token || token.type !== type) throw new Error(`Expected ${type}`);
    return token;
  }

  parse() {
    const node = this.parseComparison();
    if (this.peek()) throw new Error('Unexpected token');
    return node;
  }

  parseComparison() {
    let left = this.parseConcat();
    while (this.peek()?.type === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(this.peek().value)) {
      const op = this.next().value;
      left = { type: 'binary', op, left, right: this.parseConcat() };
    }
    return left;
  }

  parseConcat() {
    let left = this.parseAdditive();
    while (this.peek()?.type === 'op' && this.peek().value === '&') {
      this.next();
      left = { type: 'binary', op: '&', left, right: this.parseAdditive() };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.peek()?.type === 'op' && ['+', '-'].includes(this.peek().value)) {
      const op = this.next().value;
      left = { type: 'binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parsePower();
    while (this.peek()?.type === 'op' && ['*', '/'].includes(this.peek().value)) {
      const op = this.next().value;
      left = { type: 'binary', op, left, right: this.parsePower() };
    }
    return left;
  }

  parsePower() {
    const left = this.parseUnary();
    if (this.peek()?.type === 'op' && this.peek().value === '^') {
      this.next();
      return { type: 'binary', op: '^', left, right: this.parsePower() };
    }
    return left;
  }

  parseUnary() {
    if (this.peek()?.type === 'op' && ['+', '-'].includes(this.peek().value)) {
      const op = this.next().value;
      return { type: 'unary', op, value: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let node = this.parsePrimary();
    while (this.peek()?.type === 'op' && this.peek().value === '%') {
      this.next();
      node = { type: 'binary', op: '/', left: node, right: { type: 'num', value: 100 } };
    }
    return node;
  }

  parsePrimary() {
    const token = this.next();
    if (!token) throw new Error('Unexpected end of formula');

    if (['num', 'str', 'bool', 'error'].includes(token.type)) {
      return { type: token.type, value: token.value };
    }
    if (token.type === 'ref') return token;
    if (token.type === 'range') return token;
    if (token.type === 'ident') return { type: 'error', value: '#NAME?' };

    if (token.type === 'func') {
      const args = [];
      if (this.peek()?.type === 'rparen') {
        this.next();
        return { type: 'func', name: token.value, args };
      }
      while (true) {
        // An empty argument is allowed: IF(A1,,0)
        if (this.peek()?.type === 'comma') {
          args.push({ type: 'str', value: '' });
        } else {
          args.push(this.parseComparison());
        }
        const separator = this.peek();
        if (separator?.type === 'comma') { this.next(); continue; }
        if (separator?.type === 'rparen') { this.next(); break; }
        throw new Error('Expected comma or closing parenthesis');
      }
      return { type: 'func', name: token.value, args };
    }

    if (token.type === 'lparen') {
      const node = this.parseComparison();
      this.expect('rparen');
      return node;
    }

    throw new Error('Unexpected token');
  }
}

/*======================================================================
  Evaluation
======================================================================*/

function getSheetCells(sheetName, ctx) {
  if (!sheetName || sheetName === ctx.sheetName) return ctx.cells;
  return ctx.workbook && ctx.workbook[sheetName] ? ctx.workbook[sheetName].cells : null;
}

function evaluateRaw(raw, ctx) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw !== 'string') return raw;

  const key = ctx.address
    ? `${ctx.sheetName || ''}!${ctx.address}`
    : `${ctx.sheetName || ''}!${raw}`;

  if (ctx.visiting.has(key)) return '#CYCLE';
  ctx.visiting.add(key);

  try {
    if (!raw.startsWith('=')) {
      const trimmed = raw.trim();
      if (trimmed !== '' && !isNaN(Number(trimmed))) return Number(trimmed);
      return raw;
    }

    const formula = raw.slice(1).trim();
    if (!formula) return '';
    let ast = PARSE_CACHE.get(formula);
    if (!ast) {
      ast = new Parser(tokenize(formula)).parse();
      if (PARSE_CACHE.size > MAX_PARSE_CACHE) PARSE_CACHE.clear();
      PARSE_CACHE.set(formula, ast);
    }
    return normalize(evaluate(ast, ctx));
  } catch {
    return '#ERROR';
  } finally {
    ctx.visiting.delete(key);
  }
}

function resolveRef(node, ctx) {
  const sheetName = node.sheet || ctx.sheetName;
  const cells = getSheetCells(sheetName, ctx);
  if (!cells) return '#REF!';
  const addr = `${node.col}${node.row}`;
  const cell = cells[addr];
  if (!cell || cell.raw === '' || cell.raw === null || cell.raw === undefined) return '';
  return evaluateRaw(cell.raw, {
    ...ctx,
    cells,
    sheetName,
    address: addr,
  });
}

function expandRange(node, ctx) {
  const sheetName = node.sheet || ctx.sheetName;
  const cells = getSheetCells(sheetName, ctx);
  if (!cells) return ['#REF!'];

  const c1 = Math.min(columnIndex(node.from.col), columnIndex(node.to.col));
  const c2 = Math.max(columnIndex(node.from.col), columnIndex(node.to.col));
  const r1 = Math.min(node.from.row, node.to.row);
  const r2 = Math.max(node.from.row, node.to.row);

  const values = [];
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const addr = `${columnLetter(c)}${r}`;
      const cell = cells[addr];
      values.push(cell && cell.raw !== '' && cell.raw !== null && cell.raw !== undefined
        ? evaluateRaw(cell.raw, { ...ctx, cells, sheetName, address: addr })
        : '');
    }
  }

  Object.defineProperty(values, '__range', {
    value: {
      sheet: sheetName || '',
      col1: columnLetter(c1),
      row1: r1,
      col2: columnLetter(c2),
      row2: r2,
      rows: r2 - r1 + 1,
      cols: c2 - c1 + 1,
    },
  });
  return values;
}

function arithmetic(op, a, b) {
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (op === '&') return toText(a) + toText(b);

  if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
    const cmp = compareValues(a, b);
    if (cmp && cmp.error) return cmp.error;
    switch (op) {
      case '=': return cmp === 0;
      case '<>': return cmp !== 0;
      case '<': return cmp < 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '>=': return cmp >= 0;
      default: return false;
    }
  }

  const x = toNumber(a);
  const y = toNumber(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return '#VALUE!';
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': return y === 0 ? '#DIV/0!' : x / y;
    case '^': {
      const result = Math.pow(x, y);
      return Number.isFinite(result) ? result : '#NUM!';
    }
    default: return '#ERROR';
  }
}

function evaluate(node, ctx) {
  switch (node.type) {
    case 'num':
    case 'str':
    case 'bool':
    case 'error':
      return node.value;
    case 'ref':
      return resolveRef(node, ctx);
    case 'range':
      return expandRange(node, ctx);
    case 'unary': {
      const value = evaluate(node.value, ctx);
      if (isError(value)) return value;
      const n = toNumber(value);
      if (!Number.isFinite(n)) return '#VALUE!';
      return node.op === '-' ? -n : n;
    }
    case 'binary': {
      const left = evaluate(node.left, ctx);
      if (isError(left) && !['=', '<>'].includes(node.op)) return left;
      const right = evaluate(node.right, ctx);
      return arithmetic(node.op, left, right);
    }
    case 'func':
      return evaluateFunction(node, ctx);
    default:
      return '#ERROR';
  }
}

function evaluateFunction(node, ctx) {
  const name = node.name;
  const args = node.args;
  const evalArg = (index) => (args[index] ? evaluate(args[index], ctx) : '');

  // Lazy / error-aware functions are handled before generic error propagation.
  switch (name) {
    case 'IF': {
      const condition = evalArg(0);
      if (isError(condition)) return condition;
      return toBool(condition) ? evalArg(1) : evalArg(2);
    }
    case 'IFERROR': {
      const value = evalArg(0);
      return isError(value) ? evalArg(1) : value;
    }
    case 'IFNA': {
      const value = evalArg(0);
      return value === '#N/A' ? evalArg(1) : value;
    }
    case 'IFS': {
      for (let i = 0; i < args.length; i += 2) {
        const condition = evalArg(i);
        if (isError(condition)) return condition;
        if (toBool(condition)) return evalArg(i + 1);
      }
      return '#N/A';
    }
    case 'SWITCH': {
      const value = evalArg(0);
      if (isError(value)) return value;
      for (let i = 1; i < args.length; i += 2) {
        if (i + 1 >= args.length) return evalArg(i);
        if (compareValues(value, evalArg(i)) === 0) return evalArg(i + 1);
      }
      return '#N/A';
    }
    case 'CHOOSE': {
      const index = evalArg(0);
      if (isError(index)) return index;
      const i = Math.trunc(toNumber(index));
      return i >= 1 && i <= args.length - 1 ? evalArg(i) : '#VALUE!';
    }
    case 'AND':
    case 'OR': {
      const values = [];
      for (const arg of args) {
        const value = evaluate(arg, ctx);
        if (isError(value)) return value;
        values.push(value);
      }
      const flat = values.flat(Infinity);
      return name === 'AND' ? flat.every(toBool) : flat.some(toBool);
    }
    case 'ISERROR': return isError(evalArg(0));
    case 'ISERR': { const v = evalArg(0); return isError(v) && v !== '#N/A'; }
    case 'ISNA': return evalArg(0) === '#N/A';
    case 'ISBLANK': {
      const value = evalArg(0);
      return value === '' || value === null || value === undefined;
    }
    case 'ISNUMBER': {
      const value = evalArg(0);
      return typeof value === 'number' && Number.isFinite(value);
    }
    case 'ISTEXT': {
      const value = evalArg(0);
      return typeof value === 'string' && !isError(value);
    }
    case 'ISNONTEXT': {
      const value = evalArg(0);
      return typeof value !== 'string' || isError(value);
    }
    case 'ISLOGICAL': return typeof evalArg(0) === 'boolean';
    case 'TYPE': {
      const value = evalArg(0);
      if (typeof value === 'number') return 1;
      if (typeof value === 'string') return isError(value) ? 16 : 2;
      if (typeof value === 'boolean') return 4;
      return 1;
    }
    case 'NA': return '#N/A';
    case 'TRUE': return true;
    case 'FALSE': return false;
    case 'ERROR.TYPE': {
      const value = evalArg(0);
      const map = {
        '#NULL!': 1, '#DIV/0!': 2, '#VALUE!': 3, '#REF!': 4,
        '#NAME?': 5, '#NUM!': 6, '#N/A': 7,
      };
      return map[value] ?? '#N/A';
    }
    case 'ROW': {
      if (!args.length) {
        const parsed = parseAddress(ctx.address);
        return parsed ? parsed.row : 1;
      }
      if (args[0].type === 'ref') return args[0].row;
      if (args[0].type === 'range') return args[0].from.row;
      return '#VALUE!';
    }
    case 'COLUMN': {
      if (!args.length) {
        const parsed = parseAddress(ctx.address);
        return parsed ? columnIndex(parsed.col) + 1 : 1;
      }
      if (args[0].type === 'ref') return columnIndex(args[0].col) + 1;
      if (args[0].type === 'range') return columnIndex(args[0].from.col) + 1;
      return '#VALUE!';
    }
    case 'ISFORMULA': {
      if (!args.length || args[0].type !== 'ref') return false;
      const targetSheet = args[0].sheet || ctx.sheetName;
      const cells = getSheetCells(targetSheet, ctx);
      const raw = cells && cells[`${args[0].col}${args[0].row}`]?.raw;
      return typeof raw === 'string' && raw.startsWith('=');
    }
  }

  const values = [];
  for (const arg of args) {
    const value = evaluate(arg, ctx);
    if (isError(value)) return value;
    values.push(value);
  }

  const fn = FUNCTIONS[name];
  if (!fn) return '#NAME?';

  try {
    return normalize(fn(...values));
  } catch {
    return '#ERROR';
  }
}

/*======================================================================
  Public API
======================================================================*/

function computeCell(raw, cells, visiting = new Set(), context = {}) {
  const ctx = {
    cells: cells || {},
    sheetName: context.sheetName || '',
    address: context.address || '',
    workbook: context.workbook || null,
    visiting: visiting || new Set(),
    now: context.now || Date.now(),
  };
  return evaluateRaw(raw, ctx);
}

/* Translate relative references for fill/copy. Absolute components ($)
   stay put; everything else moves by the supplied row/column delta. */
function translateFormula(raw, deltaRow, deltaCol) {
  if (typeof raw !== 'string' || !raw.startsWith('=')) return raw;
  const parts = raw.split(/("(?:[^"]|"")*")/);
  return parts.map((part, index) => {
    if (index % 2 === 1) return part;
    return part.replace(
      /(^|[^A-Za-z0-9_.])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![\dA-Za-z_])(?!\s*\()/g,
      (match, prefix, absCol, col, absRow, rowText) => {
        const c = columnIndex(col) + (absCol ? 0 : deltaCol);
        const r = parseInt(rowText, 10) + (absRow ? 0 : deltaRow);
        if (c < 0 || r < 1) return `${prefix}#REF!`;
        return `${prefix}${absCol}${columnLetter(c)}${absRow}${r}`;
      },
    );
  }).join('');
}

export {
  computeCell,
  FUNCTIONS,
  tokenize,
  Parser,
  translateFormula,
  columnIndex,
  columnLetter,
  isError,
  isNumeric,
  toNumber,
  toText,
};
