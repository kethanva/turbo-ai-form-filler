// Converted from modules/fuzzy_matcher.py
import { getPersonalsSync } from './config_loader.js';
import { textualMatch } from './helpers.js';

interface FuzzyMatcherData {
  [key: string]: any;
}

interface KeyEntry {
  key: string;
  cleanKey: string;
  words: string[];
}

class FuzzyMatcher {
  private data: FuzzyMatcherData;
  private keyIndex: KeyEntry[] = [];
  private cachedPersonalsRef: unknown = null;

  constructor() {
    this.data = {};
  }

  private ensureDataLoaded(): void {
    // Rebuild only when personals object identity changes (edits invalidate cache).
    const personals = getPersonalsSync();
    if (personals === this.cachedPersonalsRef && this.keyIndex.length > 0) {
      return;
    }
    this.cachedPersonalsRef = personals;
    this.data = {};
    this.keyIndex = [];
    if (!personals) return;

    for (const key in personals) {
      if (Object.prototype.hasOwnProperty.call(personals, key)) {
        const value = (personals as any)[key];
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          Array.isArray(value)
        ) {
          this.data[key] = value;
          const cleanKey = key.replace(/_/g, ' ').toLowerCase();
          this.keyIndex.push({
            key,
            cleanKey,
            words: cleanKey.split(/\s+/).filter((w) => w.length > 2),
          });
        }
      }
    }
  }

  private similarityRatio(str1: string, str2: string): number {
    // Cap length — Levenshtein is O(n*m); long legal labels must not explode CPU
    const a = str1.length > 64 ? str1.slice(0, 64) : str1;
    const b = str2.length > 64 ? str2.slice(0, 64) : str2;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;

    if (longer.length === 0) return 1.0;

    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const m = str2.length;
    const n = str1.length;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          curr[j] = prev[j - 1];
        } else {
          curr[j] = Math.min(prev[j - 1] + 1, curr[j - 1] + 1, prev[j] + 1);
        }
      }
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  answerQuestion(
    question: string,
    options?: string[],
    _questionType: string = "text",
    _jobDescription: string = ""
  ): string | null {
    this.ensureDataLoaded();
    const questionLower = question.toLowerCase();

    const isCourseQuestion = questionLower.includes('course') && questionLower.includes('name');
    const isPostgradQuestion = /postgraduate|post-graduate|masters|master's|pg|postgrad/i.test(question);
    const isUndergradQuestion = /undergraduate|under-graduate|bachelors|bachelor's|ug|undergrad|graduation/i.test(question);

    const isSignatureField =
      /\bsignature\s+and\s+date\b/.test(questionLower) ||
      /^(electronic\s+)?signature(\s+and\s+date)?\s*\*?$/.test(
        questionLower.replace(/\s*\[[^\]]+\]\s*/g, ' ').replace(/\*/g, '').trim()
      ) ||
      /\b(printed\s+name|full\s+legal\s+name)\b/.test(questionLower);
    if (isSignatureField) {
      const first = String(this.data['first_name'] || '').trim();
      const middle = String(this.data['middle_name'] || '').trim();
      const last = String(this.data['last_name'] || '').trim();
      const fullName = [first, middle, last].filter(Boolean).join(' ');
      if (fullName) {
        if (/\bdate\b/.test(questionLower)) {
          const today = new Date();
          const mm = String(today.getMonth() + 1).padStart(2, '0');
          const dd = String(today.getDate()).padStart(2, '0');
          const yyyy = today.getFullYear();
          return `${fullName} ${mm}/${dd}/${yyyy}`;
        }
        return fullName;
      }
    }

    let bestMatchKey: string | null = null;
    let bestScore = 0;

    const stopWords = new Set(["what", "is", "your", "do", "you", "have", "the", "a", "an", "are", "of", "in", "to", "for"]);
    const qWords = questionLower.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !stopWords.has(w));
    const cleanQuestion = qWords.join(' ');
    const qWordSet = new Set(qWords);

    const shortlist: { entry: KeyEntry; score: number }[] = [];
    for (const entry of this.keyIndex) {
      if (isCourseQuestion && ['first_name', 'last_name', 'middle_name', 'name'].includes(entry.key)) {
        continue;
      }

      const overlap = entry.words.filter((w) => qWordSet.has(w) || questionLower.includes(w)).length;
      let score = entry.words.length > 0 ? (overlap / entry.words.length) * 0.8 : 0;

      if (entry.cleanKey.includes('experience') && questionLower.includes('experience')) score += 0.2;
      if (entry.cleanKey.includes('citizen') && questionLower.includes('citizen')) score += 0.3;
      if (entry.cleanKey.includes('sponsorship') && (questionLower.includes('sponsorship') || questionLower.includes('visa'))) {
        score += 0.3;
      }
      if (isCourseQuestion) {
        if (entry.cleanKey.includes('course')) score += 0.5;
        if (isPostgradQuestion && /postgraduate|masters|postgrad/i.test(entry.cleanKey)) score += 0.6;
        if (isUndergradQuestion && /undergraduate|bachelors|undergrad/i.test(entry.cleanKey)) score += 0.6;
      }

      if (overlap > 0 || score >= 0.3) {
        shortlist.push({ entry, score });
      }
    }

    const candidates = shortlist.length > 0
      ? shortlist.sort((a, b) => b.score - a.score).slice(0, 12)
      : this.keyIndex.map((entry) => ({ entry, score: 0 }));

    for (const { entry, score: base } of candidates) {
      const score1 = this.similarityRatio(questionLower, entry.cleanKey);
      const score2 = this.similarityRatio(cleanQuestion, entry.cleanKey);
      const score = Math.max(score1, score2) + base;

      if (score > bestScore) {
        bestScore = score;
        bestMatchKey = entry.key;
      }
    }

    if (bestScore > 0.65 && bestMatchKey) {
      const val = this.data[bestMatchKey];

      if (options) {
        const mapped = this.mapValueToOptions(val, options);
        if (mapped) return mapped;
      }

      if (!options) {
        return String(val);
      }
    }

    if (options) {
      for (const opt of options) {
        for (const key in this.data) {
          const val = this.data[key];
          if (String(val).toLowerCase() === opt.toLowerCase()) {
            return opt;
          }
        }
      }
    }

    return null;
  }

  private mapValueToOptions(value: any, options: string[]): string | null {
    if (typeof value === 'boolean') {
      const target = value ? 'yes' : 'no';
      const hit = options.find(opt => opt.toLowerCase().trim() === target);
      if (hit) return hit;
    }

    const valStr = String(value).toLowerCase();

    for (const opt of options) {
      if (opt.toLowerCase() === valStr) {
        return opt;
      }
    }

    for (const opt of options) {
      if (textualMatch(valStr, opt)) {
        return opt;
      }
    }

    let bestOpt: string | null = null;
    let bestRatio = 0;
    for (const opt of options) {
      const ratio = this.similarityRatio(valStr, opt.toLowerCase());
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestOpt = opt;
      }
    }

    if (bestRatio > 0.7) {
      return bestOpt;
    }

    return null;
  }
}

export const fuzzyMatcher = new FuzzyMatcher();

export function fuzzyAnswerQuestion(
  question: string,
  options?: string[],
  questionType: string = "text",
  jobDescription: string = ""
): string | null {
  return fuzzyMatcher.answerQuestion(question, options, questionType, jobDescription);
}
