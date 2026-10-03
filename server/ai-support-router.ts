    const normalizedArticles = (articles ?? []) as Array<Record<string, unknown>>;
    const topScore = normalizedArticles.length ? Number(normalizedArticles[0].score ?? 0) : 0;
    const minScore = Number(settings.min_retrieval_score ?? 0.05);
    const deterministic = deterministicDecision(input.question, normalizedArticles, minScore);

    if (deterministic.decision === "handoff" && settings.handoff_on_unknown !== false) {
      const policyAnswer = isSensitiveMutationRequest(input.question)
        ? "لا أستطيع تنفيذ أو اعتماد هذه العملية من خلال المساعد. سأحوّلك إلى فريق الدعم لمساعدتك عبر المسار الآمن."
        : "لم أجد في قاعدة المعرفة معلومات موثوقة كافية للإجابة. سأحوّلك إلى فريق الدعم حتى لا أعطيك تعليمات غير مؤكدة.";
      const { data: policyMessage, error: policyMessageError } = await admin.rpc("chat_ai_append_assistant_message", {
        p_conversation_id: input.conversationId,
        p_body: policyAnswer,
        p_client_message_id: assistantId,
        p_metadata: {
          source: "powerhub_ai",
          decision: "handoff",
          policyGate: true,
        },
      });
      if (policyMessageError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ تحويل الطلب للدعم." });

      const { data: handoff, error: handoffError } = await admin.rpc("chat_ai_handoff", {
        p_conversation_id: input.conversationId,
        p_user_message_id: input.messageId,
        p_ai_message_id: Number((policyMessage as { id: number }).id),
        p_actor_user_id: ctx.user.id,
        p_trigger: isSensitiveMutationRequest(input.question) ? "sensitive" : "insufficient_knowledge",
        p_reason: deterministic.reason ?? "لا توجد إجابة موثوقة كافية.",
        p_summary: isSensitiveMutationRequest(input.question)
          ? "طلب المستخدم عملية حساسة تم إيقافها قبل استدعاء نموذج AI."
          : "لم يجد الاسترجاع مصادر موثوقة كافية؛ تم التحويل للدعم دون استدعاء النموذج.",
        p_category: "support",
        p_priority: isSensitiveMutationRequest(input.question) ? "high" : "normal",
        p_current_page: input.currentPage ?? null,
      });
      if (handoffError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحويل الطلب إلى الدعم." });

      await admin.rpc("chat_ai_record_run", {
        p_request_id: assistantId,
        p_conversation_id: input.conversationId,
        p_tenant_id: input.tenantId,
        p_user_id: ctx.user.id,
        p_question_preview: input.question,
        p_question_hash: hashSha256(input.question),
        p_decision: "handoff",
        p_model: String(settings.model ?? "openai/gpt-5"),
        p_top_retrieval_score: topScore,
        p_retrieved_article_ids: normalizedArticles.map((a) => Number(a.article_id)).filter(Number.isFinite),
        p_handoff_id: Number((handoff as { id: number }).id),
        p_latency_ms: Date.now() - started,
        p_error_code: deterministic.reason,
      });

      return {
        decision: "handoff" as const,
        messageId: Number((policyMessage as { id: number }).id),
        handoffId: Number((handoff as { id: number }).id),
      };
    }

    const accountContextNeeded = shouldLoadAccountContext(input.question, deterministic.articles);
    const context = accountContextNeeded
      ? (await admin.rpc("chat_ai_get_account_context", {
          p_tenant_id: input.tenantId,
          p_actor_user_id: ctx.user.id,
        })).data
      : {};

    let result: AiResult;
    try {
      result = await callModel({
        question: input.question,
        articles: deterministic.articles,
        accountContext: context ?? {},
      });
    } catch (error) {
      await admin.rpc("chat_ai_record_run", {
        p_request_id: randomUUID(),
        p_conversation_id: input.conversationId,
        p_tenant_id: input.tenantId,
        p_user_id: ctx.user.id,
        p_question_preview: input.question,
        p_question_hash: hashSha256(input.question),
        p_decision: "error",
        p_model: String(settings.model ?? cfgModelFallback()),
        p_top_retrieval_score: topScore,
        p_retrieved_article_ids: normalizedArticles.map(a => Number(a.article_id)).filter(Number.isFinite),
        p_handoff_id: null,
        p_latency_ms: Date.now() - started,
        p_error_code: error instanceof Error ? error.message : "AI_ERROR",
      });
      throw new TRPCError({ code: "BAD_GATEWAY", message: "تعذر الحصول على رد آمن من المساعد. يمكنك التواصل مع الدعم مباشرة." });
    }

    if (result.decision === "answer" || result.decision === "clarify" || result.decision === "refuse") {
      const { data: message, error: messageError } = await admin.rpc("chat_ai_append_assistant_message", {
        p_conversation_id: input.conversationId,
        p_body: result.answer,
        p_client_message_id: assistantId,
        p_metadata: {
          source: "powerhub_ai",
          decision: result.decision,
          knowledgeArticleIds: normalizedArticles.map(a => Number(a.article_id)).filter(Number.isFinite),
        },
      });
      if (messageError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ رد المساعد." });

      await admin.rpc("chat_ai_record_run", {
        p_request_id: assistantId,
        p_conversation_id: input.conversationId,
        p_tenant_id: input.tenantId,
        p_user_id: ctx.user.id,
        p_question_preview: input.question,
        p_question_hash: createHash("sha256").update(input.question).digest("hex"),
        p_decision: result.decision,
        p_model: String(settings.model ?? "openai/gpt-5"),
        p_top_retrieval_score: topScore,
        p_retrieved_article_ids: normalizedArticles.map(a => Number(a.article_id)).filter(Number.isFinite),
        p_handoff_id: null,
        p_latency_ms: Date.now() - started,
        p_error_code: null,
      });

      return { decision: result.decision, messageId: Number((message as { id: number }).id) };
    }

    const { data: message, error: messageError } = await admin.rpc("chat_ai_append_assistant_message", {
      p_conversation_id: input.conversationId,
      p_body: result.answer,
      p_client_message_id: assistantId,
      p_metadata: { source: "powerhub_ai", decision: "handoff" },
    });
    if (messageError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ رد المساعد." });

    const { data: handoff, error: handoffError } = await admin.rpc("chat_ai_handoff", {
      p_conversation_id: input.conversationId,
      p_user_message_id: input.messageId,
      p_ai_message_id: Number((message as { id: number }).id),
      p_actor_user_id: ctx.user.id,
      p_trigger: "unknown",
      p_reason: result.reason || "لم يتم العثور على إجابة موثوقة.",
      p_summary: result.summary || "تم تحويل السؤال من مساعد PowerHub إلى الدعم.",
      p_category: result.category || "other",
      p_priority: result.priority || "normal",
      p_current_page: input.currentPage ?? null,
    });
    if (handoffError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحويل الطلب إلى الدعم." });

    await admin.rpc("chat_ai_record_run", {
      p_request_id: assistantId,
      p_conversation_id: input.conversationId,
      p_tenant_id: input.tenantId,
      p_user_id: ctx.user.id,
      p_question_preview: input.question,
      p_question_hash: createHash("sha256").update(input.question).digest("hex"),
      p_decision: "handoff",
      p_model: String(settings.model ?? "openai/gpt-5"),
      p_top_retrieval_score: topScore,
      p_retrieved_article_ids: normalizedArticles.map(a => Number(a.article_id)).filter(Number.isFinite),
      p_handoff_id: Number((handoff as { id: number }).id),
      p_latency_ms: Date.now() - started,
      p_error_code: null,
    });

    return { decision: "handoff" as const, messageId: Number((message as { id: number }).id), handoffId: Number((handoff as { id: number }).id) };
  }),
});

function cfgModelFallback() { return "openai/gpt-5"; }
