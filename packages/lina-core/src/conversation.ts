/**
 * Presentation-only predicate, evaluated in SQLite before the page limit.
 * CASE guards every JSON boundary, including JSON-string text signatures and
 * SQLite's nesting limit. Unknown/invalid native data retains legacy behavior.
 * No raw bodies are returned to JS or rewritten by this projection.
 */
export const CONVERSATION_FILTER = `
 CASE
  WHEN role = 'user' THEN 1
  WHEN role != 'assistant' OR trim(text, char(9,10,11,12,13,32)) = '' THEN 0
  WHEN NOT json_valid(raw_json) THEN 1
  WHEN json_extract(raw_json, '$.message.stopReason') IS 'toolUse'
    OR json_extract(raw_json, '$.message.phase') IS 'commentary' THEN 0
  ELSE NOT EXISTS (
   SELECT 1 FROM json_each(
    CASE WHEN json_type(raw_json, '$.message.content') = 'array'
     THEN json_extract(raw_json, '$.message.content') ELSE '[]' END
   ) AS part
   WHERE CASE
    WHEN part.type != 'object' THEN 0
    WHEN json_extract(part.value, '$.type') IS 'toolCall' THEN 1
    WHEN json_type(part.value, '$.textSignature') = 'text' THEN
     CASE WHEN json_valid(json_extract(part.value, '$.textSignature'))
      THEN json_extract(json_extract(part.value, '$.textSignature'), '$.phase') IS 'commentary'
      ELSE 0 END
    ELSE 0 END
  )
 END`;
