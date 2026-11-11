export const shortAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const isShortShareCode = (text: string) =>
  text.length === 6 && /[2-9]/.test(text) && [...text].every((c) => shortAlphabet.includes(c));

export function shareCodeIn(text: string): string | undefined {
  const value = text.trim();
  if (isShortShareCode(value)) return value;
  const legacy = value.match(/\bEZ-(?:[A-F0-9]{4}-){5}[A-F0-9]{4}\b/i);
  if (legacy) return legacy[0].toUpperCase();
  const embedded = value.match(/(?:分享口令\s*[：:]\s*|[?&]share=)([A-Za-z0-9]{6})(?![A-Za-z0-9_-])/);
  if (embedded && isShortShareCode(embedded[1])) return embedded[1];
}
export const shareLifetime = 7 * 24 * 60 * 60 * 1000;
