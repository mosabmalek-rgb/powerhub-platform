import fs from "node:fs";

const pagePath = "client/src/pages/MessagingSettingsPage.tsx";
const testPath = "client/src/pages/MessagingSettingsPage.ui.test.tsx";

const page = fs.readFileSync(pagePath, "utf8");
const replacements = [
  [
    '{available.whatsapp ? <ChannelForm title="إعداد WhatsApp Cloud API" channel="whatsapp" existing={configs.find((item) => item.channel === "whatsapp")} pending={saveConfig.isPending} onSubmit={saveConfig.mutate} siteId={siteId!} /> : null}<TweetSmsStatusCard',
    '<TweetSmsStatusCard',
  ],
  [
    '{available.sms && owner ? <AutoSendScheduleCard siteId={siteId!} config={smsConfig} cron={autoSendCron} setCron={setAutoSendCron} pending={autoSendMutation.isPending} onToggle={(enabled) => autoSendMutation.mutate({ siteId: siteId!, enabled, cron: autoSendCron })} /> : null}',
    '',
  ],
  ['canRetry={canRetry}', 'canRetry={false}'],
  ['canRetry={owner}', 'canRetry={false}'],
  ['    {owner ? <ScheduleRunLog rows={scheduleRunsQuery.data ?? []} loading={scheduleRunsQuery.isLoading} /> : null}\n', ''],
];

let patchedPage = page;
for (const [needle, replacement] of replacements) {
  const count = patchedPage.split(needle).length - 1;
  if (count !== 1) throw new Error(`Expected exactly one match for page patch, found ${count}: ${needle.slice(0, 100)}`);
  patchedPage = patchedPage.replace(needle, replacement);
}

const test = fs.readFileSync(testPath, "utf8");
const testReplacements = [
  [
    '    expect(screen.getByText("اسم قالب إيصال الدفع المعتمد")).toBeInTheDocument();',
    '    expect(screen.queryByText("اسم قالب إيصال الدفع المعتمد")).not.toBeInTheDocument();',
  ],
  [
    '    expect(screen.getAllByRole("button", { name: "إعادة إرسال" }).length).toBeGreaterThanOrEqual(1);',
    '    expect(screen.queryAllByRole("button", { name: "إعادة إرسال" })).toHaveLength(0);',
  ],
  [
    '    expect(screen.getAllByRole("button", { name: "اختبار الاتصال" })).toHaveLength(1);',
    '    expect(screen.queryAllByRole("button", { name: "اختبار الاتصال" })).toHaveLength(0);',
  ],
  [
    '    expect(screen.getByText("تنبيهات التحصيل والمتأخرات")).toBeInTheDocument();',
    '    expect(screen.getByText("تنبيهات التحصيل والمتأخرات")).toBeInTheDocument();\n    expect(screen.queryByText("الإرسال التلقائي بعد اعتماد القراءات")).not.toBeInTheDocument();\n    expect(screen.queryByText("سجل تشغيل المهام المجدولة")).not.toBeInTheDocument();',
  ],
];

let patchedTest = test;
for (const [needle, replacement] of testReplacements) {
  const count = patchedTest.split(needle).length - 1;
  if (count !== 1) throw new Error(`Expected exactly one test match, found ${count}: ${needle}`);
  patchedTest = patchedTest.replace(needle, replacement);
}

fs.writeFileSync(pagePath, patchedPage);
fs.writeFileSync(testPath, patchedTest);

console.log("Visible feature contract cleanup applied.");
