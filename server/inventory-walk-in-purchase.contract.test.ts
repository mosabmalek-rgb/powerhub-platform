import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const migration=readFileSync("supabase/migrations/20261109090000_powerhub_walk_in_immediate_purchase.sql","utf8");
const panel=readFileSync("client/src/components/InventoryPurchasesPanel.tsx","utf8");
const route=readFileSync("server/powerhub-inventory-router.ts","utf8");

describe("unregistered walk-in supplier immediate purchase contracts",()=>{
  it("never allows deferred purchases or a partial client-side payment sequence",()=>{
    expect(panel).toContain('__walk_in__');
    expect(panel).toContain('غير مسجل — شراء فوري فقط');
    expect(panel).toContain('setPaymentMode("immediate")');
    expect(panel).toContain('if (isWalkInSupplier && paymentMode !== "immediate")');
    expect(panel).toContain('kind: "inventory_walk_in_purchase_immediate"');
    expect(panel).toContain('createWalkInPurchase.mutateAsync');
    expect(panel).toContain('pendingSettlementRef.current = null;');
    expect(route).toContain('createWalkInPurchase: protectedProcedure');
    for (const cap of ["createPurchases","approvePurchases","manageSupplierPayments"]) {
      expect(route).toContain('"'+cap+'"');
    }
  });
  it("preserves mandatory FK ledger integrity and commits purchase, approval and payment atomically",()=>{
    expect(migration).toContain("LANGUAGE plpgsql SECURITY INVOKER");
    expect(migration).toContain('v_supplier_code:=\'WALKIN-\'');
    expect(migration).toContain("powerhub_inventory_create_supplier_with_type");
    expect(migration).toContain("powerhub_inventory_create_purchase");
    expect(migration).toContain("powerhub_inventory_confirm_purchase");
    expect(migration).toContain("powerhub_inventory_record_supplier_payment");
    expect(migration).toContain("walk_in_payload_hash");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(migration).toContain("WALK_IN_PAYMENT_INCOMPLETE");
    expect(migration).toContain("SET is_active=false,updated_at=now()");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(migration).toContain("FROM PUBLIC,anon,authenticated");
    expect(migration).toContain("TO service_role");
  });
});
