import { describe, it, expect } from 'vitest';
import { fillTemplate, textualMatch, convertToJson } from '../src/modules/helpers';

describe('fillTemplate', () => {
  it('fills placeholders positionally, left to right', () => {
    expect(fillTemplate('{} says {}', 'Alice', 'hi')).toBe('Alice says hi');
  });

  it('does not let an injected value corrupt later slots', () => {
    // The historical chained-.replace bug: injecting `{}` as a VALUE (e.g. an
    // empty-object field in a JSON-stringified profile) would get re-scanned
    // by the next .replace('{}', ...) call, stealing the next slot.
    const injected = 'profile: {}';
    expect(fillTemplate('A={} B={}', injected, 'question')).toBe('A=profile: {} B=question');
  });

  it('leaves unfilled placeholders untouched when fewer values than slots', () => {
    expect(fillTemplate('{} and {}', 'only-one')).toBe('only-one and {}');
  });

  it('ignores extra values beyond available slots', () => {
    expect(fillTemplate('{}', 'a', 'b', 'c')).toBe('a');
  });
});

describe('textualMatch', () => {
  it('does not match an antonym substring (male inside female)', () => {
    expect(textualMatch('male', 'Female')).toBe(false);
    expect(textualMatch('Female', 'male')).toBe(false);
  });

  it('matches a whole word inside a longer sentence', () => {
    expect(textualMatch('yes', 'Yes, I am authorized to work')).toBe(true);
  });

  it('matches case-insensitively on exact equality', () => {
    expect(textualMatch('Yes', 'yes')).toBe(true);
  });

  it('rejects matches when either side is too short', () => {
    expect(textualMatch('in', 'India')).toBe(false);
    expect(textualMatch('India', 'in')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(textualMatch('', 'anything')).toBe(false);
    expect(textualMatch('anything', '')).toBe(false);
  });
});

describe('convertToJson', () => {
  it('parses plain JSON', () => {
    expect(convertToJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('extracts JSON from a markdown code fence', () => {
    expect(convertToJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts JSON-like content between braces when embedded in prose', () => {
    expect(convertToJson('Sure, here it is: {"a":1} — hope that helps')).toEqual({ a: 1 });
  });

  it('returns null for unparseable text', () => {
    expect(convertToJson('not json at all')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(convertToJson('')).toBeNull();
  });
});
