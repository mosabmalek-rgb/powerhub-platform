import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { mobileApiSessions, payments, sites, users } from "../drizzle/schema.pg";

describe("مخطط PostgreSQL المتوافق مع Supabase", () => {
  it("يربط جداول وحقول المصادقة الأساسية بأسماء Supabase الفعلية", () => {
    expect(getTableName(users)).toBe("users");
    expect(getTableColumns(users).openId.name).toBe("auth_user_id");
    expect(getTableColumns(users).id.dataType).toBe("number");
    expect(getTableName(sites)).toBe("sites");
  });

  it("يحافظ على المفاتيح المرتبطة بالموبايل والتحصيل بصيغة snake_case", () => {
    expect(getTableName(mobileApiSessions)).toBe("mobile_api_sessions");
    expect(getTableColumns(mobileApiSessions).refreshTokenHash.name).toBe("refresh_token_hash");
    expect(getTableName(payments)).toBe("payments");
    expect(getTableColumns(payments).receiptImageKey.name).toBe("receipt_image_key");
  });
});
