# XHS Cover MVP

小红书批量封面生成工具的标准源码仓库。源码、macOS 应用和 Railway 线上服务都应从本目录构建，禁止再从旧 `.app` 反向提取覆盖源码。

## 本地运行

```bash
cp .env.example .env
npm install
npm start
```

默认访问 `http://localhost:5177`。

## 发布流程

1. 在本仓库修改代码和模板。
2. 执行 `node --test test/*.test.mjs`。
3. 提交到 `main`，并为正式版本创建日期标签。
4. Railway 从 `main` 自动部署；本地紧急部署可执行 `railway up`。
5. `.app` 和 ZIP 由同一提交打包，只作为发布产物。

真实 API Key 只存放在本地 `.env` 和 Railway Variables 中，不提交到 Git。
