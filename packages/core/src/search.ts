/** The words of a text as full-text search takes them: letters, digits and `_`, in lowercase. */
export const searchWords = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

/** An FTS5 MATCH that finds any of the words, each quoted so none reads as an operator. */
export const ftsMatch = (words: readonly string[]) => words.map((word) => `"${word.replace(/"/g, '""')}"`).join(" OR ");
