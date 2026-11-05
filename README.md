# AI Studio

AI 文生图 / 图生图网站，跑在 RunningHub 上发布的 Krea2 + LoRA 工作流。

线上：https://enzoban.com （Vercel 项目 `krea-studio`，2026-11-05 从 Netlify 迁来；旧站 https://krea-studio-cn.netlify.app 停用）

## 功能

- 模型：棕色尘埃、小小英雄、LOL 2.36MP V1.1（默认）、LOL 2.36MP、CherryCHE Skills（RunningHub Krea2 工作流）；Nano Banana 2.1（RunningHub 海外站）、Krea 3（Krea API）、GPT Image 2.6 Flare / Sunburst（OpenAI），文生图和图生图都支持
- 每个模型只显示它支持的参数（`lib/models.ts` 的 `params`）：重绘幅度只给 Krea2；GPT 有 快速/标准/精细 画质，Krea 3 有 1K/2K；非 RunningHub 国内站的模型按钮显示估价（¥）和扣费账户
- 图生图可不写描述：先用 DeepSeek 看参考图反推提示词（「提示词反推」开关，默认开）
- 所有模型 LoRA 强度统一按 2.0 发送；文生图比例预设约 2.36MP
- 图生图结果可与参考图对比（滑动 / 左右 / 点击切换 / 叠加）
- 历史：搜索、按模式 / 模型 / 状态筛选、分页；失败和已过期的任务也会保留

## 结构

| 位置 | 作用 |
|------|------|
| `lib/models.ts` | 模型列表（名称、封面），前后端共用，无密钥 |
| `lib/model-workflows.ts` | 每个模型对应的 RunningHub 工作流 ID 与节点（提示词 208、种子/重绘 215、尺寸 423、参考图 213、LoRA 374/244） |
| `lib/runninghub.ts` | 提交工作流、查询结果（按任务编号分派到下面三个）、上传参考图 |
| `lib/rh-models.ts` | RunningHub 标准模型 API（Banana 2.1，任务号 `rhb-…`） |
| `lib/krea.ts` | Krea 3（任务号 `krea-…`） |
| `lib/openai.ts` | GPT Image 2.6，Responses API 后台模式（任务号 `resp_…`） |
| `lib/store.ts` | 存储：Vercel Blob（私有）/ Netlify Blobs / 本地 data/store |
| `lib/deepseek.ts` | 参考图 → 提示词（`deepseek-flash`，中档思考） |
| `lib/history.ts` | 历史：每条任务单独一条记录 + 汇总索引（经 `lib/store.ts`），本地开发用 `data/history.json` |
| `lib/refs.ts` | 图生图参考图存档（供对比用），`/api/ref/<任务ID>` 读取 |
| `app/page.tsx` | 页面（左：设置，中：结果，右：历史） |

加新模型：在 RunningHub 发布工作流后，在 `lib/models.ts` 加一项（含封面图，放 `public/models/`），再在 `lib/model-workflows.ts` 填上文生图 / 图生图的工作流 ID。节点结构不同的工作流需要单独写节点映射。

## 环境变量

本地放 `.env.local`，线上在 Vercel 项目 Settings → Environment Variables。不要提交到 Git。

| 名称 | 说明 |
|------|------|
| `RUNNINGHUB_API_KEY` | RunningHub API Key |
| `DEEPSEEK_API_KEY` | DeepSeek API Key（提示词反推） |
| `RUNNINGHUB_AI_KEY` | RunningHub 海外站 Key（Nano Banana 2.1） |
| `KREA_API_KEY` | Krea API Token（Krea 3，API 余额在 krea.ai/app/api 单独充值） |
| `OPENAI_API_KEY` | OpenAI Key（GPT Image 2.6；函数在美国区运行） |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob 私有存储（创建存储时自动加上） |
| `CUSTOM_T2I_WORKFLOW_ID` / `CUSTOM_I2I_WORKFLOW_ID` | 棕色尘埃的文生图 / 图生图工作流 |
| `T2I_*_NODE` / `I2I_*_NODE` | 棕色尘埃工作流节点（不填则用默认 208 / 215 / 423 / 213） |

## 本地开发

```bash
npm install
npm run dev        # http://localhost:3000
```

## 部署（Vercel CLI，手动）

站点没有绑定 GitHub 自动部署，改完后在项目目录执行（需先 `npx vercel login`）：

```bash
npx vercel deploy --prod --yes
```

`.vercelignore` 排除了本地 `data/` 和 `.env*`。部署前请确认代码来自 `main` 分支最新版本。域名 enzoban.com / www.enzoban.com 解析在腾讯云 DNSPod（A 记录和 www CNAME 指向 Vercel）。
