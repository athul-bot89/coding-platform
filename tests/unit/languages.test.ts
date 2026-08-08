import { describe, it, expect } from "vitest";
import {
  defaultLanguageFor,
  getMonacoLanguage,
  languageName,
  languageShortName,
  ALL_LANGUAGE_IDS,
  DEFAULT_LANGUAGE_ID,
} from "@/lib/languages";

describe("languages", () => {
  describe("defaultLanguageFor", () => {
    it("returns Python when allowed list includes it", () => {
      expect(defaultLanguageFor([54, 62, 71])).toBe(DEFAULT_LANGUAGE_ID);
    });

    it("returns first allowed language when Python is not available", () => {
      expect(defaultLanguageFor([54, 62, 63])).toBe(54);
    });

    it("returns Python for empty/undefined lists", () => {
      expect(defaultLanguageFor([])).toBe(DEFAULT_LANGUAGE_ID);
      expect(defaultLanguageFor(undefined)).toBe(DEFAULT_LANGUAGE_ID);
    });
  });

  describe("getMonacoLanguage", () => {
    it("maps known language IDs to Monaco grammar names", () => {
      expect(getMonacoLanguage(71)).toBe("python");
      expect(getMonacoLanguage(62)).toBe("java");
      expect(getMonacoLanguage(63)).toBe("javascript");
      expect(getMonacoLanguage(74)).toBe("typescript");
      expect(getMonacoLanguage(54)).toBe("cpp");
    });

    it("returns 'plaintext' for unknown language IDs", () => {
      expect(getMonacoLanguage(999)).toBe("plaintext");
    });
  });

  describe("languageName", () => {
    it("returns full name for known IDs", () => {
      expect(languageName(71)).toBe("Python 3 (3.8.1)");
      expect(languageName(62)).toBe("Java (OpenJDK 13)");
    });

    it("falls back for unknown IDs", () => {
      expect(languageName(999)).toBe("Language 999");
    });
  });

  describe("languageShortName", () => {
    it("returns short name for known IDs", () => {
      expect(languageShortName(71)).toBe("Python");
      expect(languageShortName(54)).toBe("C++");
    });

    it("falls back to stringified ID", () => {
      expect(languageShortName(999)).toBe("999");
    });
  });

  describe("ALL_LANGUAGE_IDS", () => {
    it("contains all supported languages", () => {
      expect(ALL_LANGUAGE_IDS).toContain(71);
      expect(ALL_LANGUAGE_IDS).toContain(62);
      expect(ALL_LANGUAGE_IDS.length).toBeGreaterThan(5);
    });

    it("all elements are numbers", () => {
      ALL_LANGUAGE_IDS.forEach((id) => expect(typeof id).toBe("number"));
    });
  });
});
