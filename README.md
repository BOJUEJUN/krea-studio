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
- 账号（2026-11-11）：用户名 + 密码登录，注册要邀请码；老的只用名字的账号在「注册」里用邀请码设一次密码（店主号用 `OWNER_CODE`）；头像菜单可改密码
- 提示词润色（低/中/高，默认低，DeepSeek）、提示词反推（直接生成 / 先填到框里）、输入 @ 指定参考图（显示小图）
- 外观：浅色 / 深色 / 跟随系统（默认跟随系统）；手机只显示简单生图，不显示画布
- 自由画布（`app/canvas-board.tsx`）：
  - 节点：图片资源、图片生成、文本、生成框
  - 连线：「+」拖线；图片→图片 = 参考图，文本→图片 = 描述，图片→文本 = 看图写描述；点线上标签断开
  - 选中一张图时：自己是图1，连进来的是图2、图3…，连进来的文本作描述
  - 每个节点各记各的描述和参数
  - 对比、再来一张、高清放大（Krea Topaz 2×）
  - 右键菜单、框选、对齐吸附、小地图（缩小并移动时出现）
  - 服务器保存每个画布，可分享整块或选中部分（对方得到一份可编辑副本）

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
| `app/page.tsx` | 页面（单图：结果 + 输入框 + 历史；画布模式时左栏 + 画布 + 跟着选中节点走的输入框） |
| `app/canvas-board.tsx` | 自由画布：节点、连线、选择、缩放、小地图、右键菜单、云端同步、分享快照 |
| `lib/canvas-store.ts` | 画布存储：每用户一个画布列表 + 每个画布一份 JSON（`/api/canvas`、`/api/canvas/[id]`） |
| `app/api/canvas/upload` · `share` | 画布里的本地图片上传（存成 `/api/ref/cv…`）；分享链接快照（`/?share=…`） |
| `app/api/upscale` · `imginfo` · `polish` | 高清放大（Krea Topaz）；原图分辨率；提示词润色 |
| `lib/auth.ts` | 账号：密码（scrypt）、邀请码、店主码、会话 cookie |

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
