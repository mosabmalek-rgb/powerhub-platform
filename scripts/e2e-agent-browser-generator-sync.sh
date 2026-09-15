#!/usr/bin/env bash
set -euo pipefail

: "${POWERHUB_E2E_URL:?Set POWERHUB_E2E_URL to the Preview/base URL}"
: "${POWERHUB_E2E_AUTH_STATE:?Set POWERHUB_E2E_AUTH_STATE to a locally stored authenticated Agent Browser state file}"
: "${POWERHUB_E2E_USER_ID:?Set POWERHUB_E2E_USER_ID to the authenticated PowerHub user id}"
: "${POWERHUB_E2E_SITE_ID:?Set POWERHUB_E2E_SITE_ID to an allowed site id}"

command -v agent-browser >/dev/null 2>&1 || {
  echo "agent-browser is required for this E2E test." >&2
  exit 127
}

SESSION="powerhub-generator-sync"
BASE_URL="${POWERHUB_E2E_URL%/}"

agent-browser --session "$SESSION" state load "$POWERHUB_E2E_AUTH_STATE"
agent-browser --session "$SESSION" open "$BASE_URL/generators"
agent-browser --session "$SESSION" wait --load networkidle
agent-browser --session "$SESSION" snapshot -i
agent-browser --session "$SESSION" get url

agent-browser --session "$SESSION" eval --stdin <<EVAL
(async () => {
  const userId = ${POWERHUB_E2E_USER_ID};
  const siteId = ${POWERHUB_E2E_SITE_ID};
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("powerhub-offline-workspace", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("operations")) {
        request.result.createObjectStore("operations", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const id = crypto.randomUUID();
  const now = Date.now();
  const record = {
    id,
    clientOperationId: id,
    userId,
    siteId,
    kind: "generator_create",
    payload: {
      code: "E2E-GEN-LOCAL",
      name: "E2E Offline Generator",
      serialNumber: "E2E-LOCAL",
      ratedCapacityKw: "10",
      fuelType: "diesel"
    },
    createdAt: now,
    updatedAt: now,
    status: "pending"
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction("operations", "readwrite");
    tx.objectStore("operations").put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return JSON.stringify({ seeded: true, id, userId, siteId });
})()
EVAL

agent-browser --session "$SESSION" open "$BASE_URL/generators"
agent-browser --session "$SESSION" wait --load networkidle
agent-browser --session "$SESSION" snapshot -i

BODY="$(agent-browser --session "$SESSION" get text body)"
grep -q "مركز مزامنة المسودات" <<<"$BODY"
grep -q "مزامنة المعلقة (1)" <<<"$BODY"
grep -q "بانتظار المزامنة" <<<"$BODY"

echo "PASS: authenticated Generator route exposes the offline sync panel with a pending local generator operation."
echo "PASS: test does not click the sync action; no server-side generator mutation is performed."

agent-browser --session "$SESSION" screenshot --full
agent-browser --session "$SESSION" close
