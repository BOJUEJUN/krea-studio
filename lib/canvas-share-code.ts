// An app prefix distinguishes shares from ordinary text and other applications' clipboard formats.
export const shareCodeIn = (text: string) => text.match(/\bEZ-(?:[A-F0-9]{4}-){5}[A-F0-9]{4}\b/i)?.[0].toUpperCase();
export const shareLifetime = 7 * 24 * 60 * 60 * 1000;
