/**
 * Image → prompt via DeepSeek (OpenAI-compatible chat API with image input).
 * Thinking runs at medium effort (~7 s per image); the token budget must leave
 * room for the reasoning tokens, which count toward max_tokens.
 */

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-flash";
const INSTRUCTION = "描述这张图，最后仅输出一段生图提示词。";

export function hasDeepSeek(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}

/** The reply describes the image first; the prompt is its last paragraph. */
function lastParagraph(text: string): string {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .replace(/^\s*(\*\*)?(生图)?提示词(\*\*)?\s*[:：]\s*/i, "")
        .replace(/^[`"“'「]+|[`"”'」]+$/g, "")
        .trim()
    )
    .filter(Boolean);
  return (parts[parts.length - 1] || text).trim();
}

export async function describeImage(image: Blob): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("未配置提示词反推");
  const mime = image.type || "image/jpeg";
  const base64 = Buffer.from(await image.arrayBuffer()).toString("base64");
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      max_tokens: 6000,
      reasoning_effort: "medium",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
            { type: "text", text: INSTRUCTION },
          ],
        },
      ],
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message || `提示词反推失败 (${res.status})`);
  const content = String(json?.choices?.[0]?.message?.content || "").trim();
  if (!content) throw new Error("提示词反推没有返回内容");
  return lastParagraph(content).slice(0, 2000);
}
