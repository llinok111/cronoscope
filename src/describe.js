/**
 * Natural-language descriptions, via cRonstrue.
 *
 * Two things this wrapper exists for:
 *
 * 1. cRonstrue throws *strings*, not Error objects ("Error: Expression has only
 *    4 parts..."). Any caller doing `err.message` gets `undefined`. Everything
 *    here funnels through one normaliser so the audit can always report a
 *    usable message.
 * 2. The description engine and the execution engine disagree about what is
 *    legal (measured: it rejects the 4-part expression the engine silently
 *    accepts, and accepts a 7-part expression the engine rejects). The audit
 *    treats that disagreement as a finding, so the two engines are always
 *    called through wrappers with identical error shapes.
 */
import cronstrueIntl from 'cronstrue/i18n.js';

const cronstrue = cronstrueIntl?.default ?? cronstrueIntl;

/** Normalise any thrown value (Error, string, undefined) to a message string. */
export function errorMessage(thrown) {
  if (thrown == null) return 'the describer threw without a value';
  if (typeof thrown === 'string') return thrown.replace(/^Error:\s*/, '');
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown.message === 'string') return thrown.message;
  try {
    return JSON.stringify(thrown);
  } catch {
    return String(thrown);
  }
}

/**
 * @param {string} expression
 * @param {{locale?:string, use24HourTimeFormat?:boolean, verbose?:boolean}} [options]
 * @returns {{ok:boolean, text:string|null, error:string|null, locale:string}}
 */
export function describe(expression, options = {}) {
  const locale = options.locale ?? 'en';
  const opts = {
    locale,
    use24HourTimeFormat: options.use24HourTimeFormat ?? true,
    verbose: options.verbose ?? false,
    throwExceptionOnParseError: true,
    dayOfWeekStartIndexZero: true,
  };
  try {
    const text = cronstrue.toString(String(expression ?? ''), opts);
    return { ok: true, text: String(text), error: null, locale };
  } catch (thrown) {
    return { ok: false, text: null, error: errorMessage(thrown), locale };
  }
}

/** The two languages the report always carries. */
export const PRIMARY_LOCALES = ['en', 'zh_CN'];

/** Both descriptions at once, each independent (one may fail while the other works). */
export function describeBoth(expression) {
  const out = {};
  for (const locale of PRIMARY_LOCALES) out[locale] = describe(expression, { locale });
  return out;
}
