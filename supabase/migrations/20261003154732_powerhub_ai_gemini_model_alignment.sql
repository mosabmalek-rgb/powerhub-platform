-- Keep the production AI settings aligned with the server-side Gemini provider.
-- AI remains disabled by default; this only fixes the stored model name.
update private.chat_ai_settings
set model = 'gemini-2.5-flash'
where id = true
  and model <> 'gemini-2.5-flash';
