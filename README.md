# Krea Studio

基于 **RunningHub** 的 Krea 2 Turbo + 自定义 LoRA 的 AI 生图站点。  
API Key 只保存在服务器端，适合分享给朋友通过网页使用。

## 功能

- 文生图（可选画幅 1:1 / 3:4 / 4:3 / 16:9 / 9:16）
- 图生图（可调重绘幅度）
- 随机种子
- 会话画廊
- 账户余额状态条

## 本地启动（朋友可访问）

```bash
cd krea-studio
npm install
npm run dev
```

默认监听 `0.0.0.0:3000`。

- 本机访问：http://localhost:3000
- 局域网访问：http://<你的内网IP>:3000  
  同一 Wi-Fi 下的朋友直接打开即可。

查看本机 IP：

```bash
ipconfig getifaddr en0
```

## 给朋友公网访问（推荐 Vercel）

1. 把本目录推到 GitHub。
2. 打开 [vercel.com](https://vercel.com) → Import 仓库。
3. 在 **Environment Variables** 里配置：
   - `RUNNINGHUB_API_KEY`
   - `RUNNINGHUB_T2I_WORKFLOW_ID`
   - `RUNNINGHUB_I2I_WORKFLOW_ID`
4. Deploy。得到公网链接后直接发给朋友。

## 配置 RunningHub 工作流（必须）

### 1. 上传 LoRA

你附带的 `zsca0901_000013000.safetensors`（218MB）需要先上传到 RunningHub 模型库：

1. 登录 [runninghub.cn](https://www.runninghub.cn)
2. 工作台 → 模型管理 / 个人模型 → 上传 LoRA
3. 文件名保持 `zsca0901_000013000.safetensors`

### 2. 发布两个工作流

分别导入仓库根目录下的：

- `krea 2常规文生图.json`
- `krea 2常规图生图.json`

在 RunningHub 的 ComfyUI / 工作流编辑器中导入，确认 LoRA 节点指向你上传的文件，然后 **发布为 API 可调用工作流**。

### 3. 把 ID 写入 `.env.local`

```env
RUNNINGHUB_API_KEY=你的key
RUNNINGHUB_T2I_WORKFLOW_ID=文生图工作流ID
RUNNINGHUB_I2I_WORKFLOW_ID=图生图工作流ID
```

节点 ID 默认按你给的工作流 JSON：

| 用途 | 节点 | 字段 |
|------|------|------|
| 提示词 | 208 | text |
| 种子 | 215 | seed |
| 画幅 | 423 | width / height |
| 重绘幅度 | 215 | denoise |
| 参考图 | 213 | image |

若发布后节点 ID 变了，改 `.env.local` 里对应变量即可。

## 脚本

```bash
npm run dev    # 开发，绑定 0.0.0.0:3000
npm run build  # 生产构建
npm start      # 生产启动，绑定 0.0.0.0:3000
```
