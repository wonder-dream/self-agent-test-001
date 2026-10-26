export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; background: #f6f4ef; color: #1c1915; font: 16px/1.6 "Source Han Sans SC", "Noto Sans SC", sans-serif; }
    main { max-width: 46rem; margin: 0 auto; padding: 1.25rem 1rem 4rem; }
    nav { display: flex; gap: 1rem; margin-bottom: 1rem; }
    a { color: #0f4c5c; }
    h1 { font-size: 1.4rem; margin: 0.2rem 0 0.8rem; }
    h2 { font-size: 1.05rem; margin: 0 0 0.4rem; }
    .card { background: #fff; border: 1px solid #e4dfd6; padding: 0.8rem 1rem; margin: 0.8rem 0; }
    .meta { color: #5c564c; font-size: 0.92rem; }
    textarea, button { font: inherit; }
    textarea { width: 100%; min-height: 7rem; }
    button { padding: 0.3rem 0.8rem; }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
<main>
  <nav>
    <a href="/">状态</a>
    <a href="/diary">日记</a>
    <a href="/memories">记忆</a>
    <a href="/chat">聊天</a>
    <a href="/self">人格</a>
  </nav>
  <h1>${escapeHtml(title)}</h1>
  ${body}
</main>
</body>
</html>`;
}

export function flash(text: string | null): string {
  if (!text) return "";
  return `<p class="card">${escapeHtml(text)}</p>`;
}
