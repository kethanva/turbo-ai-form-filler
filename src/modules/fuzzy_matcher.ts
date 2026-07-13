// Converted from modules/fuzzy_matcher.py
import { getPersonalsSync, Personals } from './config_loader.js';

interface FuzzyMatcherData {
  [key: string]: any;
}

class FuzzyMatcher {
  private data: FuzzyMatcherData;

  constructor() {
    this.data = {};
  }

  private ensureDataLoaded(): void {
    // Always rebuild from current personals cache so profile edits apply immediately.
    const personals = getPersonalsSync();
    this.data = {};
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
        }
      }
    }
  }

  private similarityRatio(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) return 1.0;

    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  answerQuestion(
    question: string,
    options?: string[],
    questionType: string = "text",
    jobDescription: string = ""
  ): string | null {
    this.ensureDataLoaded();
    const questionLower = question.toLowerCase();

    // Detect course-related questions
    const isCourseQuestion = questionLower.includes('course') && questionLower.includes('name');
    const isPostgradQuestion = /postgraduate|post-graduate|masters|master's|pg|postgrad/i.test(question);
    const isUndergradQuestion = /undergraduate|under-graduate|bachelors|bachelor's|ug|undergrad|graduation/i.test(question);

    // Signature / printed-name fields → full name from personals (never echo legal text)
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

    // Direct keyword matching
    let bestMatchKey: string | null = null;
    let bestScore = 0;

    const stopWords = ["what", "is", "your", "do", "you", "have", "the", "a", "an", "are", "of", "in", "to", "for"];
    const qWords = questionLower.split(' ').filter(w => !stopWords.includes(w));
    const cleanQuestion = qWords.join(' ');

    for (const key in this.data) {
      // Skip person name fields when question is about course names
      if (isCourseQuestion && ['first_name', 'last_name', 'middle_name', 'name'].includes(key)) {
        continue;
      }

      const cleanKey = key.replace(/_/g, ' ');
      const score1 = this.similarityRatio(questionLower, cleanKey.toLowerCase());
      const score2 = this.similarityRatio(cleanQuestion, cleanKey.toLowerCase());
      let score = Math.max(score1, score2);

      // Boost if exact meaningful key words are in question
      const keyParts = cleanKey.split(' ');
      const matches = keyParts.filter(part =>
        questionLower.includes(part.toLowerCase()) && part.length > 3
      ).length;
      if (keyParts.length > 0) {
        score += (matches / keyParts.length) * 0.4;
      }

      // Specific heuristic boosts
      if (cleanKey.includes('experience') && questionLower.includes('experience')) {
        score += 0.2;
      }
      if (cleanKey.includes('citizen') && questionLower.includes('citizen')) {
        score += 0.3;
      }
      if (cleanKey.includes('sponsorship') && (questionLower.includes('sponsorship') || questionLower.includes('visa'))) {
        score += 0.3;
      }

      // Boost for course-related questions
      if (isCourseQuestion) {
        if (cleanKey.includes('course')) {
          score += 0.5;
        }
        if (isPostgradQuestion && /postgraduate|masters|postgrad/i.test(cleanKey)) {
          score += 0.6;
        }
        if (isUndergradQuestion && /undergraduate|bachelors|undergrad/i.test(cleanKey)) {
          score += 0.6;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatchKey = key;
      }
    }

    // Threshold for acceptance
    if (bestScore > 0.65 && bestMatchKey) {
      const val = this.data[bestMatchKey];

      // If options provided, try to map value to options
      if (options) {
        const mapped = this.mapValueToOptions(val, options);
        if (mapped) return mapped;
      }

      // If no options, return the value as string
      if (!options) {
        return String(val);
      }
    }

    // Fallback: Match Options directly against Data Values
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
    const valStr = String(value).toLowerCase();

    // Exact match
    for (const opt of options) {
      if (opt.toLowerCase() === valStr) {
        return opt;
      }
    }

    // Partial match
    for (const opt of options) {
      if (valStr.includes(opt.toLowerCase()) || opt.toLowerCase().includes(valStr)) {
        return opt;
      }
    }

    // Fuzzy match
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

  extractSkills(_description: string): string[] {
    // Fuzzy skill extraction is not implemented; callers treat [] as "no match".
    return [];
  }
}

// Global instance
export const fuzzyMatcher = new FuzzyMatcher();

export function fuzzyAnswerQuestion(
  question: string,
  options?: string[],
  questionType: string = "text",
  jobDescription: string = ""
): string | null {
  return fuzzyMatcher.answerQuestion(question, options, questionType, jobDescription);
}

export function fuzzyExtractSkills(description: string): string[] {
  return fuzzyMatcher.extractSkills(description);
}

