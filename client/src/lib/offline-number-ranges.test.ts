import { describe, expect, it } from "vitest";
import {
  formatOfflineNumber,
  selectNextAvailableOfflineNumber,
  validateOfflineNumberGrant,
  type OfflineNumberClaim,
  type OfflineNumberGrant,
} from "./offline-number-ranges";

const now = Date.parse("2026-10-24T09:00:00.000Z");
const scope = { userId: 7, tenantId: 12, siteId: 3, deviceId: "b0d7f3f1-3d40-4c2b-9f61-8e9a2fddcc12" };
const subscriberGrant: OfflineNumberGrant = {
  ...scope,
  id: "d7e24e13-b0aa-4c0a-a4e8-2c93f3c9e5f1",
  numberKind: "subscriber",
  partitionKey: "global",
  reservedValues: ["42", "43", "44"],
  issuedAt: now - 1000,
  expiresAt: now + 60_000,
};

function claim(value: string, operation: string, grantId = subscriberGrant.id): OfflineNumberClaim {
  return {
    id: `claim-${value}`, grantId, ...scope, numberKind: "subscriber", partitionKey: "global",
    numberValue: value, clientOperationId: operation, entityType: "subscriber", createdAt: now,
  };
}

describe("offline number range foundation", () => {
  it("formats subscriber and invoice references without changing reserved values", () => {
    expect(formatOfflineNumber("subscriber", "global", "42")).toBe("SUB-000042");
    expect(formatOfflineNumber("invoice", "2026", "19")).toBe("INV-2026-00000019");
  });

  it("rejects numbers that cannot be represented by the official subscriber format", () => {
    expect(() => formatOfflineNumber("subscriber", "global", "1000000")).toThrowError(/رقم المشترك/);
    expect(() => formatOfflineNumber("subscriber", "2026", "42")).toThrowError(/رقم المشترك/);
    expect(() => formatOfflineNumber("invoice", "26", "1")).toThrowError(/سنة الفاتورة/);
    expect(() => formatOfflineNumber("invoice", "2026", "100000000")).toThrowError(/ثمانية أرقام/);
  });

  it("validates grant size, dates, and unique values", () => {
    expect(validateOfflineNumberGrant(subscriberGrant, now)).toBe(true);
    expect(() => validateOfflineNumberGrant({ ...subscriberGrant, expiresAt: now }, now)).toThrowError(/انتهت صلاحية/);
    expect(() => validateOfflineNumberGrant({ ...subscriberGrant, reservedValues: ["42", "42"] }, now)).toThrowError(/مكررة/);
    expect(() => validateOfflineNumberGrant({ ...subscriberGrant, reservedValues: Array.from({ length: 201 }, (_, i) => String(i + 1)) }, now)).toThrowError(/حجم نطاق/);
  });

  it("allocates the next unused value and never reuses a claim", () => {
    const result = selectNextAvailableOfflineNumber({
      grant: subscriberGrant, claims: [claim("42", "op-1")], scope,
      clientOperationId: "op-2", entityType: "subscriber", now,
    });
    expect(result).toMatchObject({ numberValue: "43", formattedNumber: "SUB-000043", replayed: false });
  });

  it("replays the same operation with the same number instead of allocating another", () => {
    const existing = claim("42", "stable-operation");
    const result = selectNextAvailableOfflineNumber({
      grant: subscriberGrant, claims: [existing], scope,
      clientOperationId: "stable-operation", entityType: "subscriber", now,
    });
    expect(result).toMatchObject({ claim: existing, formattedNumber: "SUB-000042", replayed: true });
  });

  it("refuses a grant from a different user, tenant, site, or device", () => {
    for (const changed of [
      { ...scope, userId: 8 },
      { ...scope, tenantId: 99 },
      { ...scope, siteId: 4 },
      { ...scope, deviceId: "a0d7f3f1-3d40-4c2b-9f61-8e9a2fddcc12" },
    ]) {
      expect(() => selectNextAvailableOfflineNumber({
        grant: subscriberGrant, claims: [], scope: changed, clientOperationId: "op", entityType: "subscriber", now,
      })).toThrowError(/لا يخص المستخدم/);
    }
  });

  it("rejects exhausted grants and entity-kind mismatches", () => {
    expect(() => selectNextAvailableOfflineNumber({
      grant: subscriberGrant, claims: subscriberGrant.reservedValues.map((value) => claim(value, `op-${value}`)),
      scope, clientOperationId: "next", entityType: "subscriber", now,
    })).toThrowError(/استهلكت جميع الأرقام/);
    expect(() => selectNextAvailableOfflineNumber({
      grant: subscriberGrant, claims: [], scope, clientOperationId: "invoice-op", entityType: "invoice", now,
    })).toThrowError(/نوع الرقم/);
  });

  it("replays the same claim after expiry or revocation without allocating a new number", () => {
    const existing = claim("42", "stable-after-expiry");
    const expiredGrant = { ...subscriberGrant, expiresAt: now - 1 };
    expect(selectNextAvailableOfflineNumber({
      grant: expiredGrant, claims: [existing], scope,
      clientOperationId: "stable-after-expiry", entityType: "subscriber", now,
    })).toMatchObject({ claim: existing, formattedNumber: "SUB-000042", replayed: true });

    expect(() => selectNextAvailableOfflineNumber({
      grant: expiredGrant, claims: [], scope,
      clientOperationId: "new-operation", entityType: "subscriber", now,
    })).toThrowError(/انتهت صلاحية/);

    expect(selectNextAvailableOfflineNumber({
      grant: { ...subscriberGrant, revokedAt: now - 1 }, claims: [existing], scope,
      clientOperationId: "stable-after-expiry", entityType: "subscriber", now,
    })).toMatchObject({ claim: existing, formattedNumber: "SUB-000042", replayed: true });
  });

  it("rejects a replay whose claimed number is outside the reserved grant values", () => {
    const tampered = claim("99", "stable-operation");
    expect(() => selectNextAvailableOfflineNumber({
      grant: subscriberGrant, claims: [tampered], scope,
      clientOperationId: "stable-operation", entityType: "subscriber", now,
    })).toThrowError(/نطاق أو رقم مختلف/);
  });

  it("does not allow a replay to change the scope or grant", () => {
    const existing = claim("42", "same-operation", "different-grant");
    expect(() => selectNextAvailableOfflineNumber({
      grant: subscriberGrant, claims: [existing], scope, clientOperationId: "same-operation",
      entityType: "subscriber", now,
    })).toThrowError(/نطاق مختلف/);
  });
});
