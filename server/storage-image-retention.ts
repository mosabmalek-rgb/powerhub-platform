import { supabaseAdmin } from "./supabase-admin";
import { STORAGE_BUCKET } from "./storage";

export const STORAGE_IMAGE_RETENTION_DAYS = 15;
const PAGE_SIZE = 1000;
const MAX_DEPTH = 20;
// Retention is restricted to application-owned upload namespaces. Never walk the whole bucket.
export const STORAGE_IMAGE_RETENTION_PREFIXES = ["payment-receipts", "subscriber-readings", "chat"] as const;
const IMAGE_EXT = /\.(?:avif|apng|bmp|gif|heic|heif|ico|jpe?g|jfif|png|svg|tif|tiff|webp)$/i;

type Entry = { id: string | null; name: string; created_at?: string | null; metadata?: Record<string, unknown> | null };
type DbResult = { error: { message: string } | null };
type Admin = {
  storage: {
    listBuckets(): Promise<{data:Array<{id:string}>|null;error:{message:string}|null}>;
    from(bucket:string): {
      list(path:string,options:{limit:number;offset:number;sortBy:{column:"name";order:"asc"}}):Promise<{data:Entry[]|null;error:{message:string}|null}>;
      remove(paths:string[]):Promise<{data:unknown;error:{message:string}|null}>;
    };
  };
  from(table:string): {
    select(columns:string): any;
    update(values:Record<string,unknown>): any;
  };
};

function isFolder(entry:Entry){return entry.id===null && entry.created_at==null && entry.metadata==null;}
export function isImageEntry(entry:Pick<Entry,"name"|"metadata">){
  const mime=String(entry.metadata?.mimetype??entry.metadata?.mimeType??entry.metadata?.contentType??"").split(";")[0].trim().toLowerCase();
  return mime ? mime.startsWith("image/") : IMAGE_EXT.test(entry.name);
}
export function imageIsExpired(entry:Entry,cutoff:Date){
  if(!isImageEntry(entry)||!entry.created_at)return false;
  const created=Date.parse(entry.created_at);
  return Number.isFinite(created)&&created<=cutoff.getTime();
}
function pathJoin(prefix:string,name:string){return prefix?prefix+"/"+name:name;}

export function isEligibleImageRetentionKey(key:string){
  return STORAGE_IMAGE_RETENTION_PREFIXES.some((prefix)=>key.startsWith(`${prefix}/`));
}

async function listProtectedBrandKeys(admin:Admin,bucket:string):Promise<Set<string>>{
  const keys=new Set<string>();
  if(bucket!==STORAGE_BUCKET)return keys;
  for(const [table,column] of [["site_portal_settings","logo_key"],["tenant_owner_profiles","report_logo_key"]] as const){
    let from=0;
    while(true){
      const {data,error}=await admin.from(table).select(column).not(column,"is",null).range(from,from+PAGE_SIZE-1);
      if(error)throw new Error(`Unable to read protected brand image references from ${table}: ${error.message}`);
      const rows=(data??[]) as Array<Record<string,unknown>>;
      for(const row of rows){const key=row[column];if(typeof key==="string"&&key.trim())keys.add(key);}
      if(rows.length<PAGE_SIZE)break;
      from+=rows.length;
    }
  }
  return keys;
}

async function scanBucket(admin:Admin,bucket:string,prefix:string,cutoff:Date,protectedKeys:Set<string>,depth=0):Promise<{expired:string[];scanned:number;skipped:number}>{
  if(depth>MAX_DEPTH)throw new Error("Storage folder nesting exceeds the safety limit.");
  const folders:string[]=[];const expired:string[]=[];let scanned=0;let skipped=0;let offset=0;
  while(true){
    const {data,error}=await admin.storage.from(bucket).list(prefix,{limit:PAGE_SIZE,offset,sortBy:{column:"name",order:"asc"}});
    if(error)throw new Error(error.message);
    const entries=data??[];
    for(const entry of entries){
      if(!entry.name)continue;
      const path=pathJoin(prefix,entry.name);
      if(isFolder(entry)){folders.push(path);continue;}
      scanned++;
      if(!isImageEntry(entry))continue;
      if(!entry.created_at||!Number.isFinite(Date.parse(entry.created_at))){skipped++;continue;}
      if(!protectedKeys.has(path)&&imageIsExpired(entry,cutoff))expired.push(path);
    }
    if(entries.length<PAGE_SIZE)break;
    offset+=entries.length;
  }
  for(const folder of folders){
    const nested=await scanBucket(admin,bucket,folder,cutoff,protectedKeys,depth+1);
    expired.push(...nested.expired);scanned+=nested.scanned;skipped+=nested.skipped;
  }
  return {expired,scanned,skipped};
}

async function clearReferences(admin:Admin,bucket:string,keys:string[],deletedAt:string){
  if(bucket!==STORAGE_BUCKET)return;
  const [requests,payments,readings,chats]=await Promise.all([
    admin.from("payment_documentation_requests").update({receipt_image_key:null,receipt_image_deleted_at:deletedAt,receipt_image_retention_until:deletedAt,updated_at:deletedAt}).in("receipt_image_key",keys),
    admin.from("payments").update({receipt_image_key:null}).in("receipt_image_key",keys),
    admin.from("meter_readings").update({image_key:null}).in("image_key",keys),
    admin.from("chat_message_attachments").update({storage_deleted_at:deletedAt}).eq("storage_bucket",bucket).in("storage_path",keys),
  ]);
  const failures=[requests,payments,readings,chats].filter((r:DbResult)=>r.error);
  if(failures.length)throw new Error(failures.map((r:DbResult)=>r.error?.message??"reference cleanup failed").join("; "));
}

export async function cleanupExpiredStorageImages(now=new Date(),options:{dryRun?:boolean}={}){
  const admin=supabaseAdmin() as unknown as Admin;
  const dryRun=options.dryRun ?? process.env.POWERHUB_IMAGE_RETENTION_DRY_RUN !== "false";
  const cutoff=new Date(now.getTime()-STORAGE_IMAGE_RETENTION_DAYS*24*60*60*1000);
  const result={
    retentionDays:STORAGE_IMAGE_RETENTION_DAYS,dryRun,cutoff:cutoff.toISOString(),
    bucket:STORAGE_BUCKET,eligiblePrefixes:[...STORAGE_IMAGE_RETENTION_PREFIXES],
    bucketsScanned:1,filesScanned:0,protectedBrandImages:0,expiredImagesFound:0,
    deleted:0,failed:0,skippedWithoutCreatedAt:0,
    failures:[] as Array<{bucket:string;stage:string;message:string}>,
  };
  // Never enumerate other buckets or unrelated folders (logos, exports, documents,
  // backups, generated assets, and future features are outside this retention policy).
  try{
    const protectedKeys=await listProtectedBrandKeys(admin,STORAGE_BUCKET);
    result.protectedBrandImages=protectedKeys.size;
    const allExpired:string[]=[];
    for(const prefix of STORAGE_IMAGE_RETENTION_PREFIXES){
      const scan=await scanBucket(admin,STORAGE_BUCKET,prefix,cutoff,protectedKeys);
      result.filesScanned+=scan.scanned;
      result.skippedWithoutCreatedAt+=scan.skipped;
      allExpired.push(...scan.expired.filter(isEligibleImageRetentionKey));
    }
    const keys=Array.from(new Set(allExpired));
    result.expiredImagesFound=keys.length;
    if(dryRun)return result;
    for(let offset=0;offset<keys.length;offset+=PAGE_SIZE){
      const batch=keys.slice(offset,offset+PAGE_SIZE);
      try{
        // Delete through the Storage API only. Keep DB references until Storage confirms removal.
        const {error:removeError}=await admin.storage.from(STORAGE_BUCKET).remove(batch);
        if(removeError)throw new Error(removeError.message);
        result.deleted+=batch.length;
        await clearReferences(admin,STORAGE_BUCKET,batch,now.toISOString());
      }catch(e){
        result.failed+=batch.length;
        if(result.failures.length<20)result.failures.push({
          bucket:STORAGE_BUCKET,stage:"delete-or-reference-cleanup",
          message:e instanceof Error?e.message:"Image deletion failed.",
        });
      }
    }
  }catch(e){
    result.failed++;
    if(result.failures.length<20)result.failures.push({
      bucket:STORAGE_BUCKET,stage:"scan",
      message:e instanceof Error?e.message:"Storage scan failed.",
    });
  }
  return result;
}
