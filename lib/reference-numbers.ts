// The UI number stays with a reference; the provider always receives a dense list in upload order.
export function readNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length ||
      !value.every((n) => Number.isSafeInteger(n) && n > 0 && n < 1_000_000)) return;
  return value;
}

export function referenceNumbers(saved: number[] | undefined, count: number): number[] {
  const numbers = (readNumbers(saved) ?? []).slice(0, count);
  let next = Math.max(0, ...numbers) + 1;
  while (numbers.length < count) numbers.push(next++);
  return numbers;
}

export function missingReference(text: string, numbers: number[]) {
  return Array.from(text.matchAll(/@图(\d+)/g), (m) => Number(m[1])).find((n) => !numbers.includes(n));
}
export function providerMentions(text: string, numbers: number[]) {
  return text.replace(/@图(\d+)/g, (token, n) => {
    const index = numbers.indexOf(Number(n));
    return index < 0 ? token : "@图" + (index + 1);
  });
}
