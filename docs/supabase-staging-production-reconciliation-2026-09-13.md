# مقارنة Supabase staging وProduction

**التاريخ:** 13 سبتمبر 2026  
**الهدف:** تحديد ما إذا كانت ترحيلات `powerhub-staging-dr` قابلة للنقل مباشرة إلى Production `vvcdiqcyhaloxesvpppc`.

## النتيجة التنفيذية

تأكد أن بعض الترحيلات الحديثة أُجريت فعلاً على مشروع `powerhub-staging-dr`، لكن البيئتين ليستا نسختين متطابقتين ولا يجوز دفع migrations staging إلى Production دفعة واحدة. staging يحتوي خطاً حديثاً ومكثفاً لوظائف الأمن وOffline والموافقات وPlatform Admin وStaff RBAC وحسابات الشركة، بينما Production يحتوي مجموعة أوسع من ميزات الأعمال القديمة والحالية، مع تاريخ migrations مختلف وتسميات مختلفة.

القرار الآمن هو **عدم تنفيذ migration أو نسخ بيانات أو دمج PR #37 تلقائياً الآن**. يجب أولاً إنشاء حزمة reconciliation تعتمد على migration files القابلة لإعادة التنفيذ، ثم اختبارها على نسخة Production مستنسخة أو بيئة pre-production مطابقة، وبعدها تطبيقها على Production ضمن نافذة صيانة مع smoke test وrollback واضح.

## جرد البيئتين

| العنصر | staging | Production |
|---|---|---|
| المشروع | `powerhub-staging-dr` | `mosabmalek-rgb's Project` |
| Project ref | `iyuryuhaylhisjfcrwkz` | `vvcdiqcyhaloxesvpppc` |
| الحالة | ACTIVE_HEALTHY | ACTIVE_HEALTHY |
| PostgreSQL | 17.6.1.166 | 17.6.1.155 |
| عدد migrations المسجل | 51 | 90 |
| آخر migration الظاهر | `reconcile_staff_rbac_and_company_account_rpcs` — `20260912153329` | `fix_subscriber_create_rpc_ambiguity` — `20260911141652` |
| جداول public | 46 | 58 |
| جداول مشتركة | 43 | 43 |

اختلاف عدد migrations لا يعني أن Production متأخر بعدد 39 migration؛ أسماء ومسارات migrations في staging جرى تجميعها أو تسميتها بطريقة مختلفة. لذلك يجب الاعتماد على مقارنة schema وRPC وRLS، لا على رقم migration وحده.

## فروقات الجداول

الجداول الموجودة في staging فقط هي: `emergency_requests` و`sms_dispatch_queue` و`tweet_sms_report_snapshots`.

الجداول الموجودة في Production فقط هي: `access_recovery_requests`، `complaints`، `messaging_schedule_runs`، `meters`، `notification_messages`، `payroll_adjustment_allocations`، `platform_settings`، `platform_sms_fallback_providers`، `platform_tariff_policies`، `platform_tweetsms_accounts`، `platform_tweetsms_balance_alerts`، `subscriber_portal_attempts`، `tenant_payment_receipt_message_templates`، `tenant_tweetsms_accounts`، و`user_quick_action_preferences`.

هذا يثبت أن staging **ليس superset** من Production. ومن أخطر النتائج أن نقل staging كما هو قد يسقط أو يتجاوز ميزات إنتاجية مثل بوابة المشترك، إشعارات الرسائل، إعدادات المنصة، TweetSMS، قوالب إيصالات الدفع، والإجراءات المجدولة.

## فروقات RPCs

staging يضم RPCs حديثة مثل إنشاء وتحديث مولد Offline، مزامنة المولد، الموافقات الذرية للموبايل، إدارة خطط SMS، Platform Access، تجديد الاشتراكات، إعدادات الفروع، والحسابات البنكية.

Production يضم RPCs كثيرة غير ظاهرة في staging، منها `powerhub_create_subscriber`، `powerhub_create_generator_owner_subscription`، `powerhub_create_site`، إجراءات بوابة المشترك، وظائف TweetSMS، وظائف الرواتب، التسويات المالية، الإشعارات، إعدادات التقرير، وإجراءات إدارة المشتركين والمولدات. في المقابل لا تظهر بعض RPCs الحديثة الخاصة بـOffline Generator وPlatform Admin في قائمة Production الحالية.

النتيجة العملية هي أن واجهة أو PR مبنياً على staging قد يستدعي RPC غير موجود في Production، كما أن تطبيق schema staging كاملاً قد يضر ميزات Production الموجودة حالياً. هذا يفسر أهمية معالجة فشل إنشاء المشترك في اختبار QA ضمن عقد Supabase الفعلي للبيئة المنشورة بدلاً من افتراض أن staging وProduction متطابقان.

## علاقة ذلك بـPR #37

PR #37 (`refactor/admin-supabase-migration`) ما زال Draft ومتعارضاً مع `main`، وWorkflow AST-safe فشل في `pnpm check` قبل إنشاء commit retirement بسبب أخطاء TypeScript في واجهات Admin وFinance وMessaging وMeter Readings وPlatform Access وTweetSMS. لذلك لا يُعتبر PR #37 حزمة جاهزة للدمج أو للتحويل إلى Production.

## خطة المصالحة الآمنة

أولاً، يجب تثبيت Production schema كمرجع لا يُحذف منه شيء، ثم استخراج قائمة objects من staging على شكل حزم مستقلة: الأمن وRLS، Platform Access، Staff RBAC، الحسابات البنكية، Offline/Sync، وموافقات الموبايل. كل حزمة تحتاج migration idempotent منفصلة مع فحص وجود الجدول أو الدالة قبل الإنشاء، واختبارات RPC وRLS خاصة بها.

ثانياً، يجب حل تعارضات PR #37 وتشغيل `pnpm check` قبل أي نقاش دمج. لا ينبغي استخدام workflow retirement الحالي كحل وحيد، لأنه يغير `powerhub.ts` آلياً ثم يعتمد على TypeScript فقط؛ يلزم بعده `pnpm test` و`pnpm build` وSecurity وE2E.

ثالثاً، تُطبّق الحزم أولاً على نسخة pre-production مشتقة من Production، ثم تُجرى اختبارات المشترك والمولد والقراءة والفاتورة وOffline/Sync وبوابة المشترك والعزل. لا يجوز تطبيق migrations staging مباشرة على Production.

رابعاً، بعد نجاح pre-production، تُراجع migrations مع سجل Production الحالي، ثم تُطبّق فقط migrations غير الموجودة فعلياً وبترتيب dependency صحيح، مع backup ونقطة rollback وsmoke test بعد كل حزمة. يبقى cutover النهائي قراراً منفصلاً يحتاج اعتماداً صريحاً.

## القرار الحالي

**الحالة:** Migration reconciliation required.  
**Production:** لم يتغير.  
**Staging:** يحتوي ترقيات حقيقية ومفيدة، لكنه ليس نسخة جاهزة للترقية المباشرة.  
**PR #37:** غير جاهز بسبب التعارض وفشل TypeScript.  
**التوصية:** إصلاح عقد RPC لإنشاء المشترك أولاً، ثم بناء reconciliation bundle صغيرة، ثم اختبارها على نسخة Production قبل أي cutover.

## مراجع التدقيق

1. نتائج Supabase MCP لمشروع staging `iyuryuhaylhisjfcrwkz` بتاريخ 13 سبتمبر 2026.
2. نتائج Supabase MCP لمشروع Production `vvcdiqcyhaloxesvpppc` بتاريخ 13 سبتمبر 2026.
3. GitHub PR #37: https://github.com/mosabmalek-rgb/powerhub-platform/pull/37
4. سجل Workflow `PowerHub retire legacy once v2` الذي فشل في `pnpm check` قبل إنشاء commit.
