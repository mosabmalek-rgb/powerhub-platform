import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(projectRoot, "drizzle/schema.ts");
const outputPath = resolve(projectRoot, "drizzle/schema.pg.ts");

function snakeCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

let schema = await readFile(sourcePath, "utf8");

schema = schema.replace(
  /import \{[\s\S]*?\} from "drizzle-orm\/mysql-core";/,
  `import {
  bigint,
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const pgEnumText = <T extends readonly string[]>(name: string, _values: T) =>
  varchar(name, { length: 64 }).$type<T[number]>();`
);

schema = schema
  .replaceAll("mysqlTable", "pgTable")
  .replaceAll("mysqlEnum", "pgEnumText")
  .replaceAll("json(", "jsonb(")
  .replaceAll("int(", "integer(")
  .replace(/\.onUpdateNow\(\)/g, "");

schema = schema.replace(/pgTable\("([A-Za-z][A-Za-z0-9]*)"/g, (_, tableName) => `pgTable("${snakeCase(tableName)}"`);
schema = schema
  .replaceAll('pgTable("tenant_tweet_sms_accounts"', 'pgTable("tenant_tweetsms_accounts"')
  .replaceAll('pgTable("platform_tweet_sms_accounts"', 'pgTable("platform_tweetsms_accounts"')
  .replaceAll('pgTable("platform_tweet_sms_balance_alerts"', 'pgTable("platform_tweetsms_balance_alerts"');
schema = schema.replace(/\b(boolean|decimal|integer|jsonb|text|timestamp|varchar|pgEnumText)\("([A-Za-z][A-Za-z0-9]*)"/g, (_, builder, columnName) => `${builder}("${snakeCase(columnName)}"`);
schema = schema
  .replace(/\bid: integer\("id"\)\.autoincrement\(\)/g, 'id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity()')
  .replace(/\b([A-Za-z][A-Za-z0-9]*Id): integer\(("[a-z0-9_]+")\)/g, '$1: bigint($2, { mode: "number" })');

schema = schema.replace(
  /openId: varchar\("open_id", \{ length: 64 \}\)\.notNull\(\)\.unique\(\)/,
  'openId: uuid("auth_user_id").notNull().unique()'
);

schema = `// AUTO-GENERATED FROM drizzle/schema.ts. Review against supabase/migrations before use.\n${schema}`;
await writeFile(outputPath, schema, "utf8");
console.log(`Generated ${outputPath}`);
