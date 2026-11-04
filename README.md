# AI Studio

AI 文生图 / 图生图网站，跑在 RunningHub 上发布的 Krea2 + LoRA 工作流。

线上：https://krea-studio-cn.netlify.app （Netlify，站点 `krea-studio-cn`）

## 功能

- 模型：棕色尘埃、小小英雄、LOL 2.36MP V1.1（默认）、LOL 2.36MP、CherryCHE Skills，文生图和图生图都支持
- 图生图可不写描述：先用 DeepSeek 看参考图反推提示词（「提示词反推」开关，默认开）
- 所有模型 LoRA 强度统一按 2.0 发送；文生图比例预设约 2.36MP
- 图生图结果可与参考图对比（滑动 / 左右 / 点击切换 / 叠加）
- 历史：搜索、按模式 / 模型 / 状态筛选、分页；失败和已过期的任务也会保留

## 结构

| 位置 | 作用 |
|------|------|
| `lib/models.ts` | 模型列表（名称、封面），前后端共用，无密钥 |
| `lib/model-workflows.ts` | 每个模型对应的 RunningHub 工作流 ID 与节点（提示词 208、种子/重绘 215、尺寸 423、参考图 213、LoRA 374/244） |
| `lib/runninghub.ts` | 提交工作流、查询结果、上传参考图 |
| `lib/deepseek.ts` | 参考图 → 提示词（`deepseek-flash`，中档思考） |
| `lib/history.ts` | 历史存储：线上用 Netlify Blobs（每条任务单独一个 blob + 汇总索引），本地开发用 `data/history.json` |
| `lib/refs.ts` | 图生图参考图存档（供对比用），`/api/ref/<任务ID>` 读取 |
| `app/page.tsx` | 页面（左：设置，中：结果，右：历史） |

加新模型：在 RunningHub 发布工作流后，在 `lib/models.ts` 加一项（含封面图，放 `public/models/`），再在 `lib/model-workflows.ts` 填上文生图 / 图生图的工作流 ID。节点结构不同的工作流需要单独写节点映射。

## 环境变量

本地放 `.env.local`，线上在 Netlify 后台（Site settings → Environment variables）。不要提交到 Git。

| 名称 | 说明 |
|------|------|
| `RUNNINGHUB_API_KEY` | RunningHub API Key |
| `DEEPSEEK_API_KEY` | DeepSeek API Key（提示词反推） |
| `CUSTOM_T2I_WORKFLOW_ID` / `CUSTOM_I2I_WORKFLOW_ID` | 棕色尘埃的文生图 / 图生图工作流 |
| `T2I_*_NODE` / `I2I_*_NODE` | 棕色尘埃工作流节点（不填则用默认 208 / 215 / 423 / 213） |

## 本地开发

```bash
npm install
npm run dev        # http://localhost:3000
```

## 部署（Netlify CLI，手动）

站点没有绑定 GitHub 自动部署，改完后在项目目录执行：

```bash
npx netlify-cli deploy --build --prod --site caa172dd-fc25-47f5-a9e3-82b35ce14296
```

需要先 `npx netlify-cli login`。部署前请确认代码来自 `main` 分支最新版本，避免把旧版本发上线。
