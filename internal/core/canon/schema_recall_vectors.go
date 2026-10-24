// SPDX-License-Identifier: Apache-2.0
package canon

const recallVectorsSchema = `
ALTER TABLE search_index_config ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE search_index_config ADD COLUMN dimension INTEGER NOT NULL DEFAULT 0;
ALTER TABLE search_index_config ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE search_index_config ADD COLUMN ready INTEGER NOT NULL DEFAULT 0;
ALTER TABLE search_index_config ADD COLUMN endpoint TEXT NOT NULL DEFAULT '';
UPDATE search_index_config SET model='BAAI/bge-m3',dimension=1024 WHERE name='recall';
CREATE VIRTUAL TABLE recall_vec USING vec0(embedding float[1024] distance_metric=cosine);
CREATE TABLE recall_vec_delete (doc INTEGER PRIMARY KEY);
CREATE TABLE recall_embed_pending (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 doc INTEGER NOT NULL UNIQUE REFERENCES recall_doc(id) ON DELETE CASCADE
);
CREATE TABLE recall_embed_consent (
 conversation TEXT PRIMARY KEY, through_event INTEGER NOT NULL, granted_at TEXT NOT NULL
);
CREATE TABLE recall_embed_consent_event (
 event_id TEXT PRIMARY KEY, conversation TEXT NOT NULL, granted_at TEXT NOT NULL
);
CREATE TRIGGER recall_embed_insert AFTER INSERT ON recall_doc BEGIN
 INSERT INTO recall_embed_pending(doc) VALUES(NEW.id);
END;
CREATE TRIGGER recall_embed_delete AFTER DELETE ON recall_doc BEGIN
 INSERT OR IGNORE INTO recall_vec_delete VALUES(OLD.id);
 DELETE FROM recall_embed_pending WHERE doc=OLD.id;
END;
INSERT INTO recall_embed_pending(doc) SELECT id FROM recall_doc;
CREATE TRIGGER recall_embed_grant AFTER INSERT ON recall_embed_consent BEGIN
 INSERT OR IGNORE INTO recall_vec_delete SELECT id FROM recall_doc;
 DELETE FROM recall_embed_pending;
 INSERT INTO recall_embed_pending(doc) SELECT id FROM recall_doc;
 UPDATE search_index_config SET generation=generation+1,ready=0 WHERE name='recall';
END;
CREATE TRIGGER recall_embed_extend AFTER UPDATE ON recall_embed_consent BEGIN
 INSERT OR IGNORE INTO recall_vec_delete SELECT id FROM recall_doc;
 DELETE FROM recall_embed_pending;
 INSERT INTO recall_embed_pending(doc) SELECT id FROM recall_doc;
 UPDATE search_index_config SET generation=generation+1,ready=0 WHERE name='recall';
END;
CREATE TRIGGER recall_embed_revoke AFTER DELETE ON recall_embed_consent BEGIN
 INSERT OR IGNORE INTO recall_vec_delete SELECT id FROM recall_doc;
 DELETE FROM recall_embed_pending;
 INSERT INTO recall_embed_pending(doc) SELECT id FROM recall_doc;
 UPDATE search_index_config SET generation=generation+1,ready=0 WHERE name='recall';
END;
-- never-leaves eligibility follows the external-model restriction relation:
-- current citations, legacy evidence, replay copies, view_of links and material
-- bodies. Import consent names either a conversation watermark or the individual
-- events a later import reported.
CREATE VIEW recall_imported_event AS
 SELECT e.id,e.conversation_id,e.rowid AS sequence FROM conv_event e WHERE json_extract(e.origin,'$.kind')='import'
 OR EXISTS(SELECT 1 FROM messenger_record_revision mr JOIN messenger_legacy_ref l
 ON l.platform=mr.platform AND l.account=mr.account AND l.chat=mr.chat AND l.message=mr.message WHERE mr.event=e.id);
CREATE VIEW recall_embed_eligible AS
 WITH RECURSIVE ancestry(doc,kind,source_id) AS (
  SELECT id,kind,source_id FROM recall_doc
  UNION
  SELECT a.doc,c.target_kind,c.target_id FROM ancestry a JOIN cite c
   ON c.view_kind=a.kind AND c.view_id=a.source_id AND c.dropped_revision IS NULL
 ),
 legacy_memory_edges(view_id,target_kind,target_id) AS (
  SELECT m.id,CASE json_extract(x.value,'$.kind') WHEN 'item' THEN 'memory' ELSE json_extract(x.value,'$.kind') END,
   json_extract(x.value,'$.id') FROM memory_item m,json_each(m.record,'$.evidence') x
  WHERE NOT EXISTS(SELECT 1 FROM cite c WHERE c.view_kind='memory' AND c.view_id=m.id AND c.dropped_revision IS NULL)
 ),
 sensitive(kind,id) AS (
  SELECT 'memory',m.id FROM memory_item m WHERE m.scope='never-leaves'
  UNION
  SELECT c.target_kind,c.target_id FROM cite c JOIN sensitive s ON c.view_kind=s.kind AND c.view_id=s.id
   WHERE c.dropped_revision IS NULL
  UNION
  SELECT c.target_kind,c.target_id FROM legacy_memory_edges c JOIN sensitive s ON s.kind='memory' AND c.view_id=s.id
  UNION
  SELECT 'event',e.replay_of FROM conv_event e JOIN sensitive s ON s.kind='event' AND s.id=e.id
   WHERE e.replay_of IS NOT NULL
  UNION
  SELECT 'event',v.target_id FROM ev_rel v JOIN sensitive s ON s.kind='event' AND s.id=v.event_id
   WHERE v.kind='view_of'
  UNION
  SELECT 'material',e.material_id FROM conv_event e JOIN sensitive s ON s.kind='event' AND s.id=e.id
   WHERE e.material_id IS NOT NULL
 ),
 restricted(kind,id) AS (
  SELECT kind,id FROM sensitive
  UNION
  SELECT c.view_kind,c.view_id FROM cite c JOIN restricted r ON c.target_kind=r.kind AND c.target_id=r.id
   WHERE c.dropped_revision IS NULL
  UNION
  SELECT 'memory',c.view_id FROM legacy_memory_edges c JOIN restricted r ON c.target_kind=r.kind AND c.target_id=r.id
  UNION
  SELECT 'event',e.id FROM conv_event e JOIN restricted r ON r.kind='event' AND r.id=e.replay_of
  UNION
  SELECT 'event',v.event_id FROM ev_rel v JOIN restricted r ON r.kind='event' AND r.id=v.target_id
   WHERE v.kind='view_of'
  UNION
  SELECT 'event',e.id FROM conv_event e JOIN restricted r ON r.kind='material' AND r.id=e.material_id
 )
 SELECT d.* FROM recall_doc d WHERE NOT EXISTS (
  SELECT 1 FROM restricted r WHERE r.kind=d.kind AND r.id=d.source_id
 ) AND NOT EXISTS (
  SELECT 1 FROM ancestry a WHERE a.doc=d.id AND (
   (a.kind='memory' AND EXISTS(SELECT 1 FROM memory_item m WHERE m.id=a.source_id AND
    json_extract(m.record,'$.basis')='imported' AND NOT EXISTS(
     SELECT 1 FROM cite c WHERE c.view_kind='memory' AND c.view_id=m.id AND c.target_kind='event' AND c.dropped_revision IS NULL)))
   OR (a.kind='event' AND EXISTS(SELECT 1 FROM recall_imported_event e WHERE e.id=a.source_id AND NOT (
    EXISTS(SELECT 1 FROM recall_embed_consent k WHERE k.conversation=e.conversation_id AND e.sequence<=k.through_event)
    OR EXISTS(SELECT 1 FROM recall_embed_consent_event x WHERE x.event_id=e.id))))
   OR (a.kind='event' AND EXISTS(SELECT 1 FROM messenger_record_revision mr JOIN messenger_chat mc
    ON mc.platform=mr.platform AND mc.account=mr.account AND mc.chat=mr.chat WHERE mr.event=a.source_id AND mc.embed=0))
  )
 );
CREATE TRIGGER recall_embed_chat_switch AFTER UPDATE OF embed ON messenger_chat WHEN OLD.embed<>NEW.embed BEGIN
 INSERT OR IGNORE INTO recall_vec_delete SELECT id FROM recall_doc;
 DELETE FROM recall_embed_pending;
 INSERT INTO recall_embed_pending(doc) SELECT id FROM recall_doc;
 UPDATE search_index_config SET generation=generation+1,ready=0 WHERE name='recall';
END;
`
