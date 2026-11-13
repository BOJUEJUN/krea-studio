import { captureLayout, generationInputs, isGeneration, pictureDraft, type BoardNode, type CanvasDraft } from "./canvas-workflow";
import { pictureRefs, type CanvasLayout, type EditablePicture } from "./edit-recipe";
import { DEFAULT_MODEL, editAspectOf, paramsOf } from "./models";

export type RunFrame = { id: string; draft: CanvasDraft; layout: CanvasLayout; aspect: number };
type Input = { id?: string; url?: string; aspect?: number };
type PlannedFrame = RunFrame & { inputs: Input[]; ready: boolean };
type Output = { url: string; aspect: number };

export function planSelection(frames: BoardNode[], nodes: BoardNode[], urlOf: (n: BoardNode) => string | null,
  recipeOf: (id: string) => EditablePicture | undefined): PlannedFrame[] {
  const selected = new Set(frames.map((n) => n.id));
  return frames.map((n) => {
    const gid = n.gid ?? n.editOf;
    const recipe = gid ? recipeOf(gid) : undefined;
    const settings = n.draft ?? recipe?.editorDraft ?? (recipe ? pictureDraft(recipe) :
      { ...pictureDraft({ id: n.id, mode: "t2i", model: DEFAULT_MODEL, prompt: "" }), reverseOn: true });
    const draft = { ...settings, refNumbers: n.refNumbers ?? settings.refNumbers };
    const branch = generationInputs(n, nodes, selected);
    const texts = branch.filter((p) => p.kind === "text");
    const inputs: Input[] = branch.filter((p) => p.kind !== "text").map((p) => ({
      id: p.id, url: urlOf(p) ?? undefined, aspect: p.nw && p.nh ? p.nw / p.nh : p.w / p.h,
    }));
    const layout = captureLayout([n], nodes, (p) => urlOf(p) ?? (isGeneration(p) ? p.id : null), branch)!;
    if (!n.from && recipe) {
      inputs.push(...pictureRefs(recipe).map((url) => ({ url })));
      if (recipe.canvasLayout) layout.inputs = recipe.canvasLayout.inputs;
    }
    return { id: n.id, draft: texts.length ? { ...draft, prompt: texts.map((p) => p.text ?? "").join("\n\n") } : draft,
      inputs, layout, aspect: n.w / n.h, ready: !!(n.draft || recipe || !gid) };
  });
}

// Independent branches start together. Each selected input is resolved once to its newly generated image.
export async function executePlan(plans: PlannedFrame[], unavailable: Set<string>,
  submit: (frame: RunFrame, urls: string[]) => Promise<string | undefined>) {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const running = new Map<string, Promise<Output | undefined>>();
  function run(plan: PlannedFrame, trail: ReadonlySet<string>): Promise<Output | undefined> {
    if (!plan.ready || trail.has(plan.id)) return Promise.resolve(undefined);
    const already = running.get(plan.id);
    if (already) return already;
    const path = new Set(trail).add(plan.id);
    const waitFor = plan.inputs.slice(0, paramsOf(plan.draft.model).maxRefs ?? 1).map((input) => {
      if (input.id && unavailable.has(input.id)) return undefined;
      const parent = input.id && byId.get(input.id);
      return parent ? run(parent, path) : input.url ? { url: input.url, aspect: input.aspect ?? plan.aspect } : undefined;
    });
    const task = Promise.all(waitFor).then(async (results) => {
      const images = results.filter((r): r is Output => !!r);
      if (images.length !== results.length) return;
      const d = plan.draft;
      const aspect = images.length ? editAspectOf(d.model, d.editRatio) ?? images[0].aspect :
        (Number(d.widthText) || d.width) / (Number(d.heightText) || d.height);
      const frame = plan.layout.frame, h = frame.w / aspect;
      const layout = { ...plan.layout, frame: { ...frame, h, y: frame.y + (frame.h - h) / 2 } };
      const url = await submit({ ...plan, aspect, layout }, images.map((img) => img.url));
      return url ? { url, aspect } : undefined;
    }).catch(() => undefined);
    running.set(plan.id, task);
    return task;
  }
  return (await Promise.all(plans.map((plan) => run(plan, new Set())))).filter(Boolean).length;
}
