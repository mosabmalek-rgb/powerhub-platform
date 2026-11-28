import { afterEach,beforeEach,describe,expect,it } from "vitest";
import {
  decodeMobileDeltaCursor,encodeMobileDeltaCursor,nextMobileDeltaCursor,
  mobileDeltaScopeVersion,type MobileDeltaCursor,
} from "./mobile-delta-protocol";
const original=process.env.JWT_SECRET;
const scope={tenantId:22,userId:31,branchId:4,sessionId:99,
  scopeVersion:mobileDeltaScopeVersion({tenantId:22,branchId:4,role:"technician",updatedAt:1})};
const cursor:MobileDeltaCursor={
  v:1,mode:"bootstrap",...scope,highwater:80,after:0,ceiling:1000,issuedAt:Date.now(),
};
beforeEach(()=>{process.env.JWT_SECRET="mobile-delta-signed-cursor-test-secret-at-least-32-characters";});
afterEach(()=>{if(original===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=original;});
describe("mobile subscriber Delta cursor security",()=>{
  it("round-trips a signed tenant/device/branch bootstrap and converts only on final page",()=>{
    const token=encodeMobileDeltaCursor(cursor);
    const decoded=decodeMobileDeltaCursor(token,scope);
    expect(decoded).toEqual(cursor);
    const page=nextMobileDeltaCursor(decoded,30,true);
    expect(page.mode).toBe("bootstrap");
    expect(page.after).toBe(30);
    expect(page.highwater).toBe(80);
    const end=nextMobileDeltaCursor(page,1000,false);
    expect(end.mode).toBe("delta");
    expect(end.after).toBe(80);
    expect(end.ceiling).toBe(0);
  });
  it("rejects tampering and all cross-account/tenant/branch/device or changed-ACL reuse",()=>{
    const token=encodeMobileDeltaCursor(cursor);
    expect(()=>decodeMobileDeltaCursor(token+"a",scope)).toThrowError("CURSOR_INVALID");
    for(const [key,value] of Object.entries({
      tenantId:23,userId:32,branchId:5,sessionId:100,scopeVersion:"f".repeat(64),
    })){
      expect(()=>decodeMobileDeltaCursor(token,{...scope,[key]:value})).toThrowError("CURSOR_SCOPE_CHANGED");
    }
  });
  it("rejects expired or future-issued cursors, out-of-range pages and malformed payload",()=>{
    const token=encodeMobileDeltaCursor(cursor);
    expect(()=>decodeMobileDeltaCursor(token,scope,cursor.issuedAt+31*24*3600*1000))
      .toThrowError("CURSOR_EXPIRED");
    expect(()=>decodeMobileDeltaCursor(token,scope,cursor.issuedAt-61_000))
      .toThrowError("CURSOR_INVALID");
    expect(()=>decodeMobileDeltaCursor("not-a-cursor",scope)).toThrowError("CURSOR_INVALID");
    expect(()=>nextMobileDeltaCursor(cursor,1001,true)).toThrowError("CURSOR_INVALID");
    expect(()=>nextMobileDeltaCursor({...cursor,after:12},11,true)).toThrowError("CURSOR_INVALID");
  });
  it("never treats a completed delta as an older snapshot",()=>{
    const state:MobileDeltaCursor={...cursor,mode:"delta",ceiling:0,after:80};
    expect(nextMobileDeltaCursor(state,80,false)).toMatchObject({mode:"delta",after:80});
    expect(()=>nextMobileDeltaCursor(state,81,true)).toThrowError("CURSOR_INVALID");
  });
  it("reopens after 26 hours without bootstrap and transfers only changes after the frozen highwater",()=>{
    const t=Date.now();
    const old={...cursor,mode:"delta" as const,after:80,highwater:80,ceiling:0,issuedAt:t-26*60*60*1000};
    const token=encodeMobileDeltaCursor(old);
    expect(decodeMobileDeltaCursor(token,scope,t)).toEqual(old);
    const reopened=decodeMobileDeltaCursor(token,scope,t);
    // A new subscriber/reading event committed after the previous snapshot.
    // The service raises the highwater from 80 to 82 only on a complete delta.
    const page=nextMobileDeltaCursor({...reopened,highwater:82,issuedAt:t},81,true);
    expect(page.mode).toBe("delta");
    expect(page.after).toBe(81);
    expect(page.highwater).toBe(82);
    const final=nextMobileDeltaCursor(page,82,false);
    expect(final.after).toBe(82);
    expect(final.highwater).toBe(82);
    // Same endpoint with no new committed changes cannot move backwards.
    expect(nextMobileDeltaCursor(final,82,false).after).toBe(82);
    expect(()=>nextMobileDeltaCursor(final,81,false)).toThrowError("CURSOR_INVALID");
  });
  it("rejects an incomplete bootstrap page that claims a cursor outside its fixed ceiling",()=>{
    const initial={...cursor,highwater:12,ceiling:100,after:20};
    expect(()=>nextMobileDeltaCursor(initial,101,true)).toThrowError("CURSOR_INVALID");
    const within=nextMobileDeltaCursor(initial,99,true);
    expect(within.highwater).toBe(12);
    expect(within.ceiling).toBe(100);
    expect(nextMobileDeltaCursor(within,100,false)).toMatchObject({
      mode:"delta",after:12,highwater:12,ceiling:0
    });
  });

});
