/**
 * Cloudflare Worker — 把 sunyancai.top/prinx/* 转发到 prinx-demo.pages.dev/*
 *
 * 路由配置（在 CF Dashboard → Workers → Add route）：
 *   pattern: sunyancai.top/prinx/*
 *   worker:  此 worker
 *
 * 子路径剥离：sunyancai.top/prinx/pages/overview.html
 *           → prinx-demo.pages.dev/pages/overview.html
 */
const TARGET = 'prinx-demo.pages.dev';
const PREFIX = '/prinx';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.startsWith(PREFIX)) path = path.slice(PREFIX.length) || '/';
    const dest = new URL(path + url.search, `https://${TARGET}`);
    const init = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
    };
    let resp = await fetch(dest.toString(), init);
    // 重定向时把 prinx-demo.pages.dev 替换回 sunyancai.top/prinx
    const loc = resp.headers.get('location');
    if (loc) {
      const newLoc = loc
        .replace(`https://${TARGET}/`, `https://${url.host}${PREFIX}/`)
        .replace(`http://${TARGET}/`, `http://${url.host}${PREFIX}/`);
      resp = new Response(resp.body, resp);
      resp.headers.set('location', newLoc);
    }
    return resp;
  },
};
