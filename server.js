import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEEPSEEK_API_KEY, APP_ACCESS_TOKEN, TAVILY_API_KEY, PORT = 3000 } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DEEPSEEK_API_KEY || !APP_ACCESS_TOKEN) {
  console.error('انقص أحد المتغيرات في .env — راجع .env.example');
  process.exit(1);
}
if (!TAVILY_API_KEY) {
  console.warn('تنبيه: TAVILY_API_KEY غير مضبوط — سيعمل النظام بدون بحث ويب حقيقي (مخرجات أقل دقة).');
}

// service_role يتجاوز RLS بالكامل — لهذا هذا الملف يعمل فقط على الخادم، وأبدًا لا يُرسل هذا المفتاح للمتصفح
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // يقدّم public/index.html على نفس النطاق (بلا مشاكل CORS)

const MODEL = 'deepseek-chat'; // نموذج المحادثة العام في DeepSeek — راجع api-docs.deepseek.com لأي تحديثات

async function searchWeb(query, maxResults = 5) {
  if (!TAVILY_API_KEY) return [];
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((r) => ({ title: r.title, url: r.url, content: (r.content || '').slice(0, 500) }));
  } catch (e) {
    return [];
  }
}

function formatSources(results) {
  if (!results.length) return 'لا توجد نتائج بحث متاحة لهذا الاستعلام.';
  return results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.content}`).join('\n\n');
}

// حماية بسيطة: أي طلب على /api/* يجب أن يحمل نفس الرمز السرّي المضبوط في متغيرات البيئة
function requireToken(req, res, next) {
  const provided = req.headers['x-app-token'];
  if (!provided || provided !== APP_ACCESS_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
app.use('/api', requireToken);

// ---------------------------------------------------------------------------
// طبقة النماذج: استدعاء DeepSeek فعليًا (صيغة متوافقة مع OpenAI)
// ---------------------------------------------------------------------------
async function askClaude(prompt, { json = false, maxTokens = 400, system = null } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (json) {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    return JSON.parse(match ? match[0] : text);
  }
  return text;
}

// ---------------------------------------------------------------------------
// طبقة التنسيق: تسجيل كل مرحلة في pipeline_stages أثناء تنفيذها
// ---------------------------------------------------------------------------
async function runStage(runId, stageKey, inputPayload, fn) {
  const startedAt = new Date().toISOString();
  await db.from('pipeline_stages').insert({
    run_id: runId, stage: stageKey, status: 'running', input: inputPayload, started_at: startedAt,
  });
  const t0 = Date.now();
  try {
    const output = await fn();
    await db.from('pipeline_stages')
      .update({ status: 'done', output: { result: output }, latency_ms: Date.now() - t0, completed_at: new Date().toISOString() })
      .eq('run_id', runId).eq('stage', stageKey);
    return output;
  } catch (e) {
    await db.from('pipeline_stages')
      .update({ status: 'error', error_message: String(e.message || e), completed_at: new Date().toISOString() })
      .eq('run_id', runId).eq('stage', stageKey);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// POST /api/setup — ينشئ منظمة + علامة + حملة بطلب واحد (بديل الإدخال اليدوي)
// ---------------------------------------------------------------------------
app.post('/api/setup', async (req, res) => {
  const { orgName, brandName, campaignName, goal, targetAudience, market, brandTone, competitors, uniqueSellingPoint, pastPerformance } = req.body;
  if (!orgName || !brandName || !campaignName || !goal) {
    return res.status(400).json({ error: 'orgName, brandName, campaignName, goal مطلوبة' });
  }
  try {
    const { data: org, error: orgErr } = await db.from('organizations').insert({ name: orgName }).select().single();
    if (orgErr) throw orgErr;

    const { data: brand, error: brandErr } = await db.from('brands')
      .insert({ organization_id: org.id, name: brandName }).select().single();
    if (brandErr) throw brandErr;

    const context = {};
    if (brandTone) context.brandTone = brandTone;
    if (competitors) context.competitors = competitors;
    if (uniqueSellingPoint) context.uniqueSellingPoint = uniqueSellingPoint;
    if (pastPerformance) context.pastPerformance = pastPerformance;

    const { data: campaign, error: campErr } = await db.from('campaigns')
      .insert({
        brand_id: brand.id, name: campaignName, goal,
        target_audience: targetAudience || null, market: market || null, status: 'active',
        context: Object.keys(context).length ? context : null,
      }).select().single();
    if (campErr) throw campErr;

    res.json({ organizationId: org.id, brandId: brand.id, campaignId: campaign.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/campaigns/:campaignId/run — ينفّذ الحلقة كاملة فعليًا
// ---------------------------------------------------------------------------
app.post('/api/campaigns/:campaignId/run', async (req, res) => {
  const { campaignId } = req.params;

  const { data: campaign, error: campaignErr } = await db
    .from('campaigns').select('*').eq('id', campaignId).single();
  if (campaignErr || !campaign) return res.status(404).json({ error: 'campaign not found' });

  const { data: run, error: runErr } = await db
    .from('pipeline_runs').insert({ campaign_id: campaignId, status: 'running' }).select().single();
  if (runErr) return res.status(500).json({ error: runErr.message });

  const extra = campaign.context || {};
  const ctx = `العلامة: ${campaign.name}\nالهدف: ${campaign.goal}\nالجمهور: ${campaign.target_audience || 'غير محدد'}\nالسوق: ${campaign.market || 'غير محدد'}`
    + (extra.brandTone ? `\nنبرة العلامة: ${extra.brandTone}` : '')
    + (extra.competitors ? `\nأبرز المنافسين: ${extra.competitors}` : '')
    + (extra.uniqueSellingPoint ? `\nالميزة التنافسية: ${extra.uniqueSellingPoint}` : '')
    + (extra.pastPerformance ? `\n\nبيانات أداء حقيقية سابقة (مصدرها العميل نفسه — اعتمد عليها كحقيقة موثقة، لا كتقدير):\n${extra.pastPerformance}` : '');
  const QUALITY = 'ممنوع الكليشيهات والعبارات الفضفاضة. لكن الأهم: ممنوع منعًا باتًا اختلاق إحصائيات أو نسب مئوية أو أسعار أو بيانات بحثية كأنها حقائق موثقة — أنت لا تملك اتصالًا ببيانات سوق حقيقية إلا ما يُرفق لك صراحة كمصادر أو بيانات عميل. أي رقم تذكره يجب أن يكون إما (أ) منقولًا حرفيًا من المعطيات أو المصادر المُعطاة لك، أو (ب) مسبوقًا بوضوح بعبارة "كتقدير مبدئي غير موثّق، يحتاج تحققًا من بيانات حقيقية:". لا تكتب أبدًا رقمًا دقيق الشكل بثقة كأنه نتيجة بحث فعلي ما لم يكن مذكورًا في المصادر المرفقة. الدقة والقيمة تأتيان من وضوح الفكرة وقابليتها للتنفيذ، لا من اختلاق أرقام.';

  try {
    const marketQuery = [campaign.market, extra.competitors, campaign.goal, 'سلوك المستهلك'].filter(Boolean).join(' ');
    const marketSources = await searchWeb(marketQuery);

    const [brandIntel, marketIntel] = await Promise.all([
      runStage(run.id, 'brand_intelligence', { ctx }, () =>
        askClaude(`بناءً على:\n${ctx}\nاكتب 3 نقاط قصيرة عن تموضع العلامة. عربي، بلا مقدمات.`,
          { system: `أنت خبير تموضع علامات تجارية بخبرة 15 عامًا في السوق العربي. ${QUALITY}` })),
      runStage(run.id, 'market_intelligence', { ctx, marketSources }, () =>
        askClaude(`السياق:\n${ctx}\n\nنتائج بحث ويب حقيقية حديثة (استخدمها كمصدرك الوحيد لأي رقم أو ادّعاء، واذكر رقم المصدر [1][2] بجانب كل ادّعاء مبني عليها):\n${formatSources(marketSources)}\n\nاكتب 3 نقاط عن سلوك الجمهور والتوقيت المناسب. إن لم تُجب المصادر على سؤال معين، قل ذلك صراحة بدل التخمين. عربي، بلا مقدمات.`,
          { system: `أنت محلل سوق يعتمد فقط على المصادر المرفقة له، ولا يضيف أي رقم من عندك. ${QUALITY}` })),
    ]);

    const hub = await runStage(run.id, 'agent_hub', { brandIntel, marketIntel }, () =>
      askClaude(`ادمج هذين المخرجين في 3 نقاط تشغيلية موحدة:\nالعلامة:\n${brandIntel}\nالسوق:\n${marketIntel}\nعربي، بلا مقدمات.`,
        { system: `أنت منسّق عمليات يحوّل التحليلات إلى تعليمات تنفيذية مباشرة لفريق التنفيذ. ${QUALITY}` }));

    const decision = await runStage(run.id, 'orchestrator', { hub }, () =>
      askClaude(`بناءً على:\n${hub}\nحدد توزيع أولوية (تجمع 100) بين استراتيجية/إبداع/وسائط. أعد فقط JSON: {"strategy":رقم,"creative":رقم,"media":رقم,"reason":"سبب قصير"}`,
        { json: true, system: 'أنت مدير تسويق مسؤول عن قرارات الميزانية، تبرر كل قرار بمنطق واضح مبني على المعطيات المُعطاة فقط.' }));

    await db.from('orchestrator_decisions').insert({
      run_id: run.id, strategy_weight: decision.strategy, creative_weight: decision.creative,
      media_weight: decision.media, reasoning: decision.reason,
    });

    const [strategy, creative, media] = await Promise.all([
      runStage(run.id, 'strategy', { hub, decision }, () =>
        askClaude(`أنت وكيل الاستراتيجية (أولوية ${decision.strategy}%). بناءً على:\n${hub}\nاكتب خطة من 3 خطوات. عربي، بلا مقدمات.`,
          { system: `أنت استراتيجي حملات ينتج خططًا قابلة للتنفيذ خلال أسبوع، لا نظريات عامة. ${QUALITY}` })),
      runStage(run.id, 'creative', { hub, decision }, () =>
        askClaude(`أنت وكيل الإبداع (أولوية ${decision.creative}%). بناءً على:\n${hub}\nاكتب فكرة رئيسية وجملة إعلانية واحدة. عربي، بلا مقدمات.`,
          { system: `أنت مدير إبداعي حائز جوائز، أسلوبك مباشر وغير متوقع، تتجنب القوالب الجاهزة تمامًا. ${QUALITY}`, maxTokens: 300 })),
      runStage(run.id, 'media', { hub, decision }, () =>
        askClaude(`أنت وكيل الوسائط (أولوية ${decision.media}%). بناءً على:\n${hub}\nاقترح 3 قنوات مع سبب لكل واحدة. عربي، بلا مقدمات.`,
          { system: `أنت مخطط وسائط تعرف تكلفة وأداء كل قناة في السوق العربي تحديدًا. ${QUALITY}` })),
    ]);

    const production = await runStage(run.id, 'production', { strategy, creative, media }, () =>
      askClaude(`ادمج في فقرة بريف واحدة متماسكة (أقل من 90 كلمة):\nالاستراتيجية:\n${strategy}\nالإبداع:\n${creative}\nالوسائط:\n${media}\nعربي، بلا مقدمات.`,
        { maxTokens: 250, system: QUALITY }));

    await db.from('campaign_assets').insert({ run_id: run.id, asset_type: 'brief', content: production, format: 'text' });
    await runStage(run.id, 'campaign_launch', {}, async () => production);
    await runStage(run.id, 'commerce', {}, async () =>
      'محاكاة: تتطلب ربطًا فعليًا بمزود تجارة/دفع خارجي (Shopify، إلخ) غير منفَّذ في هذا الخادم بعد.');

    const benchQuery = [campaign.market, extra.uniqueSellingPoint, 'معدل تحويل متوسط إعلانات'].filter(Boolean).join(' ');
    const benchSources = await searchWeb(benchQuery);

    const analytics = await runStage(run.id, 'analytics', { production, benchSources }, () =>
      askClaude(`بناءً على هذا البريف:\n${production}\n\nونتائج بحث ويب حقيقية عن معايير مشابهة (استخدمها فقط إن كانت ذات صلة فعلية، واذكر رقم المصدر):\n${formatSources(benchSources)}\n\nحدد 3 مؤشرات أداء يجب قياسها فعليًا لهذه الحملة تحديدًا (وعي/تفاعل/تحويل). لكل مؤشر: كيف يُقاس عمليًا، وما الذي سيدل على نجاح نسبي. لا تذكر أي نسبة أو رقم توقّعي إلا إن كان موجودًا فعليًا في المصادر أعلاه مع ذكر مصدره؛ غير ذلك قل "لا تتوفر بيانات موثوقة لتقدير رقم هنا". عربي، بلا مقدمات.`,
        { system: 'أنت محلل قياس أداء صارم، تفضّل قول "لا يمكن التنبؤ برقم دون بيانات حقيقية" على اختلاق رقم مقنع الشكل.' }));
    await db.from('analytics_snapshots').insert({ run_id: run.id, metric_name: 'summary', predicted_value: null, unit: 'text' });

    const optimization = await runStage(run.id, 'optimization', { analytics }, () =>
      askClaude(`بناءً على خطة القياس التالية:\n${analytics}\nاقترح تعديلين قابلين للاختبار الفعلي (A/B) للدورة القادمة، بلا أي أرقام تحسّن متوقعة مختلَقة — فقط ما سيُختبر ولماذا. عربي، بلا مقدمات.`,
        { system: 'ممنوع ذكر أي نسبة تحسّن متوقعة (مثل "سيرفع الأداء 20%") لأنها ادّعاء لا أساس حقيقي له.' }));
    await db.from('optimization_recommendations').insert({ run_id: run.id, recommendation: optimization });

    await db.from('pipeline_runs').update({ status: 'pending_approval', completed_at: new Date().toISOString() }).eq('id', run.id);

    res.json({ runId: run.id, brandIntel, marketIntel, hub, decision, strategy, creative, media, brief: production, analytics, optimization });
  } catch (e) {
    await db.from('pipeline_runs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', run.id);
    res.status(500).json({ error: e.message, runId: run.id });
  }
});

// ---------------------------------------------------------------------------
// GET /api/runs/:runId — لعرض تفاصيل تشغيلة كاملة (تُستخدم من لوحة التحكم)
// ---------------------------------------------------------------------------
app.get('/api/runs/:runId', async (req, res) => {
  const { runId } = req.params;
  const [{ data: run }, { data: stages }, { data: assets }] = await Promise.all([
    db.from('pipeline_runs').select('*').eq('id', runId).single(),
    db.from('pipeline_stages').select('*').eq('run_id', runId),
    db.from('campaign_assets').select('*').eq('run_id', runId),
  ]);
  if (!run) return res.status(404).json({ error: 'run not found' });
  res.json({ run, stages, assets });
});

// ---------------------------------------------------------------------------
// POST /api/runs/:runId/approve — طبقة الحوكمة: موافقة بشرية إلزامية
// يقبل بريد المُوافِق مباشرة بدل UUID مستخدم جاهز، وينشئ المستخدم تلقائيًا إن لم يوجد
// ---------------------------------------------------------------------------
app.post('/api/runs/:runId/approve', async (req, res) => {
  const { runId } = req.params;
  const { approverEmail, approverName, notes } = req.body;
  if (!approverEmail) return res.status(400).json({ error: 'approverEmail مطلوب' });

  try {
    const { data: run } = await db.from('pipeline_runs').select('*, campaigns(brand_id, brands(organization_id))').eq('id', runId).single();
    if (!run) return res.status(404).json({ error: 'run not found' });
    const organizationId = run.campaigns.brands.organization_id;

    let { data: user } = await db.from('users').select('*').eq('email', approverEmail).maybeSingle();
    if (!user) {
      const { data: newUser, error: userErr } = await db.from('users')
        .insert({ organization_id: organizationId, email: approverEmail, full_name: approverName || approverEmail }).select().single();
      if (userErr) throw userErr;
      user = newUser;
    }

    await db.from('approvals').insert({ run_id: runId, approved_by: user.id, decision: 'approved', notes });
    await db.from('pipeline_runs').update({ status: 'approved' }).eq('id', runId);
    res.json({ ok: true, approvedBy: user.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`madar-backend يعمل على المنفذ ${PORT}`));
