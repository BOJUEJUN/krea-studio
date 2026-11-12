import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { maskSvg } from "./brush-mask";
import { hasSavedImage, imageUrlFor, saveImageBytes } from "./images";
import type { KreaRegion } from "./krea-regions";
import { storeGet, storePut } from "./store";

type Target = Pick<KreaRegion, "x" | "y" | "width" | "height" | "mask">;
const key = (id: string) => "kbrush-" + id;
const finished = Buffer.from("done");
const jobTag = (id: string) => id.endsWith("_up") ? undefined : id.match(/_p([A-Za-z0-9_-]{16})$/)?.[1];
export { jobTag as brushIdOf };

async function alphaOf(targets: Target[], width: number, height: number) {
  return sharp(Buffer.from(maskSvg(targets, width, height))).ensureAlpha().extractChannel("alpha").raw().toBuffer();
}

// Save the exact upload before creating a billable job. The compact handle travels with the job on every device.
export async function stageBrush(source: Buffer, regions: KreaRegion[]) {
  const targets = regions.filter((r) => r.image_idx === 0);
  for (const r of targets) {
    if (r.mask?.strokes.some((s) => s.erase) && !(await alphaOf([r], 512, 512)).some((a) => a > 0))
      throw new Error(`区域 @${r.label} 已擦空，请补画或删除`);
  }
  const id = randomBytes(12).toString("base64url");
  const header = JSON.stringify(targets.map(({ x, y, width, height, mask }) => ({ x, y, width, height, mask })));
  await storePut(key(id), Buffer.concat([Buffer.from(header + "\n"), source]), "application/octet-stream", 40_000);
  return id;
}

export function releaseBrush(id: string) {
  return storePut(key(id), finished, "application/octet-stream").catch(() => {});
}

async function compositeBrush(original: Buffer, generated: Buffer, targets: Target[]) {
  const [source, output] = await Promise.all([sharp(original).metadata(), sharp(generated).metadata()]);
  const shape = source.autoOrient ?? source, result = output.autoOrient ?? output;
  if (!shape.width || !shape.height || !result.width || !result.height) throw new Error("无法读取重绘图片尺寸");
  const scale = Math.max(result.width, result.height) / Math.max(shape.width, shape.height);
  const width = Math.max(1, Math.round(shape.width * scale)), height = Math.max(1, Math.round(shape.height * scale));
  const rgba = (bytes: Buffer) => sharp(bytes).rotate().resize(width, height, { fit: "fill" })
    .toColourspace("srgb").ensureAlpha().raw().toBuffer();
  const [base, edit, mask] = await Promise.all([rgba(original), rgba(generated), alphaOf(targets, width, height)]);
  // Interpolate premultiplied colors at antialiased edges. Untouched RGBA bytes stay identical.
  for (let p = 0; p < mask.length; p++) {
    const coverage = mask[p];
    if (!coverage) continue;
    const i = p * 4;
    if (coverage === 255) {
      base[i] = edit[i]; base[i + 1] = edit[i + 1]; base[i + 2] = edit[i + 2]; base[i + 3] = edit[i + 3];
      continue;
    }
    const a = base[i + 3] * (255 - coverage), b = edit[i + 3] * coverage, sum = a + b;
    for (let c = 0; c < 3; c++) base[i + c] = sum ? Math.round((base[i + c] * a + edit[i + c] * b) / sum) : 0;
    base[i + 3] = Math.round(sum / 255);
  }
  return sharp(base, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

export async function finishBrush(taskId: string, id: string, url: string): Promise<string> {
  if (await hasSavedImage(taskId)) return imageUrlFor(taskId);
  const bundle = await storeGet(key(id), 40_000);
  if (!bundle || bundle.equals(finished)) {
    // A concurrent poll may just have published the composed result and discarded its staging data.
    if (await hasSavedImage(taskId)) return imageUrlFor(taskId);
    throw new Error("暂时读不到画笔选区，请稍后继续查询");
  }
  const split = bundle.indexOf(10);
  if (split < 1) throw new Error("画笔选区数据无效");
  const targets: Target[] = JSON.parse(bundle.subarray(0, split).toString("utf8"));
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("暂时取不到模型结果，请稍后继续查询");
  const output = await compositeBrush(bundle.subarray(split + 1), Buffer.from(await response.arrayBuffer()), targets);
  // Only the final masked image enters the gallery, downloads and thumbnail generator.
  const saved = await saveImageBytes(taskId, output);
  await releaseBrush(id);
  return saved;
}
