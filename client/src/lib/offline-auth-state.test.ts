import { describe, expect, it } from "vitest";
import { resolveOfflineAuthTransition } from "./offline-auth-state";

describe("offline authentication state transitions", () => {
  it("preserves the offline lease when the initial session is absent", () => {
    expect(resolveOfflineAuthTransition("INITIAL_SESSION", null, false)).toBe("recover-offline-session");
  });

  it("does not interpret a non-explicit missing session as a deliberate logout", () => {
    expect(resolveOfflineAuthTransition("SIGNED_OUT", null, false)).toBe("recover-offline-session");
  });

  it("clears offline access after an explicit logout", () => {
    expect(resolveOfflineAuthTransition("SIGNED_OUT", null, true)).toBe("explicit-sign-out");
  });

  it("does not restore an offline lease while an explicit logout is still being finalized", () => {
    expect(resolveOfflineAuthTransition("INITIAL_SESSION", null, true)).toBe("explicit-sign-out");
  });

  it("prefers a real online session when one is present", () => {
    expect(resolveOfflineAuthTransition("SIGNED_IN", "user-123", false)).toBe("online-session");
  });
});
