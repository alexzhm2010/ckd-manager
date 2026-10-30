// 云端化验单识别（Supabase Edge Function 代理）
// 前端只传图片，百度密钥保存在服务端环境变量里：BAIDU_OCR_AK / BAIDU_OCR_SK
// 调用方必须是已登录用户（用 JWT 校验），避免被匿名刷额度。
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SB = Deno.env.get('SUPABASE_URL') || '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
const AK = Deno.env.get('BAIDU_OCR_AK') || '';
const SK = Deno.env.get('BAIDU_OCR_SK') || '';

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

let cache = { token: '', exp: 0 };
async function baiduToken(): Promise<string> {
  if (Date.now() < cache.exp) return cache.token;
  const r = await fetch(
    `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${AK}&client_secret=${SK}`,
    { method: 'POST' },
  );
  const j = await r.json();
  if (!j.access_token) throw new Error('百度鉴权失败：' + (j.error_description || j.error || ''));
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 2592000) * 1000 - 60000 };
  return cache.token;
}

/* 单元格可能是字符串、{word}、{word:{...}}，统一取文字 */
function toText(c: any): string {
  if (c == null) return '';
  if (typeof c === 'string') return c.trim();
  if (typeof c === 'number') return String(c);
  if (Array.isArray(c)) return c.map(toText).filter(Boolean).join(' ').trim();
  if (typeof c === 'object') {
    if (typeof c.word === 'string') return c.word.trim();
    if (c.word) return toText(c.word);
    for (const k of ['text', 'value', 'result', 'content', 'words']) if (c[k] != null) return toText(c[k]);
  }
  return '';
}

const isRange = (s: string) =>
  /^[<>≤≥]?\s*\d+(?:\.\d+)?\s*[-–—~～]{1,2}\s*\d+(?:\.\d+)?$/.test(s) || /^[<>≤≥]\s*\d+(?:\.\d+)?$/.test(s);
const isNum = (s: string) =>
  /^[↑↓]?\s*[<>≤≥]?\s*-?\d+(?:\.\d+)?\s*[↑↓]?$/.test(s) && !/^\d{4,}$/.test(s.replace(/\s/g, ''));
const isUnit = (s: string) => /^[A-Za-zμµ%][A-Za-z0-9μµ%\/\^\.\*]*$/.test(s);
const isFlag = (s: string) => /^(?:[↑↓]|高|低|偏高|偏低|阳性|阴性|弱阳性|[+\-])$/.test(s);
const isNoise = (s: string) => /项目|结果|单位|参考|提示|名称|代号|序号/.test(s);

/* 一行 cells → 一个检验项（百度给的是单元格，不保证顺序，这里按“语义”挑列） */
function rowToItem(cells: string[]) {
  const c = cells.filter((x) => x && !isNoise(x));
  if (!c.length) return null;
  const ref = c.find(isRange) || '';
  const val = c.find((x) => isNum(x) && !isRange(x)) || '';
  const unit = c.find(isUnit) || '';
  const flag = c.find(isFlag) || '';
  const cand = c.filter((x) => /[\u4e00-\u9fa5]/.test(x) && !isRange(x) && !isUnit(x));
  const name = (cand.sort((a, b) => b.length - a.length)[0] || '').replace(/[*△▲☆★]/g, '').trim();
  if (!name || !val) return null;
  return { name, result: val, unit, ref, flag };
}

function pickDate(text: string): string {
  const m = /(20\d{2})\s*[-年\/.]\s*(\d{1,2})\s*[-月\/.]\s*(\d{1,2})/.exec(text);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: '只支持 POST' }, 405);
  try {
    // 登录校验：必须是本站账号
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: '未登录' }, 401);
    const u = await fetch(`${SB}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${token}` },
    });
    if (!u.ok) return json({ error: '登录已失效，请重新登录' }, 401);

    if (!AK || !SK) return json({ error: '云端识别未配置：缺少 BAIDU_OCR_AK / BAIDU_OCR_SK' }, 501);

    const body = await req.json().catch(() => ({}));
    const dataUrl = String(body.image || '');
    const m = /base64,(.*)$/.exec(dataUrl);
    const b64 = (m ? m[1] : dataUrl).replace(/\s/g, '');
    if (b64.length < 100) return json({ error: '图片为空' }, 400);
    if (b64.length > 3.9 * 1024 * 1024) return json({ error: '图片过大，请压缩后再试' }, 413);

    const at = await baiduToken();
    const r = await fetch(
      `https://aip.baidubce.com/rest/2.0/ocr/v1/medical_report_detection?access_token=${at}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'image=' + encodeURIComponent(b64),
      },
    );
    const j: any = await r.json();
    if (j.error_code) return json({ error: `百度识别失败：${j.error_msg || j.error_code}`, code: j.error_code }, 502);

    const wr = j.words_result || {};
    const arr = wr.Item || wr.item || wr.items || [];
    const items: any[] = [];
    for (const it of arr) {
      let cells: string[] = [];
      if (Array.isArray(it)) cells = it.map(toText);
      else if (it && typeof it === 'object') cells = Object.values(it).map(toText);
      else cells = [toText(it)];
      const one = rowToItem(cells);
      if (one) items.push(one);
    }

    // 日期：先从“通用信息”里找，再从各项文字里找
    const common: string[] = [];
    const cd = wr.CommonData || wr.commonData || [];
    for (const x of (Array.isArray(cd) ? cd : [cd])) common.push(toText(x));
    const date = pickDate(common.join(' ') + ' ' + arr.map((x: any) => (Array.isArray(x) ? x.map(toText) : toText(x))).join(' '));

    return json({ items, date, provider: 'baidu-medical', total: items.length });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
