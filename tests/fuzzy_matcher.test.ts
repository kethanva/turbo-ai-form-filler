import { describe, it, expect, beforeEach, vi } from 'vitest';

// fuzzy_matcher pulls personals from config_loader's module-level cache via
// getPersonalsSync(). Mock that one seam so tests control the profile data
// without needing a real chrome.storage.
let mockPersonals: Record<string, unknown> | null = null;
vi.mock('../src/modules/config_loader.js', () => ({
  getPersonalsSync: () => mockPersonals,
}));

import { fuzzyAnswerQuestion } from '../src/modules/fuzzy_matcher';

describe('fuzzyAnswerQuestion', () => {
  beforeEach(() => {
    mockPersonals = null;
  });

  it('maps a boolean profile value to the Yes/No option (not "true"/"false")', () => {
    mockPersonals = { sponsorship_required: false };
    const answer = fuzzyAnswerQuestion('Sponsorship Required?', ['Yes', 'No'], 'single_select');
    expect(answer).toBe('No');
  });

  it('maps a true boolean to Yes', () => {
    mockPersonals = { sponsorship_required: true };
    const answer = fuzzyAnswerQuestion('Sponsorship Required?', ['Yes', 'No'], 'single_select');
    expect(answer).toBe('Yes');
  });

  it('does not select the antonym option via substring containment', () => {
    // Regression guard for H1: "male" must never resolve to "Female" just
    // because "female".includes("male").
    mockPersonals = { gender: 'male' };
    const answer = fuzzyAnswerQuestion('What is your gender?', ['Female', 'Male'], 'single_select');
    expect(answer).toBe('Male');
  });

  it('returns full name for a plain signature field', () => {
    mockPersonals = { first_name: 'Ada', last_name: 'Lovelace' };
    const answer = fuzzyAnswerQuestion('Signature');
    expect(answer).toBe('Ada Lovelace');
  });

  it('returns null when nothing matches confidently', () => {
    mockPersonals = { first_name: 'Ada' };
    const answer = fuzzyAnswerQuestion('What is the airspeed velocity of an unladen swallow?');
    expect(answer).toBeNull();
  });
});
