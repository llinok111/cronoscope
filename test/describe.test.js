import { describe, it, expect } from 'vitest';
import { describe as describeCron, describeBoth, errorMessage, PRIMARY_LOCALES } from '../src/describe.js';

describe('description engines', () => {
  it('describes a simple schedule in both languages', () => {
    const en = describeCron('*/5 * * * *', { locale: 'en' });
    expect(en.ok).toBe(true);
    expect(en.text).toBe('Every 5 minutes');

    const zh = describeCron('*/5 * * * *', { locale: 'zh_CN' });
    expect(zh.ok).toBe(true);
    expect(zh.text).toBe('每隔 5 分钟');
  });

  it('returns both locales from describeBoth', () => {
    const both = describeBoth('30 2 * * *');
    expect(Object.keys(both).sort()).toEqual([...PRIMARY_LOCALES].sort());
    expect(both.en.text).toBe('At 02:30');
    expect(both.zh_CN.text).toBe('在02:30');
  });

  it('reports a 4-field expression as an error (the engine accepts it — that is the point)', () => {
    const result = describeCron('0 3 * *');
    expect(result.ok).toBe(false);
    expect(result.text).toBeNull();
    expect(result.error).toMatch(/only 4 parts/);
  });

  it('accepts a 7-field expression the engine rejects', () => {
    const result = describeCron('* * * * * * *');
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Every second');
  });

  it('rejects the H macro the engine supports', () => {
    const result = describeCron('H * * * *');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/H/);
  });

  it('describes L and # selectors', () => {
    expect(describeCron('0 23 L * *').text).toBe('At 23:00, on the last day of the month');
    expect(describeCron('0 9 * * 1#1').text).toBe('At 09:00, on the first Monday of the month');
  });
});

describe('error normalisation', () => {
  it('handles every shape cRonstrue can throw', () => {
    expect(errorMessage('Error: boom')).toBe('boom');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(undefined)).toMatch(/threw without a value/);
    expect(errorMessage(null)).toMatch(/threw without a value/);
    expect(errorMessage({ message: 'boom' })).toBe('boom');
    expect(errorMessage({ code: 1 })).toBe('{"code":1}');
  });

  it('never throws out of describe(), even for garbage input', () => {
    for (const input of ['', '   ', 'not a cron', '*'.repeat(40), '99 99 99 99 99']) {
      const result = describeCron(input);
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) expect(typeof result.error).toBe('string');
    }
  });
});
