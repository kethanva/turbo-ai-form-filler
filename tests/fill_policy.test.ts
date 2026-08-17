import { describe, it, expect } from 'vitest';
import {
  checkboxAction,
  extractEntryIndex,
  formatUi5Date,
  isCredentialOrSecretField,
  isNoAnswer,
  isSensitiveField,
  parseNumericAnswer,
  normalizePhone,
} from '../src/modules/fill_policy';
import {
  isAllowedProviderUrl,
  sanitizeLlmRequestBody,
  MAX_LLM_MAX_TOKENS,
} from '../src/modules/provider_guard';
import { overlaySecrets } from '../src/modules/config_loader';

describe('parseNumericAnswer', () => {
  it('parses a numeric string', () => {
    expect(parseNumericAnswer('12', 'age')).toBe(12);
  });

  it('does not invent 25 for years of experience', () => {
    expect(parseNumericAnswer('N/A', 'Years of experience')).toBeNull();
    expect(parseNumericAnswer('', 'years in role')).toBeNull();
  });

  it('does not invent a donation default', () => {
    expect(parseNumericAnswer('none', 'donation amount')).toBeNull();
  });
});

describe('checkboxAction', () => {
  it('does not auto-check terms when the answer is No', () => {
    expect(
      checkboxAction({
        label: 'I agree to the terms and conditions',
        answer: 'No',
        currentlyWorkHere: false,
        autoAcceptTerms: false,
      })
    ).toBe('leave');
  });

  it('checks terms only when autoAcceptTerms is on or the answer is yes', () => {
    expect(
      checkboxAction({
        label: 'I accept the privacy policy',
        answer: '',
        currentlyWorkHere: false,
        autoAcceptTerms: false,
      })
    ).toBe('leave');
    expect(
      checkboxAction({
        label: 'I accept the privacy policy',
        answer: 'yes',
        currentlyWorkHere: false,
        autoAcceptTerms: false,
      })
    ).toBe('check');
    expect(
      checkboxAction({
        label: 'I accept the privacy policy',
        answer: '',
        currentlyWorkHere: false,
        autoAcceptTerms: true,
      })
    ).toBe('check');
  });

  it('never auto-checks marketing opt-ins unless the answer is yes', () => {
    expect(
      checkboxAction({
        label: 'I consent to receive marketing emails',
        answer: '',
        currentlyWorkHere: false,
        autoAcceptTerms: true,
      })
    ).toBe('leave');
  });
});

describe('isCredentialOrSecretField', () => {
  it('flags password and file types', () => {
    expect(isCredentialOrSecretField({ type: 'password' }, 'Password')).toBe(true);
    expect(isCredentialOrSecretField({ type: 'file' }, 'Resume')).toBe(true);
  });

  it('flags autocomplete current-password on a text input', () => {
    expect(
      isCredentialOrSecretField(
        { type: 'text', autocomplete: 'current-password', name: 'user' },
        'Login'
      )
    ).toBe(true);
  });

  it('flags SSN / OTP labels', () => {
    expect(isCredentialOrSecretField({ type: 'text', name: 'ssn' }, 'Social Security Number')).toBe(true);
    expect(isCredentialOrSecretField({ type: 'text', id: 'otp' }, 'One-time code')).toBe(true);
  });

  it('does not flag ordinary name fields', () => {
    expect(isCredentialOrSecretField({ type: 'text', name: 'firstName' }, 'First Name')).toBe(false);
  });
});

describe('extractEntryIndex', () => {
  it('extracts bracket tags', () => {
    expect(extractEntryIndex('Job Title [Position Entry: 2]')).toBe(1);
    expect(extractEntryIndex('[Entry: 3]')).toBe(2);
  });

  it('does not bind bare "re-entry 2"', () => {
    expect(extractEntryIndex('re-entry 2')).toBeNull();
    expect(extractEntryIndex('First Name')).toBeNull();
  });
});

describe('isNoAnswer / isSensitiveField / normalizePhone', () => {
  it('treats N/A as no answer', () => {
    expect(isNoAnswer('N/A')).toBe(true);
    expect(isNoAnswer('Yes')).toBe(false);
  });

  it('flags protected-status fields', () => {
    expect(isSensitiveField('Race / Ethnicity')).toBe(true);
    expect(isSensitiveField('First Name')).toBe(false);
  });

  it('keeps a leading plus and digits only', () => {
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalizePhone('(415) 555-0100')).toBe('4155550100');
  });
});

describe('formatUi5Date', () => {
  it('formats ISO dates using the widget pattern', () => {
    expect(formatUi5Date('2020-03-15', 'MM/dd/yyyy')).toBe('03/15/2020');
    expect(formatUi5Date('2020-03-15', 'dd/MM/yyyy')).toBe('15/03/2020');
    expect(formatUi5Date('2020-03', 'yyyy-MM-dd')).toBe('2020-03-01');
  });

  it('leaves non-ISO values unchanged', () => {
    expect(formatUi5Date('March 2020', 'MM/dd/yyyy')).toBe('March 2020');
  });
});

describe('isAllowedProviderUrl', () => {
  it('accepts groq and huggingface over https', () => {
    expect(isAllowedProviderUrl('https://api.groq.com/openai/v1/chat/completions')).toBe(true);
    expect(isAllowedProviderUrl('https://router.huggingface.co/v1/chat/completions')).toBe(true);
  });

  it('rejects http and unknown hosts', () => {
    expect(isAllowedProviderUrl('http://api.groq.com/openai/v1/chat/completions')).toBe(false);
    expect(isAllowedProviderUrl('https://evil.example/v1')).toBe(false);
    expect(isAllowedProviderUrl('not a url')).toBe(false);
  });
});

describe('sanitizeLlmRequestBody', () => {
  it('forces the allowlisted model and caps max_tokens', () => {
    const sanitized = sanitizeLlmRequestBody(
      {
        model: 'openai/gpt-expensive',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 999999,
        extra: 'drop-me',
      },
      'llama-3.1-8b-instant'
    );
    expect(sanitized).not.toBeNull();
    expect(sanitized!.model).toBe('llama-3.1-8b-instant');
    expect(sanitized!.max_tokens).toBe(MAX_LLM_MAX_TOKENS);
    expect((sanitized as { extra?: unknown }).extra).toBeUndefined();
  });

  it('returns null without messages or model', () => {
    expect(sanitizeLlmRequestBody({ messages: [] }, 'llama-3.1-8b-instant')).toBeNull();
    expect(sanitizeLlmRequestBody({ messages: [{ role: 'user', content: 'x' }] }, '')).toBeNull();
  });
});

describe('overlaySecrets', () => {
  const bundled = {
    use_AI: true,
    groq_api_key: 'gsk_bundled_key_should_not_stick',
    groq_model: 'llama-3.1-8b-instant',
    groq_api_url: 'https://api.groq.com/openai/v1/chat/completions',
    huggingface_api_key: 'hf_bundled_key_should_not_stick',
    huggingface_model: 'meta-llama/Llama-3.2-3B-Instruct',
    huggingface_api_url: 'https://router.huggingface.co/v1/chat/completions',
  };

  it('lets an explicit empty key override a bundled key', () => {
    const merged = overlaySecrets({ groq_api_key: '', huggingface_api_key: '' }, bundled);
    expect(merged.groq_api_key).toBe('');
    expect(merged.huggingface_api_key).toBe('');
  });

  it('keeps the bundled key when storage omitted that field', () => {
    const merged = overlaySecrets({ use_AI: false }, bundled);
    expect(merged.groq_api_key).toBe(bundled.groq_api_key);
    expect(merged.use_AI).toBe(false);
  });
});
