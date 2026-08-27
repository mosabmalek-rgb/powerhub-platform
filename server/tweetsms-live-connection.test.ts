import { describe, expect, it } from "vitest";
import { checkTweetSmsAccount } from "./tweetsms-client";

const apiKey = process.env.TWEETSMS_API_KEY;
const apiToken = process.env.TWEETSMS_API_TOKEN;

describe.skipIf(!apiKey)("فحص اتصال TweetSMS الحي", () => {
  it("يتحقق من اعتماديات الحساب المركزي دون إرسال رسالة", async () => {
    const result = await checkTweetSmsAccount({
      endpoint: "https://tweetsms.ps",
      credentials: { apiKey: apiKey!, ...(apiToken ? { apiSecret: apiToken } : {}) },
    });
    expect(result.ok, result.message).toBe(true);
  }, 20_000);
});
