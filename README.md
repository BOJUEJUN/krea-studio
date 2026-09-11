# Krea Studio

基于 **RunningHub OpenAPI v2 标准模型 API** 的 AI 生图站点。  
API Key 只保存在服务器端，适合分享给朋友通过网页使用。

## 功能

- 文生图：即梦 4.6 / Seedream V5 Pro / 千问 3.0 Pro / 万相 2.7
- 图生图：即梦 4.6 / Seedream V5 Pro
- 画幅预设、会话画廊、账户余额状态
- 官方契约：`Authorization: Bearer` + `/media/upload/binary` + submit + `/query` 轮询

## 本地启动（朋友可访问）

```bash
cd krea-studio
npm install
npm run dev
```

默认监听 `0.0.0.0:3000`。

- 本机：http://localhost:3000
- 局域网：http://<内网IP>:3000

## 公网部署（Vercel）

1. 仓库：https://github.com/BOJUEJUN/krea-studio
2. Vercel → Import → 配置环境变量 `RUNNINGHUB_API_KEY`
3. Deploy，把链接发给朋友

## 接入契约（已按官方 developer-kit 实现）

```
Base: https://www.runninghub.cn/openapi/v2
Auth: Authorization: Bearer <KEY>
上传: POST /media/upload/binary  (multipart field: file) → data.download_url
提交: POST /{endpoint}           → taskId
轮询: POST /query {"taskId"}     → SUCCESS / FAILED / CANCEL
结果: results[].url
```

可用模型 endpoint 来自官方 `model-registry.public.json`，未编造参数。

## 关于自定义 Krea 2 + LoRA

你提供的 ComfyUI 工作流（`zsca0901_000013000.safetensors`）需要先在 RunningHub
网页端上传 LoRA 并发布为 AI 应用 / 工作流后，才能走 `ai-app/run` 路径。  
当前站点默认走**标准模型 API**，开箱即可出图。

## 脚本

```bash
npm run dev    # 开发，0.0.0.0:3000
npm run build
npm start      # 生产，0.0.0.0:3000
```
