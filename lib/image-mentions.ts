/** Accept the picture names people use when typing or pasting descriptions. */
export function normalizeMentions(text: string): string {
  return text.replace(/(?<![\w@])@?(?:图片|照片|图)\s*([0-9０-９]{1,6}|[一二三四五六七八九十两]{1,3})(?![0-9０-９张幅个组套次])/gu, (match, digits: string) => {
    const ascii = digits.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10));
    const chinese: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const parts = ascii.split("十");
    const number = /^[0-9]+$/.test(ascii) ? Number(ascii) : parts.length === 2
      ? (parts[0] ? chinese[parts[0]] : 1) * 10 + (parts[1] ? chinese[parts[1]] : 0)
      : chinese[ascii];
    return Number.isSafeInteger(number) && number > 0 ? "@图" + number : match;
  });
}
