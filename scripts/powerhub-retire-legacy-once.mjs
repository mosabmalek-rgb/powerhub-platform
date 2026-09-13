import fs from "node:fs";
const file="server/powerhub.ts";
let source=fs.readFileSync(file,"utf8");
function skipString(t,i){const q=t[i];i++;while(i<t.length){if(t[i]==="\\"){i+=2;continue}if(t[i]===q)return i+1;i++}throw Error("unterminated string")}
function matchBrace(t,s){let d=0;for(let i=s;i<t.length;i++){if(["'","\"","`"].includes(t[i])){i=skipString(t,i)-1;continue}if(t[i]==="{")d++;else if(t[i]==="}"&&!--d)return i}throw Error("unbalanced braces")}
function removeFn(name){const r=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);const m=r.exec(source);if(!m)return;const b=source.indexOf("{",m.index);const e=matchBrace(source,b)+1;source=source.slice(0,m.index)+source.slice(e)}
for(const n of ["dbOrThrow","insertId","getSiteTenant","issueInvoiceForApprovedReading","approveAndIssueMobileReading","ownerLimitOverride","ownerAllowedSubaccountRoles","ownerSubaccountLimit","activeSubaccountCount","ownerSubscriberQuota","recordSubscriberQuotaAlert","tenantBranchPolicy","resolveRole","resolveAccess","enforcePlatformRolePolicy","requireRole","requireAllBranchRole","writeAudit","assertFinancialPeriodOpen","queueInvoiceNotificationsForSelection","dispatchInvoiceNotifications"])removeFn(n);
source=source.replace(/import \{ and, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql \} from "drizzle-orm";\n/g,"");
source=source.replace(/import \{\n  auditLogs,[\s\S]*?\n\} from "\.\.\/drizzle\/schema";\n/g,"");
source=source.replace(/import \{ getDb, syncSupabaseUser \} from "\.\/db";\n/g,"");
fs.writeFileSync(file,source);
