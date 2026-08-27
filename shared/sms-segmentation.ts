export const ARABIC_SMS_SINGLE_SEGMENT_LIMIT = 70;
export const ARABIC_SMS_CONCATENATED_SEGMENT_LIMIT = 67;

export type SmsSegmentation = {
  characterCount: number;
  segmentCount: number;
  segments: string[];
  isConcatenated: boolean;
};

export function segmentArabicSms(message: string): SmsSegmentation {
  const characters = Array.from(message);
  if (characters.length === 0) return { characterCount: 0, segmentCount: 0, segments: [], isConcatenated: false };
  const chunkSize = characters.length <= ARABIC_SMS_SINGLE_SEGMENT_LIMIT ? ARABIC_SMS_SINGLE_SEGMENT_LIMIT : ARABIC_SMS_CONCATENATED_SEGMENT_LIMIT;
  const segments = Array.from({ length: Math.ceil(characters.length / chunkSize) }, (_, index) => characters.slice(index * chunkSize, (index + 1) * chunkSize).join(""));
  return { characterCount: characters.length, segmentCount: segments.length, segments, isConcatenated: segments.length > 1 };
}
