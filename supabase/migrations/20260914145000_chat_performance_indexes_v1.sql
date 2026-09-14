-- Cover the knowledge embedding article foreign key used by article lifecycle deletes.
create index if not exists chat_knowledge_embeddings_article_idx
  on public.chat_knowledge_embeddings (article_id);