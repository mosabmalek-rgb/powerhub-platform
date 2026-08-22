import fs from "node:fs";
const path = "client/src/pages/SettingsPage.tsx";
let source = fs.readFileSync(path, "utf8");
const marker = `</header>\n    {temporaryPassword &&`;
if (!source.includes(marker)) throw new Error("Settings header marker not found");
source = source.replace(marker, `</header>\n    {isSubaccountsRoute && <FlexiblePermissionsPanel siteId={siteId ?? 0} staff={(staffQuery.data ?? []) as never} canManageTeam={canManageTeam} />}\n    {temporaryPassword &&`);
fs.writeFileSync(path, source);
