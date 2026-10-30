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

/* 参考区间/单位统一成半角，前端好解析 */
const normRef = (s: string) =>
  String(s || '')
    .replace(/[＜]/g, '<')
    .replace(/[＞]/g, '>')
    .replace(/[－—–]/g, '-')
    .replace(/[～]/g, '~')
    .replace(/[≤]/g, '<')
    .replace(/[≥]/g, '>')
    .replace(/\s+/g, '');
const normUnit = (s: string) =>
  String(s || '')
    .replace(/\s+/g, '')
    .replace(/l\.73/gi, '1.73')
    .replace(/[μµ]/g, 'u');

const isRange = (s: string) =>
  /^[<>≤≥]?\s*\d+(?:\.\d+)?\s*[-–—~～]{1,2}\s*\d+(?:\.\d+)?$/.test(s) || /^[<>≤≥]\s*\d+(?:\.\d+)?$/.test(s);
const isNum = (s: string) =>
  /^[↑↓]?\s*[<>≤≥]?\s*-?\d+(?:\.\d+)?\s*[↑↓]?$/.test(s) && !/^\d{4,}$/.test(s.replace(/\s/g, ''));
const isUnit = (s: string) => /^[A-Za-zμµ%][A-Za-z0-9μµ%\/\^\.\*]*$/.test(s);
const isFlag = (s: string) => /^(?:[↑↓]|高|低|偏高|偏低|阳性|阴性|弱阳性|[+\-])$/.test(s);
const isNoise = (s: string) => /项目|结果|单位|参考|提示|名称|代号|序号/.test(s);

function cleanName(s: string): string {
  return String(s || '')
    .replace(/[*△▲☆★]/g, '')
    .replace(/[↑↓]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[|｜]+|[|｜]+$/g, '')
    .replace(/[\s:：,，.。;；_-]+$/g, '')
    .trim();
}

/* ===== 百度医疗检验报告单识别的真实返回（已实测） =====
   words_result.CommonData = [{word_name:'时间', word:'20261020'}, ...]
   words_result.Item = [[{word_name:'项目名称',word:'白蛋白'},
                          {word_name:'结果',word:'48.6'},
                          {word_name:'单位',word:'g/L'},
                          {word_name:'参考区间',word:'40.0--55.0'},
                          {word_name:'结果提示',word:''},
                          {word_name:'项目代号',word:''}], ...]
   优先按 word_name 取名，字段缺失时才退回按“语义”猜列。 */
const NAME_KEYS = ['项目名称', '项目', '名称', '检验项目', '项目名'];
const RESULT_KEYS = ['结果', '检验结果', '检测结果', '数值'];
const UNIT_KEYS = ['单位', '检验单位'];
const REF_KEYS = ['参考区间', '参考范围', '参考值', '正常范围'];
const FLAG_KEYS = ['结果提示', '提示', '异常提示', '异常'];
const CODE_KEYS = ['项目代号', '代号', '英文缩写', '缩写'];

function rowToItem(cells: any[]) {
  const map: Record<string, string> = {};
  const vals: string[] = [];
  for (const c of cells) {
    const wn = typeof c?.word_name === 'string' ? c.word_name.trim() : '';
    const w = toText(c?.word != null ? c.word : c);
    if (w) vals.push(w);
    if (wn) map[wn] = w;
  }
  const pick = (keys: string[]) => keys.map((k) => map[k]).find((v) => v && v.length) || '';

  let name = cleanName(pick(NAME_KEYS));
  let result = pick(RESULT_KEYS);
  let unit = normUnit(pick(UNIT_KEYS));
  let ref = normRef(pick(REF_KEYS));
  let flag = pick(FLAG_KEYS);
  const code = pick(CODE_KEYS);

  // 少量版式没有 word_name，按语义兜底
  if (!name || !result) {
    const rest = vals.filter((x) => x && !isNoise(x));
    if (!ref) {
      const r = rest.find(isRange);
      if (r) ref = normRef(r);
    }
    if (!result) {
      const v = rest.find((x) => isNum(x) && !isRange(x));
      if (v) result = v;
    }
    if (!unit) {
      const u = rest.find(isUnit);
      if (u) unit = normUnit(u);
    }
    if (!flag) {
      const f = rest.find(isFlag);
      if (f) flag = f;
    }
    if (!name) {
      const cn = rest.filter(
        (x) => /[\u4e00-\u9fa5]/.test(x) && !isRange(x) && !isUnit(x) && x !== result && x !== ref,
      );
      cn.sort((a, b) => b.length - a.length);
      name = cleanName(cn[0] || '');
    }
  }
  if (!name || !result) return null; // 没有结果的行不是检验项
  return { name, result, unit, ref, flag, code };
}

const pad2 = (n: string | number) => String(n).padStart(2, '0');
function pickDate(s: string): string {
  const t = String(s || '');
  let m = /(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = /(20\d{2})(\d{2})(\d{2})/.exec(t);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return '';
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
      let cells: any[] = [];
      if (Array.isArray(it)) cells = it;
      else if (it && typeof it === 'object') cells = Object.values(it);
      else cells = [it];
      const one = rowToItem(cells);
      if (one) items.push(one);
    }

    // 日期：先从「通用信息」里找（常见字段是 时间: 20261020），再从各项文字里找
    const common: string[] = [];
    const cd = wr.CommonData || wr.commonData || [];
    for (const x of (Array.isArray(cd) ? cd : [cd])) {
      common.push(toText(x?.word != null ? x.word : x));
    }
    const date =
      pickDate(common.join(' ')) ||
      pickDate(
        arr.map((x: any) => (Array.isArray(x) ? x.map((c: any) => toText(c?.word != null ? c.word : c)) : toText(x)))
          .join(' '),
      );

    // 通用信息里的医院/科室/受检人/标本类型，一起回传，前端按“报告级信息”入库
    const cMap: Record<string, string> = {};
    for (const x of (Array.isArray(cd) ? cd : [cd])) {
      const wn = typeof x?.word_name === 'string' ? x.word_name.trim() : '';
      if (wn) cMap[wn] = toText(x?.word != null ? x.word : x);
    }
    const pickc = (keys: string[]) => keys.map((k) => cMap[k]).find((v) => v && v.trim()) || '';
    const info = {
      hospital: pickc(['医院', '医院名称', '医疗机构', '检查医院']),
      dept: pickc(['科室', '检查科室', '送检科室', '申请科室']),
      patient: pickc(['姓名']),
      sex: pickc(['性别']),
      age: pickc(['年龄']),
      specimen: pickc(['标本种类', '标本类型', '标本']),
      title: pickc(['报告单名称', '检查项目', '检验项目']),
    };

    return json({ items, date, common: info, provider: 'baidu-medical', total: items.length });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
