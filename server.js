import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, PORT = 3000 } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
  console.error('انقص أحد المتغيرات في .env — راجع .env.example');
  process.exit(1);
}

// service_role يتجاوز RLS بالكامل — لهذا هذا الملف يعمل فقط على الخادم، وأبدًا لا يُرسل هذا المفتاح للمتصفح
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // يقدّم public/index.html على نفس النطاق (بلا مشاكل CORS)

const MODEL = 'claude-sonnet-5'; // للإنتاج: ثبّت نسخة محددة، راجع docs.claude.com/en/docs/about-claude/models/overview

// ---------------------------------------------------------------------------
// طبقة النماذج: استدعاء Claude فعليًا
// ---------------------------------------------------------------------------
async function askClaude(prompt, { json = false, maxTokens = 400 } = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = data.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
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
  const { orgName, brandName, campaignName, goal, targetAudience, market } = req.body;
  if (!orgName || !brandName || !campaignName || !goal) {
    return res.status(400).json({ error: 'orgName, brandName, campaignName, goal مطلوبة' });
  }
  try {
    const { data: org, error: orgErr } = await db.from('organizations').insert({ name: orgName }).select().single();
    if (orgErr) throw orgErr;

    const { data: brand, error: brandErr } = await db.from('brands')
      .insert({ organization_id: org.id, name: brandName }).select().single();
    if (brandErr) throw brandErr;

    const { data: campaign, error: campErr } = await db.from('campaigns')
      .insert({
        brand_id: brand.id, name: campaignName, goal,
        target_audience: targetAudience || null, market: market || null, status: 'active',
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

  const ctx = `العلامة: ${campaign.name}\nالهدف: ${campaign.goal}\nالجمهور: ${campaign.target_audience || 'غير محدد'}\nالسوق: ${campaign.market || 'غير محدد'}`;

  try {
    const [brandIntel, marketIntel] = await Promise.all([
      runStage(run.id, 'brand_intelligence', { ctx }, () =>
        askClaude(`أنت وكيل ذكاء العلامة. بناءً على:\n${ctx}\nاكتب 3 نقاط قصيرة عن تموضع العلامة. عربي، بلا مقدمات.`)),
      runStage(run.id, 'market_intelligence', { ctx }, () =>
        askClaude(`أنت وكيل ذكاء السوق. بناءً على:\n${ctx}\nاكتب 3 نقاط عن سلوك الجمهور والتوقيت المناسب. عربي، بلا مقدمات.`)),
    ]);

    const hub = await runStage(run.id, 'agent_hub', { brandIntel, marketIntel }, () =>
      askClaude(`ادمج هذين المخرجين في 3 نقاط تشغيلية موحدة:\nالعلامة:\n${brandIntel}\nالسوق:\n${marketIntel}\nعربي، بلا مقدمات.`));

    const decision = await runStage(run.id, 'orchestrator', { hub }, () =>
      askClaude(`بناءً على:\n${hub}\nحدد توزيع أولوية (تجمع 100) بين استراتيجية/إبداع/وسائط. أعد فقط JSON: {"strategy":رقم,"creative":رقم,"media":رقم,"reason":"سبب قصير"}`, { json: true }));

    await db.from('orchestrator_decisions').insert({
      run_id: run.id, strategy_weight: decision.strategy, creative_weight: decision.creative,
      media_weight: decision.media, reasoning: decision.reason,
    });

    const [strategy, creative, media] = await Promise.all([
      runStage(run.id, 'strategy', { hub, decision }, () =>
        askClaude(`أنت وكيل الاستراتيجية (أولوية ${decision.strategy}%). بناءً على:\n${hub}\nاكتب خطة من 3 خطوات. عربي، بلا مقدمات.`)),
      runStage(run.id, 'creative', { hub, decision }, () =>
        askClaude(`أنت وكيل الإبداع (أولوية ${decision.creative}%). بناءً على:\n${hub}\nاكتب فكرة رئيسية وجملة إعلانية واحدة. عربي، بلا مقدمات.`)),
      runStage(run.id, 'media', { hub, decision }, () =>
        askClaude(`أنت وكيل الوسائط (أولوية ${decision.media}%). بناءً على:\n${hub}\nاقترح 3 قنوات مع سبب لكل واحدة. عربي، بلا مقدمات.`)),
    ]);

    const production = await runStage(run.id, 'production', { strategy, creative, media }, () =>
      askClaude(`ادمج في فقرة بريف واحدة متماسكة (أقل من 90 كلمة):\nالاستراتيجية:\n${strategy}\nالإبداع:\n${creative}\nالوسائط:\n${media}\nعربي، بلا مقدمات.`, { maxTokens: 250 }));

    await db.from('campaign_assets').insert({ run_id: run.id, asset_type: 'brief', content: production, format: 'text' });
    await runStage(run.id, 'campaign_launch', {}, async () => production);
    await runStage(run.id, 'commerce', {}, async () =>
      'محاكاة: تتطلب ربطًا فعليًا بمزود تجارة/دفع خارجي (Shopify، إلخ) غير منفَّذ في هذا الخادم بعد.');

    const analytics = await runStage(run.id, 'analytics', { production }, () =>
      askClaude(`بناءً على:\n${production}\nقدّر ثلاثة مؤشرات أداء متوقعة (وعي/تفاعل/تحويل) كتقديرات تقريبية، مع توضيح أنها ليست ضمانًا. عربي، بلا مقدمات.`));
    await db.from('analytics_snapshots').insert({ run_id: run.id, metric_name: 'summary', predicted_value: null, unit: 'text' });

    const optimization = await runStage(run.id, 'optimization', { analytics }, () =>
      askClaude(`بناءً على:\n${analytics}\nاقترح تعديلين محددين للدورة القادمة. عربي، بلا مقدمات.`));
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
