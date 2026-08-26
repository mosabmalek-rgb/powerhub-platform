import { z } from "zod";
import { adminProcedure, publicProcedure, router } from "./trpc";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async () => {
      throw new Error("PRECONDITION_FAILED: الإشعارات الداخلية المعتمدة على خدمات خارجية متوقفة أثناء ترحيل التشغيل إلى Supabase وVercel.");
    }),
});
