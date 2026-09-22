# تشغيل خادم مدار

## ١. التثبيت
```
cd madar-backend
npm install
cp .env.example .env
```
افتح `.env` واملأ:
- `SUPABASE_URL` و `SUPABASE_SERVICE_ROLE_KEY` (من Supabase → زر Connect → Project API keys)
- `ANTHROPIC_API_KEY` (من console.anthropic.com → API Keys)

**تحذير:** `service_role key` يتجاوز RLS بالكامل. لا تضعه أبدًا في كود يعمل بالمتصفح، ولا ترفع ملف `.env` لأي مستودع Git عام (تأكد أن `.gitignore` يحتوي `.env`).

## ٢. التشغيل محليًا
```
npm start
```
سيعمل الخادم على `http://localhost:3000`.

## ٣. قبل أول تشغيل فعلي: أنشئ بيانات أولية
هذا الخادم يفترض وجود صف في `campaigns` مسبقًا. أسهل طريقة الآن: من Supabase → Table Editor → أضف صفًا يدويًا في:
1. `organizations` (أي اسم)
2. `brands` (مرتبط بـ organization_id)
3. `campaigns` (مرتبط بـ brand_id، مع `name` و `goal`)

انسخ `id` الخاص بالحملة (UUID) لاستخدامه في الخطوة التالية.

## ٤. تشغيل الحلقة فعليًا
```
curl -X POST http://localhost:3000/api/campaigns/PASTE_CAMPAIGN_ID/run
```
سترى في الرد JSON يحتوي البريف النهائي والتحليلات والتوصيات. وبنفس الوقت، افتح Supabase → Table Editor → `pipeline_stages` وستجد كل مرحلة سُجّلت لحظيًا بالحالة والمخرجات.

## ٥. الموافقة (طبقة الحوكمة)
```
curl -X POST http://localhost:3000/api/runs/PASTE_RUN_ID/approve \
  -H "Content-Type: application/json" \
  -d '{"approvedBy":"PASTE_USER_ID"}'
```

## ٦. النشر (خطوة لاحقة)
لتشغيل هذا الخادم بشكل دائم بدل جهازك، انشره على منصة مثل Render أو Railway أو Fly.io — كلها تدعم Node.js مجانًا لمشروع صغير، وتسمح بإضافة متغيرات البيئة (`.env`) من لوحة التحكم بدل الملف المحلي.
