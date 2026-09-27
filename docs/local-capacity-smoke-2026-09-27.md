# Local capacity smoke — 2026-09-27

تم تشغيل أداة `scripts/powerhub-capacity-smoke.mjs` على endpoint الصحة المحلي فقط:

- الهدف: `http://127.0.0.1:3000/api/health`
- المدة: 5 ثوانٍ
- التزامن: 5 workers
- الطلبات: 33,933
- الناجح: 33,933
- الفاشل: 0
- throughput المقاس: 6,786.6 طلب/ثانية
- latency p50: 0.55ms
- latency p95: 1.77ms
- latency p99: 3.67ms

هذه نتيجة صحة HTTP محلية وليست benchmark لرحلات Supabase أو الفواتير أو SMS، ولا تصلح لإثبات تحمل 1,000,000 فاتورة أسبوعيًا. اختبار staging الحقيقي يجب أن يستخدم بيانات صناعية معزولة، endpoint مصادقًا أو مسارًا تجريبيًا، ومراقبة Postgres/Vercel/Supabase أثناء القياس.

لم يتم استهداف Production ولم يتم تعديل بيانات خارجية.
