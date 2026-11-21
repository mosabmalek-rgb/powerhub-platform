import { cleanupExpiredStorageImages } from "./storage-image-retention";

export async function cleanupPaymentDocumentationReceiptImages(){
  return cleanupExpiredStorageImages();
}
