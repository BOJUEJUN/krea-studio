import type { NodeOverride } from "./runninghub";

type EnvMap = {
  promptNode: string;
  promptField: string;
  seedNode: string;
  seedField: string;
  widthNode?: string;
  widthField?: string;
  heightNode?: string;
  heightField?: string;
  denoiseNode?: string;
  denoiseField?: string;
  imageNode?: string;
  imageField?: string;
};

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function t2iMap(): EnvMap {
  return {
    promptNode: env("T2I_PROMPT_NODE_ID", "208"),
    promptField: env("T2I_PROMPT_FIELD", "text"),
    seedNode: env("T2I_SEED_NODE_ID", "215"),
    seedField: env("T2I_SEED_FIELD", "seed"),
    widthNode: env("T2I_WIDTH_NODE_ID", "423"),
    widthField: env("T2I_WIDTH_FIELD", "width"),
    heightNode: env("T2I_HEIGHT_NODE_ID", "423"),
    heightField: env("T2I_HEIGHT_FIELD", "height"),
  };
}

export function i2iMap(): EnvMap {
  return {
    promptNode: env("I2I_PROMPT_NODE_ID", "208"),
    promptField: env("I2I_PROMPT_FIELD", "text"),
    seedNode: env("I2I_SEED_NODE_ID", "215"),
    seedField: env("I2I_SEED_FIELD", "seed"),
    denoiseNode: env("I2I_DENOISE_NODE_ID", "215"),
    denoiseField: env("I2I_DENOISE_FIELD", "denoise"),
    imageNode: env("I2I_IMAGE_NODE_ID", "213"),
    imageField: env("I2I_IMAGE_FIELD", "image"),
  };
}

export function buildT2INodes(params: {
  prompt: string;
  seed: number;
  width: number;
  height: number;
}): NodeOverride[] {
  const m = t2iMap();
  const list: NodeOverride[] = [
    { nodeId: m.promptNode, fieldName: m.promptField, fieldValue: params.prompt },
    { nodeId: m.seedNode, fieldName: m.seedField, fieldValue: params.seed },
  ];
  if (m.widthNode && m.widthField) {
    list.push({
      nodeId: m.widthNode,
      fieldName: m.widthField,
      fieldValue: params.width,
    });
  }
  if (m.heightNode && m.heightField) {
    list.push({
      nodeId: m.heightNode,
      fieldName: m.heightField,
      fieldValue: params.height,
    });
  }
  return list;
}

export function buildI2INodes(params: {
  prompt: string;
  seed: number;
  denoise: number;
  imageFileName: string;
}): NodeOverride[] {
  const m = i2iMap();
  return [
    { nodeId: m.promptNode, fieldName: m.promptField, fieldValue: params.prompt },
    { nodeId: m.seedNode, fieldName: m.seedField, fieldValue: params.seed },
    {
      nodeId: m.denoiseNode || m.seedNode,
      fieldName: m.denoiseField || "denoise",
      fieldValue: params.denoise,
    },
    {
      nodeId: m.imageNode || "213",
      fieldName: m.imageField || "image",
      fieldValue: params.imageFileName,
    },
  ];
}
