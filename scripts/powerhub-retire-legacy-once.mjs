import fs from "node:fs";

const file = "server/powerhub.ts";
let source = fs.readFileSync(file, "utf8");

function skipString(text, index) {
  const quote = text[index];
  if (quote === "`" ) {
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index] === "`" ) return index + 1;
      index += 1;
    }
    throw new Error("Unterminated template string");
  }
  index += 1;
  while (index < text.length) {
    if (text[index] === "\\") { index += 2; continue; }
    if (text[index] === quote) return index + 1;
    index += 1;
  }
  throw new Error("Unterminated string");
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") { i = skipString(text, i) - 1; continue; }
    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i + 2); i = end === -1 ? text.length : end; continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2); i = end === -1 ? text.length : end + 1; continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`No matching brace at ${openIndex}`);
}

function removeFunction(name) {
  const patterns = [
    new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`),
    new RegExp(`(?:async\\s+)?function\\s+${name}\\s*<`),
  ];
  let match = null;
  for (const pattern of patterns) {
    const found = pattern.exec(source);
    if (found && (!match || found.index < match.index)) match = found;
  }
  if (!match) return false;
  const bodyStart = source.indexOf("{", match.index);
  if (bodyStart === -1) throw new Error(`Missing body for ${name}`);
  const bodyEnd = findMatchingBrace(source, bodyStart);
  let end = bodyEnd + 1;
  while (end < source.length && /\s/.test(source[end])) end += 1;
  if (source[end] === ";") end += 1;
  source = source.slice(0, match.index) + source.slice(end);
  return true;
}

function replaceProcedureBody(name, message) {
  const marker = `\n    ${name}:`;
  const propertyStart = source.indexOf(marker);
  if (propertyStart === -1) return false;
  const bodyArrow = source.indexOf("=> {", propertyStart);
  if (bodyArrow === -1) throw new Error(`Procedure ${name} has no function body`);
  const bodyStart = source.indexOf("{", bodyArrow);
  const bodyEnd = findMatchingBrace(source, bodyStart);
  const replacement = `{\n      throw new TRPCError({ code: "PRECONDITION_FAILED", message: ${JSON.stringify(message)} });\n    }`;
  source = source.slice(0, bodyStart) + replacement + source.slice(bodyEnd + 1);
  return true;
}

const deadFunctions = [
  "dbOrThrow",
  "insertId",
  "getSiteTenant",
  "issueInvoiceForApprovedReading",
  "approveAndIssueMobileReading",
  "ownerLimitOverride",
  "ownerAllowedSubaccountRoles",
  "ownerSubaccountLimit",
  "activeSubaccountCount",
  "ownerSubscriberQuota",
  "recordSubscriberQuotaAlert",
  "tenantBranchPolicy",
  "resolveRole",
  "resolveAccess",
  "enforcePlatformRolePolicy",
  "requireRole",
  "requireAllBranchRole",
  "writeAudit",
  "assertFinancialPeriodOpen",
  "queueInvoiceNotificationsForSelection",
  "dispatchInvoiceNotifications",
];
for (const name of deadFunctions) removeFunction(name);

const disabledProcedures = {
  retry: "إعادة محاولة الإشعارات معطّلة حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel.",
  retryFailedInvoiceNotification: "إعادة إرسال الفواتير معطّلة حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel.",
  retryFailedInvoiceNotifications: "إعادة الإرسال الجماعي للفواتير معطّلة حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel.",
  retryPaymentReceipt: "إعادة إرسال إيصالات الدفع معطّلة حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel.",
  sendDeferredInvoices: "إرسال الفواتير المؤجلة معطّل حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel.",
  sendBulkInvoiceSms: "إرسال فواتير SMS الجماعي معطّل حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel.",
  sendPaymentReminder: "إرسال تذكيرات السداد معطّل حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel.",
  sendPaymentReceipt: "إرسال إيصالات الدفع معطّل حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel.",
};
for (const [name, message] of Object.entries(disabledProcedures)) replaceProcedureBody(name, message);

source = source.replace(/import \{ and, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql \} from "drizzle-orm";\n/g, "");
source = source.replace(/import \{\n  auditLogs,[\s\S]*?\n\} from "\.\.\/drizzle\/schema";\n/g, "");
source = source.replace(/import \{ getDb, syncSupabaseUser \} from "\.\/db";\n/g, "");

fs.writeFileSync(file, source);
console.log(`Updated ${file}: removed Legacy DB helpers and disabled unreachable MySQL notification paths.`);
