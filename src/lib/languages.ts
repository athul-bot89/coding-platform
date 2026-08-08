// Judge0 language IDs -> display names and Monaco grammar names.
// Single source of truth; previously duplicated across CodeEditor, the test page
// and the admin page.

export const LANGUAGE_NAMES: Record<number, string> = {
  50: "C (GCC 9.2.0)",
  51: "C# (Mono 6.6.0)",
  54: "C++ (GCC 9.2.0)",
  60: "Go (1.13.5)",
  62: "Java (OpenJDK 13)",
  63: "JavaScript (Node.js 12)",
  71: "Python 3 (3.8.1)",
  72: "Ruby (2.7.0)",
  73: "Rust (1.40.0)",
  74: "TypeScript (3.7.4)",
  78: "Kotlin (1.3.70)",
};

export const LANGUAGE_SHORT_NAMES: Record<number, string> = {
  50: "C",
  51: "C#",
  54: "C++",
  60: "Go",
  62: "Java",
  63: "JS",
  71: "Python",
  72: "Ruby",
  73: "Rust",
  74: "TS",
  78: "Kotlin",
};

const MONACO_LANG: Record<number, string> = {
  50: "c",
  51: "csharp",
  54: "cpp",
  60: "go",
  62: "java",
  63: "javascript",
  71: "python",
  72: "ruby",
  73: "rust",
  74: "typescript",
  78: "kotlin",
};

/** Python 3 — what every code editor starts on when the problem allows it. */
export const DEFAULT_LANGUAGE_ID = 71;

/**
 * The language an editor should open on for a problem. Python when it is
 * allowed, otherwise the problem's first allowed language.
 */
export function defaultLanguageFor(allowed: number[] | undefined): number {
  if (!allowed || allowed.length === 0) return DEFAULT_LANGUAGE_ID;
  return allowed.includes(DEFAULT_LANGUAGE_ID) ? DEFAULT_LANGUAGE_ID : allowed[0];
}

export function getMonacoLanguage(languageId: number): string {
  return MONACO_LANG[languageId] || "plaintext";
}

export function languageName(languageId: number): string {
  return LANGUAGE_NAMES[languageId] || `Language ${languageId}`;
}

export function languageShortName(languageId: number): string {
  return LANGUAGE_SHORT_NAMES[languageId] || String(languageId);
}

export const ALL_LANGUAGE_IDS = Object.keys(LANGUAGE_NAMES).map(Number);
