# تشغيل التهيئة البعيدة لتطبيق PowerHub Android

## المرجع الحالي

| العنصر | القيمة |
|---|---|
| عنوان PowerHub المؤقت | `https://powerhup-com-ps.vercel.app/` |
| صفحة Secret Gist | `https://gist.github.com/mosabmalek-rgb/cfcd6523cb869d02ed6be4852a7db1be` |
| رابط الملف الخام | `https://gist.githubusercontent.com/mosabmalek-rgb/cfcd6523cb869d02ed6be4852a7db1be/raw/powerhub-mobile-config.json` |
| ملف التهيئة | `powerhub-mobile-config.json` |
| الحماية | HTTPS وتوقيع Ed25519؛ التطبيق يرفض الملف غير الموقّع أو الرابط غير الآمن. |

## عند شراء الدومين

لا يلزم نشر APK جديد. حدّث `api_base_url` إلى جذر الدومين الجديد المنتهي بشرطة مائلة، ثم وقّع الملف بالمفتاح الخاص الخاص بالتهيئة البعيدة وارفع المحتوى الجديد إلى **نفس** Secret Gist. ارفع رقم `config_version` عند كل تغيير لتسهيل المراجعة والتدقيق.

```bash
POWERHUB_REMOTE_CONFIG_PRIVATE_KEY=/secure/path/remote-config-ed25519-private.pem \
  ./scripts/sign-remote-config.sh 2 https://powerhub.example.com/ > powerhub-mobile-config.json
```

> لا ترفع مفتاح التهيئة الخاص إلى GitHub أو Gist. لا تغيّر المفتاح العام المضمّن في APK؛ لأن تغييره يتطلب بناء APK جديداً لأسباب أمنية.
