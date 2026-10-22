import { describe, it, expect } from 'vitest';
import {
  parseExpression,
  parseField,
  splitExpression,
  matchesDate,
  enumerateSlots,
  slotsPerDay,
  fieldValueList,
  isAnyValue,
  isDailyRegular,
  MACROS,
  FIELD_SPECS,
} from '../src/expression.js';

const values = (model, name) => fieldValueList(model, name);

describe('splitExpression / arity', () => {
  it('recognises every macro in the table', () => {
    for (const [macro, expansion] of Object.entries(MACROS)) {
      const split = splitExpression(macro);
      expect(split.macro).toBe(macro);
      expect(split.tokens.join(' ')).toBe(expansion);
    }
  });

  it('reproduces the engine left-pad for short expressions', () => {
    const four = splitExpression('0 3 * *');
    expect(four.arity).toBe(4);
    expect(four.arityShift).toBe(1);
    expect(four.effectiveTokens.join(' ')).toBe('* 0 3 * *');

    const three = splitExpression('1 2 3');
    expect(three.effectiveTokens.join(' ')).toBe('* * 1 2 3');
  });

  it('treats six fields as second-first', () => {
    const model = parseExpression('0 0 12 * * *');
    expect(model.ok).toBe(true);
    expect(model.normalized).toBe('0 0 12 * * *');
    expect(values(model, 'second')).toEqual([0]);
    expect(values(model, 'hour')).toEqual([12]);
  });

  it('refuses seven fields with a reason', () => {
    const model = parseExpression('0 0 0 1 1 * 2026');
    expect(model.ok).toBe(false);
    expect(model.enumerable).toBe(false);
    expect(model.errors[0]).toMatch(/too many fields/);
  });

  it('flags an empty expression', () => {
    expect(parseExpression('').ok).toBe(false);
    expect(parseExpression('   ').errors[0]).toMatch(/empty/);
  });
});

describe('field parsing', () => {
  it('expands ranges, lists and steps', () => {
    expect([...parseField('1-5', FIELD_SPECS.minute).values]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseField('1,2,3', FIELD_SPECS.minute).values]).toEqual([1, 2, 3]);
    expect([...parseField('*/15', FIELD_SPECS.minute).values]).toEqual([0, 15, 30, 45]);
    expect([...parseField('5-11/3', FIELD_SPECS.minute).values]).toEqual([5, 8, 11]);
    expect([...parseField('5/15', FIELD_SPECS.minute).values]).toEqual([5, 20, 35, 50]);
  });

  it('understands month and weekday names', () => {
    expect([...parseField('JAN-MAR', FIELD_SPECS.month).values]).toEqual([1, 2, 3]);
    expect([...parseField('MON,WED', FIELD_SPECS.dow).values]).toEqual([1, 3]);
    expect([...parseField('sun', FIELD_SPECS.dow).values]).toEqual([0]);
  });

  it('treats * and ? as unrestricted', () => {
    for (const token of ['*', '?']) {
      const field = parseField(token, FIELD_SPECS.hour);
      expect(field.values).toBeNull();
      expect(field.restricted).toBe(false);
    }
  });

  it('records L, # and last-weekday structure', () => {
    const last = parseField('L', FIELD_SPECS.dom);
    expect(last.last).toBe(true);
    expect(last.restricted).toBe(true);

    const nth = parseField('1#1', FIELD_SPECS.dow);
    expect(nth.nth).toEqual([{ dow: 1, n: 1 }]);

    const lastDow = parseField('5L', FIELD_SPECS.dow);
    expect([...lastDow.lastDow]).toEqual([5]);
  });

  it('rejects out-of-range values with a readable message', () => {
    expect(parseField('61', FIELD_SPECS.minute).errors[0]).toMatch(/out of range/);
    expect(parseField('0-99', FIELD_SPECS.hour).errors[0]).toMatch(/out of range/);
    expect(parseField('a', FIELD_SPECS.minute).errors[0]).toMatch(/invalid value/);
    expect(parseField('*/0', FIELD_SPECS.minute).errors[0]).toMatch(/invalid step/);
  });

  it('marks H as nondeterministic and unenumerable', () => {
    const model = parseExpression('H * * * *');
    expect(model.flags.nondeterministic).toBe(true);
    expect(model.enumerable).toBe(false);
  });
});

describe('day matching', () => {
  it('ORs day-of-month with day-of-week when both are restricted', () => {
    const model = parseExpression('0 0 1 * 1');
    expect(model.flags.dayRule).toBe('or');
    // January 2026: the 1st (Thursday) plus every Monday.
    const matching = [1, 2, 3, 4, 5, 6, 7, 8].filter((day) =>
      matchesDate(model, { year: 2026, month: 1, day }),
    );
    expect(matching).toEqual([1, 5]);
    expect(matchesDate(model, { year: 2026, month: 2, day: 1 })).toBe(true); // dom branch
    expect(matchesDate(model, { year: 2026, month: 2, day: 2 })).toBe(true); // Monday branch
    expect(matchesDate(model, { year: 2026, month: 2, day: 3 })).toBe(false);
  });

  it('ANDs when only one of them is restricted', () => {
    const model = parseExpression('0 0 * * 1');
    expect(model.flags.dayRule).toBe('and');
    expect(matchesDate(model, { year: 2026, month: 1, day: 5 })).toBe(true); // Monday
    expect(matchesDate(model, { year: 2026, month: 1, day: 6 })).toBe(false);
  });

  it('normalises day-of-week 7 to Sunday', () => {
    const model = parseExpression('0 0 * * 7');
    expect(values(model, 'dow')).toEqual([0]);
    expect(matchesDate(model, { year: 2026, month: 1, day: 4 })).toBe(true); // Sunday
  });

  it('handles the last day of the month including leap years', () => {
    const model = parseExpression('0 0 L * *');
    expect(matchesDate(model, { year: 2026, month: 2, day: 28 })).toBe(true);
    expect(matchesDate(model, { year: 2028, month: 2, day: 29 })).toBe(true);
    expect(matchesDate(model, { year: 2026, month: 2, day: 27 })).toBe(false);
  });

  it('handles nth weekday and last weekday selectors', () => {
    const firstMonday = parseExpression('0 9 * * 1#1');
    expect(matchesDate(firstMonday, { year: 2026, month: 3, day: 2 })).toBe(true);
    expect(matchesDate(firstMonday, { year: 2026, month: 3, day: 9 })).toBe(false);

    const lastFriday = parseExpression('0 9 * * 5L');
    expect(matchesDate(lastFriday, { year: 2026, month: 3, day: 27 })).toBe(true);
    expect(matchesDate(lastFriday, { year: 2026, month: 3, day: 20 })).toBe(false);
  });

  it('never matches 31 February', () => {
    const model = parseExpression('0 0 31 2 *');
    expect(matchesDate(model, { year: 2026, month: 2, day: 28 })).toBe(false);
  });
});

describe('slot enumeration', () => {
  it('counts the slots a day asks for', () => {
    expect(slotsPerDay(parseExpression('*/15 * * * *'))).toBe(96);
    expect(slotsPerDay(parseExpression('0 2 * * *'))).toBe(1);
    expect(slotsPerDay(parseExpression('* * * * *'))).toBe(1440);
    expect(slotsPerDay(parseExpression('*/20 * * * * *'))).toBe(3 * 60 * 24);
  });

  it('materialises slots in ascending wall-clock order', () => {
    const model = parseExpression('0 6,18 * * *');
    const slots = enumerateSlots(model, { year: 2026, month: 3, day: 1 });
    expect(slots.map((s) => `${s.hour}:${s.minute}`)).toEqual(['6:0', '18:0']);
  });

  it('returns nothing on a non-matching day', () => {
    const model = parseExpression('0 0 31 2 *');
    expect(enumerateSlots(model, { year: 2026, month: 2, day: 1 })).toEqual([]);
  });

  it('returns nothing for an unenumerable model', () => {
    expect(enumerateSlots(parseExpression('H * * * *'), { year: 2026, month: 1, day: 1 })).toEqual([]);
  });
});

describe('helpers', () => {
  it('distinguishes "any" from "every value listed explicitly"', () => {
    expect(isAnyValue(parseExpression('0 2 * * *'), 'hour')).toBe(false);
    expect(isAnyValue(parseExpression('0 2 * * *'), 'month')).toBe(true);
    expect(isAnyValue(parseExpression('0 0-23 * * *'), 'hour')).toBe(false);
  });

  it('marks a daily regular cadence', () => {
    expect(isDailyRegular(parseExpression('30 2 * * *'))).toBe(true);
    expect(isDailyRegular(parseExpression('0 2 1 * *'))).toBe(false);
    expect(isDailyRegular(parseExpression('0 2 * * 1'))).toBe(false);
  });

  it('expands macros into an enumerable model', () => {
    const model = parseExpression('@daily');
    expect(model.macro).toBe('@daily');
    expect(model.normalized).toBe('0 0 * * *');
    expect(enumerateSlots(model, { year: 2026, month: 1, day: 1 })).toHaveLength(1);
  });
});
