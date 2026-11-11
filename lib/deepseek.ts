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

/**
 * 2026-11-10 (用户: 提示词优化，默认不改太多只让提示词更顺畅，润色程度 低/中/高): rewrites the user's own prompt in
 * its own language. Every "@图N" picture token must survive exactly (the box shows them as thumbnails).
 */
export type PolishLevel = "low" | "medium" | "high";

const POLISH_RULES: Record<PolishLevel, string> = {
  low: "在保留全部原意和所有要求的前提下，把描述写得更清楚、更有条理：可以把含糊的地方说具体一些（比如动作、位置关系、主次），可以调整语序，但不要加入原文没有暗示的新元素。",
  medium: "主动重写成可直接作画的描述。先交代主体及其动作，再理清空间或参考图之间的关系。在用户留白的地方，补上两三个真正影响画面的具体决定，例如姿态受力、主体在画幅中的位置或受光方向。改图只细化用户点名的改动，让它和原图衔接。",
  high: "以美术指导的方式构思一套完整且统一的画面方案，再写成一段可执行的提示词。围绕用户意图主动决定关键的取景、前中后景、动作轮廓、光源、配色或材质，写清它们如何配合突出主体；按题材取舍。局部改图应深入描述修改对象的形态、结构、透视和与原有部分的衔接，不扩大修改范围。避免用画质标签或空泛形容词填充。",
};

export async function polishPrompt(prompt: string, level: PolishLevel): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("未配置提示词优化");
  const tokens = (prompt.match(/@图\d+/g) || []).sort();
  const ask = async (extra: string) => {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        max_tokens: 4000,
        reasoning_effort: "medium",
        messages: [
          {
            role: "system",
            content: [
              "你是生图提示词润色助手。用户给你一段 AI 生图/改图的提示词，你按要求润色后只输出润色后的提示词本身，不要解释、不要加引号、不要加标题。",
              "保持原文语言（中文就写中文，英文就写英文）。",
              "像「@图1」「@图2」这样的标记代表用户上传的参考图，必须原样保留，每个标记出现的次数和它在句子里指代的对象都不能变，不能改写成别的说法。",
              "保留明示的人物身份、数量、风格、禁止项和参考图分工。只看到图号时，不虚构图中具体内容。",
              POLISH_RULES[level],
              extra,
            ].join("\n"),
          },
          { role: "user", content: prompt },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error?.message || `提示词优化失败 (${res.status})`);
    return String(json?.choices?.[0]?.message?.content || "")
      .replace(/^\s*(润色后的?)?提示词\s*[:：]\s*/, "")
      .replace(/^[`"“'「\s]+|[`"”'」\s]+$/g, "")
      .trim();
  };
  const same = (text: string) => JSON.stringify((text.match(/@图\d+/g) || []).sort()) === JSON.stringify(tokens);
  let out = await ask("");
  if (!out || !same(out)) out = await ask("上一次的结果丢失或改动了 @图 标记。这次务必把每个 @图N 标记原样、按原来的次数保留。");
  if (!out) throw new Error("提示词优化没有返回内容");
  if (!same(out)) throw new Error("优化结果弄丢了 @图 标记，请再试一次");
  return out.slice(0, 4000);
}
