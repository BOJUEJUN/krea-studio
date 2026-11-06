/**
 * Image → prompt via DeepSeek (OpenAI-compatible chat API with image input).
 * Thinking runs at medium effort (~7 s per image); the token budget must leave
 * room for the reasoning tokens, which count toward max_tokens.
 */

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-flash";
// 2026-11-05 (用户): the prompt describes only what is in the picture, with no style words at all. The one
// exception is ours: a realistic / photographic reference gets "anime style, " in front, added by the code below.
const INSTRUCTION = [
  "看这张图，写一段英文生图提示词，只描述画面里有什么：人物、外貌、发型、服装、动作、表情、构图、视角、背景。",
  "不要写任何风格、画风、媒介、渲染、画质类的词，例如 realistic、photorealistic、photo、anime、illustration、3D、render、cinematic、studio lighting、ultra-detailed、8k、masterpiece、best quality。",
  "另外判断这张图是不是写实风格（真人照片、写实摄影、写实 CG）。",
  "最后两行严格按这个格式输出：",
  "写实：是 或 否",
  "提示词：（那段英文提示词）",
].join("\n");

/** Style / quality words removed even if the model writes them anyway. */
const STYLE_WORDS =
  /\b(ultra[- ]?)?(photo[- ]?realistic|hyper[- ]?realistic|realistic|realism|photograph(y|ic)?|photo|raw photo|dslr|anime( style)?|manga|cartoon|illustration|digital (art|painting)|concept art|3d( render)?|cg|cgi|octane( render)?|unreal engine|render(ed|ing)?|cinematic|studio lighting|(ultra|highly|hyper)[- ]?detailed|high detail(ed)?|sharp focus|8k|4k|uhd|hdr|masterpiece|best quality|high quality|award[- ]winning)\b/gi;

function stripStyle(prompt: string): string {
  return prompt
    .replace(STYLE_WORDS, "")
    .replace(/\s*,\s*([,.]\s*)+/g, ", ")
    .replace(/^[\s,.;]+|[\s,.;]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Reads "写实：是/否" and "提示词：…"; falls back to the last paragraph for replies in another shape. */
export function parseReply(text: string): { prompt: string; realistic: boolean } {
  // 2026-11-06 (用户: 重新编辑后提示词有多余信息): the reply may say "提示词：" more than once (the model
  // sometimes echoes the format first), so only the last one counts, and no "写实：" line may leak in.
  const reals = [...text.matchAll(/写实\s*[:：]\s*\**\s*(是|否)/g)];
  const tags = [...text.matchAll(/提示词\s*[:：]\s*/g)];
  const last = tags[tags.length - 1];
  let raw = last ? text.slice((last.index ?? 0) + last[0].length) : lastParagraph(text);
  raw = raw
    .split(/\n/)
    .filter((l) => !/^\s*\**\s*写实\s*[:：]/.test(l))
    .join(" ")
    .replace(/\*\*/g, "")
    .replace(/^[`"“'「\s]+|[`"”'」\s]+$/g, "")
    .trim();
  return { prompt: stripStyle(raw), realistic: reals[reals.length - 1]?.[1] === "是" };
}

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
        .replace(/^[`"“'「*#>\s-]+|[`"”'」*\s]+$/g, "")
        .replace(/\*\*/g, "")
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
  const { prompt, realistic } = parseReply(content);
  return ((realistic ? "anime style, " : "") + prompt).slice(0, 2000);
}
