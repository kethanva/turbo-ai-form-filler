import { describe, it, expect, beforeAll } from 'vitest';

// content.ts has no exports — it attaches its FormFiller instance to
// `window.__formAutopilotFormFiller` as its own debugging seam (see the
// bottom of content.ts). We reuse that same seam here to reach the private
// date/entry-index methods that have regressed multiple times in the past.
// TS visibility is compile-time only, so `as any` casts are the only way in
// without exporting internals purely for tests.
let filler: any;

beforeAll(async () => {
  await import('../src/content');
  filler = (window as any).__formAutopilotFormFiller;
});

describe('parseDateToISO', () => {
  it('parses MM/YYYY to the first of the month', () => {
    expect(filler.parseDateToISO('02/2022')).toBe('2022-02-01');
  });

  it('parses YYYY-MM-DD unchanged', () => {
    expect(filler.parseDateToISO('2022-02-15')).toBe('2022-02-15');
  });

  it('parses MM/DD/YYYY (US format)', () => {
    expect(filler.parseDateToISO('02/15/2022')).toBe('2022-02-15');
  });

  it('rejects a bare number (must not become Jan 1 of that "year")', () => {
    expect(filler.parseDateToISO('2022')).toBeNull();
    expect(filler.parseDateToISO('3')).toBeNull();
  });

  it('rejects an invalid calendar date', () => {
    expect(filler.parseDateToISO('13/45/2022')).toBeNull();
  });

  it('does not use native Date() on a month name (must not invent a day)', () => {
    expect(filler.parseDateToISO('March 2020')).toBeNull();
    expect(filler.parseDateToISO('not a date')).toBeNull();
  });
});

describe('formatProfileDate', () => {
  it('formats MM-YYYY to MM/YYYY', () => {
    expect(filler.formatProfileDate('02-2022')).toBe('02/2022');
  });

  it('formats YYYY-MM to MM/YYYY', () => {
    expect(filler.formatProfileDate('2022-02')).toBe('02/2022');
  });

  it('returns null for Present/Current/Ongoing (caller must skip end date)', () => {
    expect(filler.formatProfileDate('Present')).toBeNull();
    expect(filler.formatProfileDate('Current')).toBeNull();
    expect(filler.formatProfileDate('ongoing')).toBeNull();
  });

  it('returns null for empty/missing input', () => {
    expect(filler.formatProfileDate('')).toBeNull();
    expect(filler.formatProfileDate(undefined)).toBeNull();
    expect(filler.formatProfileDate(null)).toBeNull();
  });
});

describe('extractEntryIndex', () => {
  it('extracts a 1-based entry number and converts to 0-based index', () => {
    expect(filler.extractEntryIndex('Job Title [Position Entry: 2]')).toBe(1);
    expect(filler.extractEntryIndex('School [Education Entry: 1]')).toBe(0);
    expect(filler.extractEntryIndex('[Entry: 3]')).toBe(2);
  });

  it('returns null when no entry marker is present', () => {
    expect(filler.extractEntryIndex('First Name')).toBeNull();
    expect(filler.extractEntryIndex('re-entry 2')).toBeNull();
  });
});

describe('isEducationSection / isExperienceSection', () => {
  it('classifies explicit Education Entry tags', () => {
    expect(filler.isEducationSection('Degree [Education Entry: 1]')).toBe(true);
    expect(filler.isExperienceSection('Degree [Education Entry: 1]')).toBe(false);
  });

  it('classifies explicit Position Entry tags', () => {
    expect(filler.isExperienceSection('Title [Position Entry: 1]')).toBe(true);
    expect(filler.isEducationSection('Title [Position Entry: 1]')).toBe(false);
  });
});

describe('isSensitiveField', () => {
  it('flags protected-status field names', () => {
    expect(filler.isSensitiveField('Race / Ethnicity')).toBe(true);
    expect(filler.isSensitiveField('Veteran Status')).toBe(true);
    expect(filler.isSensitiveField('Disability')).toBe(true);
    expect(filler.isSensitiveField('Gender')).toBe(true);
  });

  it('does not flag ordinary fields', () => {
    expect(filler.isSensitiveField('First Name')).toBe(false);
    expect(filler.isSensitiveField('Job Title')).toBe(false);
  });
});
