# 自主漫游

一个跑在你自己服务器上的只读互联网漫游服务。它用 DeepSeek 自己决定何时出发、看什么、何时休息，并把日记、摘要和对话留在本地面板里。

默认不开始漫游。在面板里按下「开始」之后，作息由它自己决定。聊天和漫游共用每天 10 元的 DeepSeek 费用，按 Asia/Shanghai 零点恢复。面板默认只从本机访问。

## 运行

```bash
cp .env.example .env
npm test
npm start
```

把 API Key 写进 `.env` 的 `DEEPSEEK_API_KEY`。这个文件不进仓库。

Docker：

```bash
docker compose up --build
```

容器里的端口发布在 `127.0.0.1:8080`。之后用 Tailscale 之类的私有网络访问，不要改成对公网开放。

## 费用估计

`config/pricing.json` 是停机用的单价表，按 DeepSeek 英文文档里的 Flash 闲时美元价、以 7.30 折成人民币后向上取整。工作日 9:00–12:00 和 14:00–18:00（北京时间）按两倍计。账单如果和这张表不一致，改这张表：调高会更早停下，调低会走得更久。
