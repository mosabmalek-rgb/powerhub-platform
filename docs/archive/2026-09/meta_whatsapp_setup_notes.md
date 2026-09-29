# Meta WhatsApp Setup Notes

- **التطبيق:** pawerhup
- **معرف التطبيق:** `1374506591437532`
- **حافظة الأعمال المحددة:** PowerHub
- **معرف حافظة الأعمال في رابط الإعداد:** `1366334479025003`
- **الرابط:** https://developers.facebook.com/apps/1374506591437532/use_cases/customize/?use_case_enum=WHATSAPP_BUSINESS_MESSAGING&product_route=whatsapp-business&selected_tab=overview&business_id=1366334479025003
- **الحالة:** تم تفعيل منصة WhatsApp للأعمال للتطبيق، ووصلت لوحة الإعداد إلى المسار الموجّه للـ Cloud API.
- **الخطوة التالية للاختبار:** https://developers.facebook.com/apps/1374506591437532/whatsapp-business/api-testing-v2/?business_id=1366334479025003
- **إعداد التشغيل:** https://developers.facebook.com/apps/1374506591437532/whatsapp-business/wa-configurations-v2/?business_id=1366334479025003
- **التحقق من النشاط التجاري:** https://developers.facebook.com/apps/1374506591437532/whatsapp-business/business-verification/?business_id=1366334479025003
- **ملاحظة Meta:** توفر الخطوة الأولى رقم WhatsApp اختباري لإرسال رسائل تجريبية؛ وتحتاج رسائل العملاء الفعلية إلى إعداد التشغيل ورقم نشاط تجاري والتحقق من النشاط.
- **لا تُخزن هنا:** رموز الوصول، الرموز السرية للتحقق، أرقام الهواتف أو رموز SMS.
- **هيكل PowerHub:** يُحفظ Phone Number ID واسم القالب ورمز الوصول لكل مستأجر في واجهة `/notifications`، ويُشفَّر رمز الوصول وMeta App Secret، بينما يُحفظ رمز تحقق Webhook كبصمة فقط.
- **رابط Webhook لكل مستأجر:** `https://<نطاق-النشر>/api/webhooks/whatsapp/<tenantId>`؛ يجب وضع Verify Token نفسه في Meta وفي إعداد المستأجر، ووضع Meta App Secret في الحقل المخصص قبل تفعيل الاشتراك في حالات الرسائل.
- **عامل الإرسال:** نقطة Heartbeat هي `/api/scheduled/process-notifications`. لا تنشئ المهمة المجدولة قبل نشر نسخة PowerHub التي تتضمن هذا المسار؛ بعدها تُنشأ مهمة تشغيل كل دقيقة من حساب مالك المشروع.
