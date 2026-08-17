/**
 * Pure fill-policy helpers. Keep invent-vs-skip rules here so vitest can
 * lock them without a browser. FormFiller must call these instead of
 * embedding "default Yes / first option / 25 years" heuristics.
 */

export const MAX_FIELDS_PER_FILL = 80;
export const MAX_BATCH_CHUNK = 10;
export const MAX_LLM_REQUESTS_PER_FILL = 40;
export const SCHEMA_VERSION = 2;

const CREDENTIAL_AUTOCOMPLETE =
  /(^|,)\s*(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)(\s|,|$)/i;

const CREDENTIAL_LABEL =
  /\b(password|passwd|passcode|ssn|social\s*security|cvv|cvc|otp|one[\s-]?time(\s+code|\s+password)?|credit\s*card|card\s*number)\b/i;

export function isSensitiveField(question: string): boolean {
  return /\b(race|ethnicit\w*|veteran|disab\w*|gender|sex(ual)?|religio\w*|orientation|citizenship)\b/i.test(
    question || ''
  );
}

export function isCredentialOrSecretField(
  el: Element | { type?: string; name?: string; id?: string; autocomplete?: string; placeholder?: string; getAttribute?: (name: string) => string | null },
  label: string = ''
): boolean {
  const type = String((el as HTMLInputElement).type || '').toLowerCase();
  if (type === 'password' || type === 'file') return true;

  const getAttr = (name: string): string => {
    const anyEl = el as HTMLInputElement;
    if (typeof anyEl.getAttribute === 'function') {
      return anyEl.getAttribute(name) || '';
    }
    return String((el as Record<string, unknown>)[name] || '');
  };

  const autocomplete = (getAttr('autocomplete') || (el as HTMLInputElement).autocomplete || '').toLowerCase();
  if (CREDENTIAL_AUTOCOMPLETE.test(autocomplete)) return true;

  const blob = [
    label,
    (el as HTMLInputElement).name,
    (el as HTMLInputElement).id,
    (el as HTMLInputElement).placeholder,
    getAttr('aria-label'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return CREDENTIAL_LABEL.test(blob);
}

export function isNoAnswer(value: unknown): boolean {
  const v = String(value ?? '').trim().toLowerCase();
  return !v || v === 'n/a' || v === 'na' || v === 'none' || v === 'null' || v === 'unknown' || v === 'skip';
}

/** Parse a numeric field. Never invent a default (no "25 years", no donation $10). */
export function parseNumericAnswer(value: string, _question: string = ''): number | null {
  const numVal = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(numVal)) return null;
  return numVal;
}

export function isMarketingOptIn(label: string): boolean {
  return /\b(newsletter|marketing|promotional|subscribe|sms|text\s+alerts?|job\s+alerts?)\b/i.test(label || '');
}

export function isTermsLikeLabel(label: string): boolean {
  const checkboxLabel = (label || '').toLowerCase();
  return (
    checkboxLabel.includes('agree') ||
    checkboxLabel.includes('accept') ||
    checkboxLabel.includes('terms') ||
    checkboxLabel.includes('conditions') ||
    checkboxLabel.includes('privacy') ||
    checkboxLabel.includes('policy') ||
    checkboxLabel.includes('read and') ||
    checkboxLabel.includes('i have read') ||
    checkboxLabel.includes('consent') ||
    checkboxLabel.includes('confirm') ||
    checkboxLabel.includes('acknowledge')
  );
}

export function isPositiveAnswer(value: string): boolean {
  const checkValue = (value || '').toLowerCase().trim();
  return (
    checkValue === 'yes' ||
    checkValue === 'true' ||
    checkValue === '1' ||
    checkValue === 'on' ||
    checkValue === 'checked' ||
    checkValue === 'agree' ||
    checkValue === 'accept'
  );
}

export function isNegativeAnswer(value: string): boolean {
  const checkValue = (value || '').toLowerCase().trim();
  return checkValue === 'no' || checkValue === 'false' || checkValue === '0' || checkValue === 'off' || checkValue === 'unchecked';
}

export type CheckboxAction = 'check' | 'uncheck' | 'leave';

export function checkboxAction(opts: {
  label: string;
  answer: string;
  currentlyWorkHere: boolean;
  autoAcceptTerms: boolean;
}): CheckboxAction {
  const { label, answer, currentlyWorkHere, autoAcceptTerms } = opts;

  if (isMarketingOptIn(label)) {
    return isPositiveAnswer(answer) ? 'check' : 'leave';
  }

  const currentlyWork =
    label.includes('currently work here') ||
    label.includes('current position') ||
    label.includes('present employer') ||
    label.includes('still working');
  if (currentlyWork) {
    return currentlyWorkHere ? 'check' : 'uncheck';
  }

  if (isTermsLikeLabel(label) && !isMarketingOptIn(label)) {
    if (isNegativeAnswer(answer)) return 'leave';
    if (autoAcceptTerms || isPositiveAnswer(answer)) return 'check';
    return 'leave';
  }

  if (isPositiveAnswer(answer)) return 'check';
  if (isNegativeAnswer(answer)) return 'uncheck';
  return 'leave';
}

/**
 * Only explicit [Entry: N] / [Position Entry: N] / [Education Entry: N] tags
 * (or "position/education entry N"). Bare "entry 2" / "re-entry 2" must not bind.
 */
export function extractEntryIndex(question: string): number | null {
  const entryMatch =
    question.match(/\[(?:Position|Education)\s+Entry:\s*(\d+)\]/i) ||
    question.match(/\[Entry:\s*(\d+)\]/i) ||
    question.match(/(?:position|education)\s+entry[:\s]*(\d+)/i);
  if (!entryMatch) return null;
  const idx = parseInt(entryMatch[1], 10) - 1;
  return Number.isFinite(idx) && idx >= 0 ? idx : null;
}

export function normalizePhone(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return trimmed;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return trimmed;
  return hasPlus ? `+${digits}` : digits;
}

export function looksLikePlaceholderOption(text: string): boolean {
  const optText = (text || '').toLowerCase().trim();
  return !optText || optText.includes('select') || optText.includes('choose') || optText.includes('--');
}

/**
 * Format a YYYY-MM or YYYY-MM-DD value for UI5 date pickers.
 * Unknown patterns fall back to MM/dd/yyyy.
 */
export function formatUi5Date(value: string, pattern: string = 'MM/dd/yyyy'): string {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!match) return value;
  const year = match[1];
  const month = match[2];
  const day = match[3] || '01';
  const p = (pattern || 'MM/dd/yyyy').toLowerCase();
  const sep = p.includes('.') ? '.' : p.includes('-') && !p.includes('/') ? '-' : '/';
  if (p.startsWith('yyyy')) return `${year}${sep}${month}${sep}${day}`;
  if (p.startsWith('dd')) return `${day}${sep}${month}${sep}${year}`;
  return `${month}${sep}${day}${sep}${year}`;
}
