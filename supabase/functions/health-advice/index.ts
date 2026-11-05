// AI 健康解读（Supabase Edge Function）
// 前端只传去标识化后的结构化上下文，模型密钥保存在服务端环境变量：
//   QWEN_API_KEY 必填
//   QWEN_MODEL   可选，默认 qwen-plus
//   QWEN_BASE_URL 可选，默认 DashScope OpenAI 兼容地址
// 调用方必须是已登录用户，避免匿名刷额度。
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SB = Deno.env.get('SUPABASE_URL') || '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
const API_KEY = Deno.env.get('QWEN_API_KEY') || Deno.env.get('LLM_API_KEY') || '';
const BASE_URL = (Deno.env.get('QWEN_BASE_URL') || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
const MODEL = Deno.env.get('QWEN_MODEL') || 'qwen-plus';
const DISCLAIMER = '仅供个人健康管理参考，不构成医疗建议，不能替代肾内科医生。任何用药调整请咨询医生。';

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function latestLab(ctx: any, key: string) {
  const arr = Array.isArray(ctx?.labs) ? ctx.labs.filter((x: any) => x && x.key === key) : [];
  arr.sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
  return arr.length ? arr[arr.length - 1] : null;
}

/* 服务端再兜底一次红线：即使前端传入的 redFlags 被篡改，也不会漏掉高危值 */
function serverRedFlags(ctx: any): string[] {
  const out: string[] = [];
  const k = latestLab(ctx, 'k');
  const hco3 = latestLab(ctx, 'hco3');
  const hgb = latestLab(ctx, 'hgb');
  const egfr = latestLab(ctx, 'egfr');
  if (k && Number(k.value) >= 6.0) out.push(`血钾 ${k.value} mmol/L，已达到需要紧急处理的范围，请立即联系肾内科或急诊。`);
  else if (k && Number(k.value) >= 5.5) out.push(`血钾 ${k.value} mmol/L，明显偏高，请尽快联系医生复查。`);
  if (hco3 && Number(hco3.value) < 18) out.push(`碳酸氢盐 ${hco3.value} mmol/L，明显偏低，提示酸中毒风险，请尽快就医。`);
  if (hgb && Number(hgb.value) < 90) out.push(`血红蛋白 ${hgb.value} g/L，明显偏低，请尽快评估贫血原因。`);
  if (egfr && Number(egfr.value) < 15) out.push(`eGFR ${egfr.value}，已低于 15，请尽快与肾内科讨论后续方案。`);
  const given = Array.isArray(ctx?.redFlags) ? ctx.redFlags.map((x: any) => String(x || '').trim()).filter(Boolean) : [];
  return [...new Set([...given, ...out])].slice(0, 8);
}

function cleanStrings(v: any, max = 8): any[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (typeof x === 'string' || typeof x === 'number') return String(x).slice(0, 600);
    if (x && typeof x === 'object') {
      const out: Record<string, string> = {};
      ['item', 'level', 'urgency', 'evidence', 'action', 'advice', 'topic', 'title', 'detail', 'reason']
        .forEach((k) => { if (x[k] != null) out[k] = String(x[k]).slice(0, 600); });
      return Object.keys(out).length ? out : '';
    }
    return '';
  }).filter(Boolean).slice(0, max);
}

function normalizeAdvice(a: any) {
  const out = {
    overall: String(a?.overall || a?.summary || '').slice(0, 1200),
    priorityFindings: cleanStrings(a?.priorityFindings, 5),
    redFlags: cleanStrings(a?.redFlags, 8),
    questionsForDoctor: cleanStrings(a?.questionsForDoctor, 5),
    lifestyle: cleanStrings(a?.lifestyle, 5),
    followUp: cleanStrings(a?.followUp, 5),
    dataGaps: cleanStrings(a?.dataGaps, 5),
    disclaimer: String(a?.disclaimer || DISCLAIMER).slice(0, 800) || DISCLAIMER,
  };
  if (!out.overall && !out.priorityFindings.length && !out.redFlags.length) return null;
  return out;
}

function parseJson(text: string): any {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function callModel(messages: any[], jsonMode = true): Promise<string> {
  const body: any = {
    model: MODEL,
    messages,
    temperature: 0.25,
    max_tokens: 1200,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const msg = j?.error?.message || j?.message || `HTTP ${r.status}`;
    // 个别兼容端点不支持 response_format，去掉后重试一次
    if (jsonMode && (r.status === 400 || /response_format|json/i.test(msg))) {
      return callModel(messages, false);
    }
    throw new Error(`模型调用失败：${msg}`);
  }
  return String(j?.choices?.[0]?.message?.content || '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: '只支持 POST' }, 405);
  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: '未登录' }, 401);
    const u = await fetch(`${SB}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${token}` },
    });
    if (!u.ok) return json({ error: '登录已失效，请重新登录' }, 401);

    if (!API_KEY) {
      return json({ error: 'AI 服务尚未配置：请在 Supabase 设置 QWEN_API_KEY' }, 501);
    }

    const body = await req.json().catch(() => ({}));
    if (body.consent !== true) return json({ error: '未确认数据用于 AI 解读' }, 400);
    const ctx = body.context;
    if (!ctx || typeof ctx !== 'object') return json({ error: '缺少上下文' }, 400);
    if (JSON.stringify(ctx).length > 30000) return json({ error: '数据量过大，请减少历史记录后重试' }, 413);

    const flags = serverRedFlags(ctx);
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `以下是一名 CKD 4 期用户的去标识化数据。请严格按系统要求输出 JSON。\n` +
          `服务端红线（不得删除、不得淡化）：${JSON.stringify(flags)}\n` +
          `CONTEXT：\n${JSON.stringify({ ...ctx, redFlags: flags })}`,
      },
    ];

    let raw = await callModel(messages, true);
    let advice: any = null;
    try {
      advice = normalizeAdvice(parseJson(raw));
    } catch (_) {
      // 只修复一次格式，不重复生成内容
      raw = await callModel([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'assistant', content: raw },
        { role: 'user', content: '上面的输出不是合法 JSON。请只输出修正后的合法 JSON 对象，不要任何解释或代码块。' },
      ], true);
      advice = normalizeAdvice(parseJson(raw));
    }
    if (!advice) return json({ error: 'AI 返回内容为空或格式不正确' }, 502);

    // 服务端红线永远排在最前
    advice.redFlags = [...new Set([...flags, ...(advice.redFlags || [])])].slice(0, 8);
    if (!advice.disclaimer) advice.disclaimer = DISCLAIMER;

    return json({
      advice,
      model: MODEL,
      promptVersion: PROMPT_VERSION,
      contextHash: String(body.contextHash || ''),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('health-advice error', e);
    const err = e as any;
    return json({ error: (err && (err.message || String(err))) || '生成失败' }, 502);
  }
});
