/*======================================================================
  Formula Engine — Tokenizer, Shunting-yard, Evaluator
  Supports: A1 refs, ranges (A1:B10), 20+ functions, cycle detection
======================================================================*/

const FUNCTIONS = {
  SUM: (...args) => {
    const nums = args.flat(Infinity).filter((x) => typeof x === 'number');
    return nums.length ? nums.reduce((a, b) => a + b, 0) : 0;
  },
  AVERAGE: (...args) => {
    const nums = args.flat(Infinity).filter((x) => typeof x === 'number');
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  },
  MIN: (...args) => {
    const nums = args.flat(Infinity).filter((x) => typeof x === 'number');
    return nums.length ? Math.min(...nums) : 0;
  },
  MAX: (...args) => {
    const nums = args.flat(Infinity).filter((x) => typeof x === 'number');
    return nums.length ? Math.max(...nums) : 0;
  },
  COUNT: (...args) => args.flat(Infinity).filter((x) => typeof x === 'number').length,
  COUNTA: (...args) => args.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== '').length,
  IF: (cond, t, f) => (cond ? t : f),
  AND: (...args) => args.every((x) => !!x),
  OR: (...args) => args.some((x) => !!x),
  NOT: (x) => !x,
  ROUND: (n, d = 0) => Number(Number(n).toFixed(d)),
  TEXT: (val, fmt) => {
    if (fmt === '"%"') return String(Math.round(Number(val) * 100)) + '%';
    return String(val);
  },
  TODAY: () => new Date().toISOString().split('T')[0],
  CONCATENATE: (...args) => args.join(''),
  UPPER: (s) => String(s).toUpperCase(),
  LOWER: (s) => String(s).toLowerCase(),
  LEN: (s) => String(s).length,
  TRIM: (s) => String(s).trim(),
  ABS: (n) => Math.abs(Number(n)),
  INT: (n) => Math.trunc(Number(n)),
};

const PRECEDENCE = {
  '(': 0, ')': 0, ',': 0,
  'u-': 8,
  'OR': 1, 'AND': 2, 'NOT': 3,
  '=': 4, '<>': 4, '<': 4, '>': 4, '<=': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6,
  '^': 7,
  'FUNC': 8,
};

function tokenize(formula) {
  const tokens = [];
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (/\s/.test(ch)) { i++; continue; }

    if (ch === '"') {
      let j = i + 1;
      while (j < formula.length && formula[j] !== '"') j++;
      tokens.push({ type: 'STRING', value: formula.slice(i + 1, j) });
      i = j + 1;
      continue;
    }

    if (/[\d.]/.test(ch)) {
      let j = i;
      while (j < formula.length && /[\d.]/.test(formula[j])) j++;
      tokens.push({ type: 'NUMBER', value: parseFloat(formula.slice(i, j)) });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < formula.length && /[A-Za-z0-9_]/.test(formula[j])) j++;
      const word = formula.slice(i, j);
      const next = formula[j] || '';

      // Function call: NAME(
      if (next === '(') {
        tokens.push({ type: 'FUNC', name: word.toUpperCase() });
        i = j + 1;
        tokens.push({ type: 'LPAREN', value: '(' });
        continue;
      }

      // Cell reference or range: word matches LETTERs followed by digits (e.g. B2, AB12)
      if (/^[A-Za-z]+\d+$/.test(word)) {
        const m = word.match(/^([A-Za-z]+)(\d+)$/);
        const col = m[1].toUpperCase();
        const row = m[2];
        const from = col + row;
        let to = null;
        if (formula[j] === ':') {
          // Range: first ref already consumed; parse the second ref
          let k = j + 1;
          let col2 = '', row2 = '';
          while (k < formula.length && /[A-Za-z]/.test(formula[k])) col2 += formula[k++];
          while (k < formula.length && /\d/.test(formula[k])) row2 += formula[k++];
          if (col2 && row2) {
            to = col2.toUpperCase() + row2;
            j = k;
          }
        }
        tokens.push(to ? { type: 'RANGE', from, to } : { type: 'REF', value: from });
        i = j;
        continue;
      }

      tokens.push({ type: 'IDENT', value: word });
      i = j;
      continue;
    }

    if ('+-*/^&(),=<>!'.includes(ch)) {
      if (ch === '<' && formula[i + 1] === '=') { tokens.push({ type: 'OP', value: '<=' }); i += 2; continue; }
      if (ch === '>' && formula[i + 1] === '=') { tokens.push({ type: 'OP', value: '>=' }); i += 2; continue; }
      if (ch === '<' && formula[i + 1] === '>') { tokens.push({ type: 'OP', value: '<>' }); i += 2; continue; }
      tokens.push({ type: 'OP', value: ch });
      i++;
      continue;
    }

    i++;
  }
  return tokens;
}

function toRPN(tokens) {
  const output = [];
  const stack = [];
  let lastWasValue = false;

  for (const tok of tokens) {
    if (tok.type === 'NUMBER' || tok.type === 'STRING' || tok.type === 'REF' || tok.type === 'RANGE') {
      output.push(tok);
      lastWasValue = true;
    } else if (tok.type === 'FUNC') {
      stack.push(tok);
      lastWasValue = false;
    } else if (tok.type === 'LPAREN') {
      stack.push(tok);
      lastWasValue = false;
    } else if (tok.value === ')') {
      while (stack.length && stack[stack.length - 1].value !== '(') output.push(stack.pop());
      stack.pop();
      if (stack.length && stack[stack.length - 1].type === 'FUNC') output.push(stack.pop());
      lastWasValue = true;
    } else if (tok.value === ',') {
      while (stack.length && stack[stack.length - 1].value !== '(') output.push(stack.pop());
      lastWasValue = false;
    } else if (tok.type === 'OP') {
      if (tok.value === '-' && !lastWasValue) {
        stack.push({ type: 'OP', value: 'u-' });
      } else {
        const p1 = PRECEDENCE[tok.value] ?? 0;
        while (stack.length) {
          const top = stack[stack.length - 1];
          if (top.value === '(') break;
          const p2 = PRECEDENCE[top.value] ?? 0;
          if (p2 >= p1) output.push(stack.pop());
          else break;
        }
        stack.push(tok);
      }
      lastWasValue = false;
    } else {
      stack.push(tok);
    }
  }
  while (stack.length) output.push(stack.pop());
  return output;
}

function resolveRef(address, cells, visiting) {
  const cell = cells[address];
  if (!cell) return '';
  return computeCell(cell.raw, cells, visiting ? new Set(visiting) : new Set());
}

function expandRange(from, to, cells, visiting) {
  const parse = (ref) => {
    const m = ref.match(/^([A-Z]+)(\d+)$/);
    return { col: m[1], row: parseInt(m[2], 10) };
  };
  const a = parse(from);
  const b = parse(to);
  const colIndex = (s) => [...s].reduce((n, ch) => n * 26 + (ch.toUpperCase().charCodeAt(0) - 64), 0);
  const indexToCol = (n) => {
    let s = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const c1 = colIndex(a.col);
  const c2 = colIndex(b.col);
  const r1 = Math.min(a.row, b.row);
  const r2 = Math.max(a.row, b.row);
  const values = [];
  for (let c = c1; c <= c2; c++) {
    for (let r = r1; r <= r2; r++) {
      values.push(resolveRef(indexToCol(c) + r, cells, visiting));
    }
  }
  return values;
}

function computeCell(raw, cells, visiting) {
  if (!raw) return '';
  if (typeof raw !== 'string') return raw;
  // Non-formula cell: coerce numeric strings to numbers (spreadsheet semantics)
  if (!raw.startsWith('=')) {
    const trimmed = raw.trim();
    if (trimmed !== '' && !isNaN(Number(trimmed))) return Number(trimmed);
    return raw;
  }
  if (visiting.has(raw)) return '#CYCLE';
  visiting.add(raw);

  const formula = raw.slice(1);
  let tokens;
  try { tokens = tokenize(formula); } catch { return '#ERROR'; }
  const rpn = toRPN(tokens);
  const stack = [];

  for (const tok of rpn) {
    if (tok.type === 'NUMBER') stack.push(tok.value);
    else if (tok.type === 'STRING') stack.push(tok.value);
    else if (tok.type === 'REF') stack.push(resolveRef(tok.value, cells, visiting));
    else if (tok.type === 'RANGE') stack.push(expandRange(tok.from, tok.to, cells, visiting));
    else if (tok.type === 'FUNC') {
      const fn = FUNCTIONS[tok.name];
      if (!fn) { stack.push('#NAME?'); continue; }
      const argCount = tok.name === 'IF' ? 3 : (tok.name === 'ROUND' ? 2 : Infinity);
      const args = [];
      for (let i = 0; i < argCount && stack.length; i++) args.unshift(stack.pop());
      const flat = args.flat(Infinity);
      const argErr = flat.find((x) => typeof x === 'string' && x.startsWith('#'));
      if (argErr) { stack.push(argErr); continue; }
      try { stack.push(fn(...args)); } catch { stack.push('#ERROR'); }
    } else if (tok.type === 'OP') {
      const isErr = (x) => typeof x === 'string' && x.startsWith('#');
      if (tok.value === 'u-') {
        const a = stack.pop();
        stack.push(isErr(a) ? a : -Number(a) || 0);
      } else {
        const b = stack.pop();
        const a = stack.pop();
        if (isErr(a)) stack.push(a);
        else if (isErr(b)) stack.push(b);
        else switch (tok.value) {
          case '+': stack.push(Number(a) + Number(b)); break;
          case '-': stack.push(Number(a) - Number(b)); break;
          case '*': stack.push(Number(a) * Number(b)); break;
          case '/': { const nb = Number(b); stack.push(nb === 0 || isNaN(nb) ? '#DIV/0!' : Number(a) / nb); break; }
          case '^': stack.push(Math.pow(Number(a), Number(b))); break;
          case '&': stack.push(String(a) + String(b)); break;
          case '=': stack.push(a === b); break;
          case '<>': stack.push(a !== b); break;
          case '<': stack.push(Number(a) < Number(b)); break;
          case '>': stack.push(Number(a) > Number(b)); break;
          case '<=': stack.push(Number(a) <= Number(b)); break;
          case '>=': stack.push(Number(a) >= Number(b)); break;
          default: stack.push('#ERROR');
        }
      }
    } else {
      stack.push('#ERROR');
    }
  }

  visiting.delete(raw);
  const result = stack.pop();
  return result === undefined ? '' : result;
}

export { computeCell, FUNCTIONS, tokenize, toRPN, resolveRef, expandRange };
