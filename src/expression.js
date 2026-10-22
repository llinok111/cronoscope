/**
 * A nominal model of a cron expression.
 *
 * Why this exists at all: the execution engine (cron-parser) answers "which
 * instants fire", but not "which wall-clock readings did the author ask for".
 * An audit needs both halves, so this module builds the second one — the
 * intent — from the expression text, field by field, and keeps enough structure
 * (value sets, `L`/`#`/`H` flags, day-of-month vs day-of-week interaction) to
 * enumerate the readings the author *thought* they were writing.
 *
 * The model is intentionally independent of the engine. Divergence between the
 * two is a finding, not a bug in one of them.
 */

export const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@minutely': '* * * * *',
  '@secondly': '* * * * * *',
  '@weekdays': '0 0 * * 1-5',
  '@weekends': '0 0 * * 0,6',
};

const MONTH_NAMES = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const DOW_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

export const FIELD_SPECS = {
  second: { min: 0, max: 59, label: 'second' },
  minute: { min: 0, max: 59, label: 'minute' },
  hour: { min: 0, max: 23, label: 'hour' },
  dom: { min: 1, max: 31, label: 'day-of-month' },
  month: { min: 1, max: 12, label: 'month', names: MONTH_NAMES },
  dow: { min: 0, max: 7, label: 'day-of-week', names: DOW_NAMES },
};

/** Canonical field order for a 5-part expression. */
const FIVE = ['minute', 'hour', 'dom', 'month', 'dow'];
/** Canonical field order for a 6-part expression (cron-parser reads seconds first). */
const SIX = ['second', ...FIVE];

function toNum(raw, spec) {
  const upper = raw.toUpperCase();
  if (spec.names && Object.prototype.hasOwnProperty.call(spec.names, upper)) {
    return spec.names[upper];
  }
  if (!/^\d+$/.test(raw)) return NaN;
  return Number(raw);
}

/**
 * Parse one field token into a value set plus structural flags.
 * @returns {{values:Set<number>|null, restricted:boolean, last:boolean, lastDow:Set<number>, nth:Array<{dow:number,n:number}>, nondeterministic:boolean, errors:string[]}}
 */
export function parseField(token, spec) {
  const result = {
    values: null,
    restricted: false,
    last: false,
    lastDow: new Set(),
    nth: [],
    nondeterministic: false,
    errors: [],
  };
  const text = String(token ?? '').trim();
  if (text === '' ) {
    result.errors.push('empty field');
    return result;
  }
  if (text === '*' || text === '?') {
    result.values = null;
    return result;
  }
  if (/[Hh]/.test(text)) {
    // cron-parser substitutes a hashed value for H; the nominal reading of the
    // expression is therefore unknowable without the seed.
    result.nondeterministic = true;
    result.restricted = true;
    return result;
  }

  const values = new Set();
  let restricted = false;

  for (const part of text.split(',')) {
    const piece = part.trim();
    if (piece === '') {
      result.errors.push(`empty list element in "${text}"`);
      continue;
    }

    // Day-of-week "last Friday" form: 5L
    const dowLast = /^(\d{1})\s*[Ll]$/.exec(piece);
    if (dowLast && spec === FIELD_SPECS.dow) {
      const d = Number(dowLast[1]);
      if (d > 7) result.errors.push(`day-of-week out of range in "${piece}"`);
      else {
        result.lastDow.add(d === 7 ? 0 : d);
        restricted = true;
      }
      continue;
    }

    // Day-of-week "third Tuesday" form: 2#3
    const nth = /^(\d{1})\s*#\s*(\d)$/.exec(piece);
    if (nth) {
      if (spec !== FIELD_SPECS.dow) {
        result.errors.push(`"#" is only valid in day-of-week, got "${piece}"`);
        continue;
      }
      const dow = Number(nth[1]);
      const n = Number(nth[2]);
      if (dow > 7) result.errors.push(`day-of-week out of range in "${piece}"`);
      else if (n < 1) result.errors.push(`"#" index must be 1-5, got "${piece}"`);
      else {
        result.nth.push({ dow: dow === 7 ? 0 : dow, n });
        restricted = true;
      }
      continue;
    }

    if (piece === 'L' || piece === 'l') {
      if (spec !== FIELD_SPECS.dom) {
        result.errors.push(`"L" is only valid in day-of-month here, got "${piece}"`);
        continue;
      }
      result.last = true;
      restricted = true;
      continue;
    }

    // step / range / single
    const stepSplit = piece.split('/');
    if (stepSplit.length > 2) {
      result.errors.push(`too many "/" in "${piece}"`);
      continue;
    }
    const base = stepSplit[0];
    let step = 1;
    if (stepSplit.length === 2) {
      if (!/^\d+$/.test(stepSplit[1]) || Number(stepSplit[1]) === 0) {
        result.errors.push(`invalid step in "${piece}"`);
        continue;
      }
      step = Number(stepSplit[1]);
    }

    let lo;
    let hi;
    if (base === '*' || base === '?') {
      lo = spec.min;
      hi = spec.max;
      if (spec === FIELD_SPECS.dow) hi = 6; // * covers all seven days once; 7 is an alias
    } else if (base.includes('-')) {
      const [a, b] = base.split('-');
      lo = toNum(a, spec);
      hi = toNum(b, spec);
      if (Number.isNaN(lo) || Number.isNaN(hi)) {
        result.errors.push(`invalid range in "${piece}"`);
        continue;
      }
    } else {
      lo = toNum(base, spec);
      hi = stepSplit.length === 2 ? (spec === FIELD_SPECS.dow ? 6 : spec.max) : lo;
      if (Number.isNaN(lo)) {
        result.errors.push(`invalid value "${base}" in ${spec.label}`);
        continue;
      }
    }

    if (lo < spec.min || hi > spec.max || lo > hi) {
      result.errors.push(
        `${spec.label} out of range in "${piece}" (allowed ${spec.min}-${spec.max})`,
      );
      continue;
    }

    for (let v = lo; v <= hi; v += step) values.add(v);
    if (!(base === '*' || base === '?')) restricted = true;
    if (step > 1) restricted = true;
  }

  result.values = values;
  result.restricted = restricted;
  return result;
}

/**
 * Split and classify an expression, reproducing the engine's own arity
 * behaviour so that a malformed expression can be reported accurately.
 */
export function splitExpression(expression) {
  const raw = String(expression ?? '').trim();
  if (raw === '') return { raw, error: 'expression is empty', tokens: [] };
  const lower = raw.toLowerCase();
  if (MACROS[lower]) {
    const expanded = MACROS[lower];
    return {
      raw,
      macro: lower,
      expanded,
      tokens: expanded.split(/\s+/),
      arity: expanded.split(/\s+/).length,
      arityShift: 0,
    };
  }
  const tokens = raw.split(/\s+/);
  const arity = tokens.length;
  // cron-parser left-pads short expressions with "*" rather than rejecting
  // them (measured: "1 2 3 4" behaves exactly like "* 1 2 3 4"). We reproduce
  // that here so the audit can show the user what the engine will actually run.
  let arityShift = 0;
  let effective = tokens;
  if (arity > 0 && arity < 5) {
    arityShift = 5 - arity;
    effective = [...Array(arityShift).fill('*'), ...tokens];
  }
  return { raw, tokens, arity, arityShift, effectiveTokens: effective };
}

/**
 * Build the nominal model.
 * @param {string} expression
 */
export function parseExpression(expression) {
  const split = splitExpression(expression);
  if (split.error) {
    return { ok: false, errors: [split.error], expression: String(expression ?? '') };
  }

  const tokens = split.effectiveTokens ?? split.tokens;
  const order = tokens.length === 6 ? SIX : tokens.length === 5 ? FIVE : null;
  if (!order) {
    return {
      ok: false,
      expression: split.raw,
      errors: [
        tokens.length > 6
          ? `too many fields: ${tokens.length} (cron-parser accepts at most 6)`
          : `unrecognised field count: ${tokens.length}`,
      ],
      split,
      enumerable: false,
    };
  }

  const fields = {};
  const errors = [];
  for (let i = 0; i < order.length; i += 1) {
    const name = order[i];
    const parsed = parseField(tokens[i], FIELD_SPECS[name]);
    fields[name] = parsed;
    errors.push(...parsed.errors.map((e) => `${name}: ${e}`));
  }
  // Fields absent from a 5-part expression default to "all values".
  for (const name of ['second']) {
    if (!fields[name]) {
      fields[name] = parseField('0', FIELD_SPECS[name]);
    }
  }

  // cron accepts 7 as "Sunday"; normalise it so day matching only deals with 0-6.
  const dowField = fields.dow;
  if (dowField && dowField.values && dowField.values.has(7)) {
    dowField.values.delete(7);
    dowField.values.add(0);
  }

  const nondeterministic = Object.values(fields).some((f) => f.nondeterministic);
  const domRestricted = fields.dom.restricted;
  const dowRestricted = fields.dow.restricted;
  const hasLast = fields.dom.last;
  const hasNth = fields.dow.nth.length > 0;
  const hasLastDow = fields.dow.lastDow.size > 0;

  const normalized =
    (tokens.length === 6 ? `${tokens[0]} ` : '') +
    tokens.slice(tokens.length === 6 ? 1 : 0).join(' ');

  return {
    ok: errors.length === 0,
    expression: split.raw,
    macro: split.macro ?? null,
    normalized,
    arity: split.arity,
    arityShift: split.arityShift ?? 0,
    tokens,
    fields,
    flags: {
      domRestricted,
      dowRestricted,
      dayRule: domRestricted && dowRestricted ? 'or' : 'and',
      hasLast,
      hasNth,
      hasLastDow,
      nondeterministic,
      hasQuestionMark: split.raw.includes('?'),
    },
    enumerable: !nondeterministic && errors.length === 0,
    errors,
    split,
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Does the nominal model fire on this calendar date (in the job's zone)? */
export function matchesDate(model, { year, month, day }) {
  const { fields, flags } = model;
  if (fields.month.values && !fields.month.values.has(month)) return false;

  const dim = daysInMonth(year, month);
  let domOk = true;
  if (flags.domRestricted) {
    domOk = Boolean(fields.dom.values && fields.dom.values.has(day));
    if (flags.hasLast && day === dim) domOk = true;
  }

  let dowOk = true;
  if (flags.dowRestricted) {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    dowOk = Boolean(fields.dow.values && fields.dow.values.has(dow));
    if (!dowOk && flags.hasLastDow && fields.dow.lastDow.has(dow)) {
      dowOk = day + 7 > dim; // last occurrence of that weekday in the month
    }
    if (!dowOk && flags.hasNth) {
      const nth = Math.floor((day - 1) / 7) + 1;
      dowOk = fields.dow.nth.some((n) => n.dow === dow && n.n === nth);
    }
  }

  if (flags.domRestricted && flags.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** Sorted values of a field, with `null` (any) materialised as the full range. */
function fieldValues(field, spec) {
  if (field.values) return [...field.values].sort((a, b) => a - b);
  const out = [];
  for (let v = spec.min; v <= spec.max; v += 1) out.push(v);
  return out;
}

/** Wall-clock slots the model asks for on one date. Empty when it does not match. */
export function enumerateSlots(model, date) {
  if (!model.enumerable) return [];
  if (!matchesDate(model, date)) return [];
  const hours = fieldValues(model.fields.hour, FIELD_SPECS.hour);
  const minutes = fieldValues(model.fields.minute, FIELD_SPECS.minute);
  const seconds = fieldValues(model.fields.second, FIELD_SPECS.second);
  const slots = [];
  for (const hour of hours) {
    for (const minute of minutes) {
      for (const second of seconds) slots.push({ ...date, hour, minute, second });
    }
  }
  return slots;
}

/** Upper bound of occurrences per matching day. */
export function slotsPerDay(model) {
  if (!model.enumerable) return null;
  const h = model.fields.hour.values ? model.fields.hour.values.size : 24;
  const m = model.fields.minute.values ? model.fields.minute.values.size : 60;
  const s = model.fields.second.values ? model.fields.second.values.size : 1;
  return h * m * s;
}

/** True when every day in a month matches (no dom/dow/month restriction). */
export function isDailyRegular(model) {
  const { flags } = model;
  return !flags.domRestricted && !flags.dowRestricted && !model.fields.month.restricted;
}

/**
 * Materialised value list for a field: `null` (any) becomes the full range.
 * Day-of-week stops at 6 — 7 is an alias for Sunday, not a separate day.
 */
export function fieldValueList(model, name) {
  const field = model.fields?.[name];
  const spec = FIELD_SPECS[name];
  if (!field || !spec) return [];
  if (field.values) return [...field.values].sort((a, b) => a - b);
  const max = name === 'dow' ? 6 : spec.max;
  const out = [];
  for (let v = spec.min; v <= max; v += 1) out.push(v);
  return out;
}

/** True when the field means "every value" (written as `*` or `?`). */
export function isAnyValue(model, name) {
  const field = model.fields?.[name];
  if (!field) return true;
  return field.values === null && !field.restricted;
}
