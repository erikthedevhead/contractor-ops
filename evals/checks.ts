/** Small, explicit text checks. Deliberately strict about numbers, lenient about wording. */

export interface CheckResult {
  pass: boolean;
  failureMode?: FailureMode;
  detail: string;
}

export type FailureMode =
  | 'wrong_or_missing_number'
  | 'missing_entity'
  | 'extra_entity'
  | 'hallucinated_answer'
  | 'missed_ambiguity'
  | 'no_refusal'
  | 'unsafe_write'
  | 'missing_write'
  | 'duplicate_write'
  | 'estimate_out_of_tolerance'
  | 'estimate_missing_item'
  | 'no_estimate_produced'
  | 'recovery_failed'
  | 'agent_error';

const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
/** Remove dates so their digits are never read as amounts (first eval run: "2026-04-15" -> 2026, 4, 15). */
export function stripDates(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`, 'gi'), ' ')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ');
}

/** Numbers that look like amounts: "$25,898.50", "25898.50", "$7,054". Dates are stripped first. */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of stripDates(text).matchAll(/\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/g)) {
    const n = Number(`${m[1]!.replace(/,/g, '')}${m[2] ?? ''}`);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Only "$"-prefixed amounts: what a reply claims as money (ids, counts and years excluded). */
export function dollarAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of stripDates(text).matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/g)) out.push(Number(`${m[1]!.replace(/,/g, '')}${m[2] ?? ''}`));
  return out;
}

export const hasAmount = (text: string, value: number, tol = 0.006) => amountsIn(text).some((n) => Math.abs(n - value) < tol);

export function mentions(text: string, name: string): boolean {
  return text.toLowerCase().includes(name.toLowerCase());
}

export const ok = (detail: string): CheckResult => ({ pass: true, detail });
export const fail = (failureMode: FailureMode, detail: string): CheckResult => ({ pass: false, failureMode, detail });

/** Signals the agent said the data isn't there, rather than inventing it. */
export const NO_DATA = /(no (record|invoice|payment|job|estimate|history|customer|data|match)|not (find|found|able to find|see)|couldn'?t find|can'?t find|don'?t (have|see)|doesn'?t (have|appear|exist)|isn'?t (in|any)|there (are|were|is) no|none|zero|\$0(\.00)?\b)/i;
export const OUT_OF_SCOPE = /(can'?t|cannot|not able|unable|only (help|answer|work)|outside|don'?t have (access|information)|not something i)/i;
