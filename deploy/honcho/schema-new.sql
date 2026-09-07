\set ON_ERROR_STOP on
BEGIN;
-- Only for this fresh empty Lina database. Refuse conversion of existing rows.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM documents LIMIT 1) OR EXISTS(SELECT 1 FROM message_embeddings LIMIT 1) THEN
  RAISE EXCEPTION 'Fresh-schema operation refused: existing memory rows';
 END IF;
END $$;
DROP INDEX IF EXISTS ix_documents_embedding_hnsw;
DROP INDEX IF EXISTS ix_message_embeddings_embedding_hnsw;
ALTER TABLE documents ALTER COLUMN embedding TYPE halfvec(2048) USING embedding::halfvec(2048);
ALTER TABLE message_embeddings ALTER COLUMN embedding TYPE halfvec(2048) USING embedding::halfvec(2048);
CREATE INDEX ix_documents_embedding_hnsw ON documents USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX ix_message_embeddings_embedding_hnsw ON message_embeddings USING hnsw (embedding halfvec_cosine_ops);
COMMIT;
