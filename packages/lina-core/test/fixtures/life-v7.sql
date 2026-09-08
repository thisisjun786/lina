PRAGMA application_id=1280791089;
PRAGMA user_version=7;
BEGIN TRANSACTION;
CREATE TABLE life_autonomy_state (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id),
 base_world_revision INTEGER NOT NULL CHECK(base_world_revision >= 0),
 base_life_revision INTEGER NOT NULL CHECK(base_life_revision >= 0),
 baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json)),
 state_json TEXT NOT NULL CHECK(json_valid(state_json)), digest TEXT NOT NULL
) STRICT;
CREATE TABLE life_commits (
 world_id TEXT NOT NULL, life_revision INTEGER NOT NULL CHECK(life_revision > 0),
 world_revision INTEGER NOT NULL CHECK(world_revision > 0), idempotency_key TEXT NOT NULL,
 input_digest TEXT NOT NULL, envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
 PRIMARY KEY(world_id, life_revision), UNIQUE(world_id, world_revision), UNIQUE(world_id, idempotency_key),
 FOREIGN KEY(world_id) REFERENCES life_states(world_id),
 FOREIGN KEY(world_id, world_revision) REFERENCES world_events(world_id, revision)
) STRICT;
INSERT INTO "life_commits" VALUES('test-world',1,1,'shared-event','d9ca28153a5a4a97fef6cba99f8fc166eaab404fcdf71e4293c19054b858abb3','{"commit":{"beliefs":[{"agentId":"lina","claim":{"id":"false-claim","kind":"life_claim"},"confidence":"certain","experienceIds":["told"],"id":"belief-a","stance":"believes","supersedes":null}],"checkpoint":{"data":null,"dataDigest":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","encodingVersion":1,"engineId":"empty","engineRevision":0,"ruleDigest":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","version":1},"claims":[{"disclosure":{"disclosures":[],"knowers":["lina","mira"],"publication":[]},"id":"false-claim","sourceEventId":"test-world:1","supersedes":null,"text":"The key is red","truth":"false"}],"consumedInputIds":[],"definitionRevision":1,"effects":[{"id":"intent","lifeRevision":1,"payload":{"eventId":"test-world:1","kind":"publication_candidate"},"payloadDigest":"640d08c9ef0ac578ee28e962a17c0c15fc5acd8e07e2914909b21431cbd2e641","version":1,"worldId":"test-world"}],"expectedLifeRevision":0,"experiences":[{"agentId":"lina","channel":"told","claims":[{"id":"false-claim","kind":"life_claim"}],"eventId":"test-world:1","id":"told","simulationTime":1},{"agentId":"mira","channel":"direct","claims":[{"id":"whisper","kind":"world_fact"}],"eventId":"test-world:1","id":"witness","simulationTime":1}],"growth":[{"agentId":"lina","axisId":"axis","evidenceIds":["told"],"kind":"trait","next":1,"previous":0},{"axisId":"relation","evidenceIds":["told"],"fromAgentId":"lina","kind":"attitude","next":-1,"previous":0,"toAgentId":"mira"}],"version":1,"world":{"actorIds":["lina","mira"],"audience":["lina","mira"],"expectedRevision":0,"facts":[{"id":"bell","knownTo":["lina","mira"],"text":"The bell rang once"},{"id":"whisper","knownTo":["mira"],"text":"Mira whispered a private word"}],"idempotencyKey":"shared-event","kind":"activity","moves":[],"sceneId":"meeting","simulationTime":1,"summary":"A bell rang during the meeting","worldId":"test-world"}},"identity":{"profiles":[{"agentId":"lina","evolution":"adaptive","lockedAttitudeIds":[],"lockedHabitIds":[],"lockedTraitIds":[],"profileRevision":1},{"agentId":"mira","evolution":"adaptive","lockedAttitudeIds":[],"lockedHabitIds":[],"lockedTraitIds":[],"profileRevision":1},{"agentId":"sol","evolution":"adaptive","lockedAttitudeIds":[],"lockedHabitIds":[],"lockedTraitIds":[],"profileRevision":1}],"version":1},"version":1}');
CREATE TABLE life_config (
 world_id TEXT NOT NULL REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision >= 1),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id, revision)
) STRICT;
INSERT INTO "life_config" VALUES('test-world',1,'{"attitudes":[{"id":"relation","initial":0,"label":"Authored attitude","max":2,"min":-2}],"habits":[{"id":"habit","initial":false,"label":"Authored habit"}],"participants":["lina","mira","sol"],"projection":{"disclosures":[{"policy":{"disclosures":[{"agentId":"lina","recipientId":"friends"}],"knowers":["lina"],"publication":["friends"]},"subject":{"id":"test-world:1","kind":"world_event"}}],"revision":1,"sharedAttitudeIds":["relation"],"sharedHabitIds":["habit"],"sharedTraitIds":["axis"]},"revision":1,"traits":[{"id":"axis","initial":0,"label":"Authored axis","max":2,"min":-2}],"version":1,"worldId":"test-world"}','2533ad35479a98f30681bf1f9569c8a9e77e8cb3f80f1a7d3f7c61233d6d03da');
CREATE TABLE life_effects (
 world_id TEXT NOT NULL, intent_id TEXT NOT NULL, life_revision INTEGER NOT NULL,
 payload_digest TEXT NOT NULL, intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
 consumer_receipt_json TEXT CHECK(consumer_receipt_json IS NULL OR json_valid(consumer_receipt_json)),
 PRIMARY KEY(world_id, intent_id),
 FOREIGN KEY(world_id, life_revision) REFERENCES life_commits(world_id, life_revision)
) STRICT;
INSERT INTO "life_effects" VALUES('test-world','intent',1,'640d08c9ef0ac578ee28e962a17c0c15fc5acd8e07e2914909b21431cbd2e641','{"id":"intent","lifeRevision":1,"payload":{"eventId":"test-world:1","kind":"publication_candidate"},"payloadDigest":"640d08c9ef0ac578ee28e962a17c0c15fc5acd8e07e2914909b21431cbd2e641","version":1,"worldId":"test-world"}',NULL);
CREATE TABLE life_inputs (
 world_id TEXT NOT NULL REFERENCES worlds(id), input_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(source_revision >= 0), payload_digest TEXT NOT NULL,
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), consumed_life_revision INTEGER,
 PRIMARY KEY(world_id, input_id),
 FOREIGN KEY(world_id, consumed_life_revision) REFERENCES life_commits(world_id, life_revision)
) STRICT;
CREATE TABLE life_model_receipts (
 world_id TEXT NOT NULL, step_id TEXT NOT NULL, request_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id, request_id), FOREIGN KEY(world_id, step_id) REFERENCES life_steps(world_id, step_id)
) STRICT;
CREATE TABLE life_publication_ancestry (
 world_id TEXT NOT NULL REFERENCES worlds(id), subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 life_revision INTEGER NOT NULL CHECK(life_revision>0), record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,subject_kind,subject_id)
) STRICT;
CREATE TABLE life_publication_chain_actions (
 world_id TEXT NOT NULL REFERENCES worlds(id), action_key TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,action_key), UNIQUE(world_id,sequence)
) STRICT;
CREATE TABLE life_publication_chain_charges (
 world_id TEXT NOT NULL REFERENCES worlds(id), root_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 4096),
 action_key TEXT NOT NULL, action_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,root_id,sequence), UNIQUE(world_id,action_key,root_id),
 FOREIGN KEY(world_id,root_id) REFERENCES life_publication_chain_roots(world_id,root_id),
 FOREIGN KEY(world_id,action_key) REFERENCES life_publication_chain_actions(world_id,action_key)
) STRICT;
CREATE TABLE life_publication_chain_roots (
 world_id TEXT NOT NULL REFERENCES worlds(id), root_id TEXT NOT NULL,
 action_count INTEGER NOT NULL CHECK(action_count BETWEEN 1 AND 4096),
 PRIMARY KEY(world_id,root_id)
) STRICT;
CREATE TABLE life_publication_chain_state (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id),
 action_count INTEGER NOT NULL CHECK(action_count BETWEEN 1 AND 9007199254740991),
 digest TEXT NOT NULL
) STRICT;
CREATE TABLE life_publication_cursor_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), principal_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,principal_key,revision)
) STRICT;
CREATE TABLE life_publication_cursors (
 world_id TEXT NOT NULL REFERENCES worlds(id), principal_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,principal_key),
 FOREIGN KEY(world_id,principal_key,revision) REFERENCES life_publication_cursor_history(world_id,principal_key,revision)
) STRICT;
CREATE TABLE life_publication_grant_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), grant_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0), grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
 token_hash TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(world_id,grant_id,revision)
) STRICT;
CREATE TABLE life_publication_grant_receipts (
 world_id TEXT NOT NULL REFERENCES worlds(id), request_key TEXT NOT NULL,
 grant_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), request_digest TEXT NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY(world_id,request_key),
 FOREIGN KEY(world_id,grant_id,revision) REFERENCES life_publication_grant_history(world_id,grant_id,revision)
) STRICT;
CREATE TABLE life_publication_grants (
 world_id TEXT NOT NULL REFERENCES worlds(id), grant_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0), grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
 token_hash TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(world_id,grant_id),
 UNIQUE(world_id,token_hash),
 FOREIGN KEY(world_id,grant_id,revision) REFERENCES life_publication_grant_history(world_id,grant_id,revision)
) STRICT;
CREATE TABLE life_publication_interaction_receipts (
 world_id TEXT NOT NULL REFERENCES worlds(id), principal_digest TEXT NOT NULL, request_key TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
 request_digest TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,principal_digest,request_key), UNIQUE(world_id,sequence)
) STRICT;
CREATE TABLE life_publication_interaction_state (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id),
 receipt_count INTEGER NOT NULL CHECK(receipt_count BETWEEN 1 AND 9007199254740991),
 digest TEXT NOT NULL
) STRICT;
CREATE TABLE life_publication_interactions (
 world_id TEXT NOT NULL REFERENCES worlds(id), interaction_id TEXT NOT NULL,
 principal_digest TEXT NOT NULL, request_key TEXT NOT NULL,
 interaction_json TEXT NOT NULL CHECK(json_valid(interaction_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,interaction_id), UNIQUE(world_id,principal_digest,request_key),
 FOREIGN KEY(world_id,principal_digest,request_key)
 REFERENCES life_publication_interaction_receipts(world_id,principal_digest,request_key)
) STRICT;
CREATE TABLE life_publication_job_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), job_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 job_json TEXT NOT NULL CHECK(json_valid(job_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,job_id,revision)
) STRICT;
CREATE TABLE life_publication_job_requests (
 world_id TEXT NOT NULL REFERENCES worlds(id), request_key TEXT NOT NULL, job_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision>0), result_revision INTEGER NOT NULL CHECK(result_revision>0), payload_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,request_key),
 FOREIGN KEY(world_id,job_id,result_revision) REFERENCES life_publication_job_history(world_id,job_id,revision)
) STRICT;
CREATE TABLE life_publication_jobs (
 world_id TEXT NOT NULL REFERENCES worlds(id), job_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 job_json TEXT NOT NULL CHECK(json_valid(job_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,job_id),
 FOREIGN KEY(world_id,job_id,revision) REFERENCES life_publication_job_history(world_id,job_id,revision)
) STRICT;
CREATE TABLE life_publication_model_receipts (
 world_id TEXT NOT NULL REFERENCES worlds(id), job_id TEXT NOT NULL, request_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,request_id), FOREIGN KEY(world_id,job_id) REFERENCES life_publication_jobs(world_id,job_id)
) STRICT;
CREATE TABLE life_publication_observations (
 world_id TEXT NOT NULL REFERENCES worlds(id), input_id TEXT NOT NULL, interaction_id TEXT NOT NULL,
 agent_id TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,input_id), UNIQUE(world_id,interaction_id,agent_id),
 FOREIGN KEY(world_id,interaction_id) REFERENCES life_publication_interactions(world_id,interaction_id)
) STRICT;
CREATE TABLE life_publication_post_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), post_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 post_json TEXT NOT NULL CHECK(json_valid(post_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,post_id,revision)
) STRICT;
CREATE TABLE life_publication_post_receipts (
 world_id TEXT NOT NULL REFERENCES worlds(id), job_id TEXT NOT NULL, post_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,job_id), UNIQUE(world_id,post_id),
 FOREIGN KEY(world_id,job_id) REFERENCES life_publication_jobs(world_id,job_id), FOREIGN KEY(world_id,post_id) REFERENCES life_publication_posts(world_id,post_id)
) STRICT;
CREATE TABLE life_publication_post_requests (
 world_id TEXT NOT NULL REFERENCES worlds(id), request_key TEXT NOT NULL, post_id TEXT NOT NULL,
 expected_revision INTEGER NOT NULL CHECK(expected_revision>0), result_revision INTEGER NOT NULL CHECK(result_revision>0), payload_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,request_key), FOREIGN KEY(world_id,post_id,result_revision) REFERENCES life_publication_post_history(world_id,post_id,revision)
) STRICT;
CREATE TABLE life_publication_posts (
 world_id TEXT NOT NULL REFERENCES worlds(id), post_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 post_json TEXT NOT NULL CHECK(json_valid(post_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,post_id),
 FOREIGN KEY(world_id,post_id,revision) REFERENCES life_publication_post_history(world_id,post_id,revision)
) STRICT;
CREATE TABLE life_publication_reaction_heads (
 world_id TEXT NOT NULL REFERENCES worlds(id), principal_digest TEXT NOT NULL,
 parent_post_id TEXT NOT NULL, reaction_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
 interaction_id TEXT NOT NULL, PRIMARY KEY(world_id,principal_digest,parent_post_id,reaction_id),
 FOREIGN KEY(world_id,interaction_id) REFERENCES life_publication_interactions(world_id,interaction_id)
) STRICT;
CREATE TABLE life_publication_reply_post_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), post_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision IN (1,2)),
 post_json TEXT NOT NULL CHECK(json_valid(post_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,post_id,revision)
) STRICT;
CREATE TABLE life_publication_reply_post_receipts (
 world_id TEXT NOT NULL REFERENCES worlds(id), interaction_id TEXT NOT NULL, post_id TEXT NOT NULL,
 interaction_digest TEXT NOT NULL, post_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,interaction_id), UNIQUE(world_id,post_id),
 FOREIGN KEY(world_id,post_id) REFERENCES life_publication_reply_posts(world_id,post_id)
) STRICT;
CREATE TABLE life_publication_reply_post_requests (
 world_id TEXT NOT NULL REFERENCES worlds(id), request_key TEXT NOT NULL, post_id TEXT NOT NULL,
 expected_revision INTEGER NOT NULL CHECK(expected_revision IN (1,2)),
 result_revision INTEGER NOT NULL CHECK(result_revision=2), payload_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,request_key),
 FOREIGN KEY(world_id,post_id,result_revision) REFERENCES life_publication_reply_post_history(world_id,post_id,revision)
) STRICT;
CREATE TABLE life_publication_reply_posts (
 world_id TEXT NOT NULL REFERENCES worlds(id), post_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision IN (1,2)),
 post_json TEXT NOT NULL CHECK(json_valid(post_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,post_id),
 FOREIGN KEY(world_id,post_id,revision) REFERENCES life_publication_reply_post_history(world_id,post_id,revision)
) STRICT;
CREATE TABLE life_publication_run_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), run_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 run_json TEXT NOT NULL CHECK(json_valid(run_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,run_id,revision)
) STRICT;
CREATE TABLE life_publication_run_leases (
 world_id TEXT NOT NULL REFERENCES worlds(id), run_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
 lease_json TEXT NOT NULL CHECK(json_valid(lease_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,run_id,sequence),
 FOREIGN KEY(world_id,run_id) REFERENCES life_publication_runs(world_id,run_id)
) STRICT;
CREATE TABLE life_publication_runs (
 world_id TEXT NOT NULL REFERENCES worlds(id), run_id TEXT NOT NULL, request_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 run_json TEXT NOT NULL CHECK(json_valid(run_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,run_id), UNIQUE(world_id,request_key),
 FOREIGN KEY(world_id,run_id,revision) REFERENCES life_publication_run_history(world_id,run_id,revision)
) STRICT;
CREATE TABLE life_publication_settings (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision > 0),
 settings_json TEXT NOT NULL CHECK(json_valid(settings_json)), digest TEXT NOT NULL,
 FOREIGN KEY(world_id,revision) REFERENCES life_publication_settings_history(world_id,revision)
) STRICT;
INSERT INTO "life_publication_settings" VALUES('test-world',1,'{"agentRecipients":[{"agentId":"lina","recipientId":"friends"}],"maxActionsPerChain":10,"maxChainDepth":3,"maxJobsPerRun":1,"perAuthorCooldownSteps":0,"reactionIds":[],"version":1}','a1343b2b549111fbd7e93fe65229c360d1efe3a5bf7c91d71cf43cff0798002e');
CREATE TABLE life_publication_settings_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision > 0),
 settings_json TEXT NOT NULL CHECK(json_valid(settings_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,revision)
) STRICT;
INSERT INTO "life_publication_settings_history" VALUES('test-world',1,'{"agentRecipients":[{"agentId":"lina","recipientId":"friends"}],"maxActionsPerChain":10,"maxChainDepth":3,"maxJobsPerRun":1,"perAuthorCooldownSteps":0,"reactionIds":[],"version":1}','a1343b2b549111fbd7e93fe65229c360d1efe3a5bf7c91d71cf43cff0798002e');
CREATE TABLE life_runtime_config (
 world_id TEXT NOT NULL REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision >= 1),
 config_json TEXT NOT NULL CHECK(json_valid(config_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id, revision)
) STRICT;
INSERT INTO "life_runtime_config" VALUES('test-world',1,'{"avatars":null,"clock":null,"images":null,"limits":{"evaluation":{"maxChars":20000,"maxDepth":10,"maxOperations":100,"maxRecords":100},"maxActorActions":0,"maxCausalDepth":0,"maxModelCalls":1},"models":{"actor":{"model":"narrator","provider":"synthetic"},"director":null},"publication":{"mode":"automatic","recipientIds":["friends"]},"run":{"mode":"manual"},"usage":{"maxImages":0,"maxInputTokens":1000,"maxOutputTokens":1000,"windowMs":1000},"version":1}','53bd4fa2c094fc14bade976d981dcc459bb199dc7cdb460ae198fa841ecc51ec');
CREATE TABLE life_schedules (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id),
 schedule_json TEXT NOT NULL CHECK(json_valid(schedule_json)), digest TEXT NOT NULL
) STRICT;
INSERT INTO "life_schedules" VALUES('test-world','{"configRevision":1,"generation":1,"lastClock":1000,"lastSkippedIntervals":0,"lastStepId":null,"lease":null,"leaseSequence":0,"nextDue":null,"worldId":"test-world"}','5b8083d927d2a59bf21ec0bac61bfb39005ab7498ee05cf598b959f08180bc88');
CREATE TABLE life_states (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id), life_revision INTEGER NOT NULL CHECK(life_revision >= 0),
 world_revision INTEGER NOT NULL CHECK(world_revision >= 0), config_revision INTEGER NOT NULL,
 base_world_revision INTEGER NOT NULL CHECK(base_world_revision >= 0),
 baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json)),
 state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 FOREIGN KEY(world_id, config_revision) REFERENCES life_config(world_id, revision)
) STRICT;
INSERT INTO "life_states" VALUES('test-world',1,1,1,0,'{"attitudes":[{"axisId":"relation","fromAgentId":"lina","profileRevision":null,"toAgentId":"mira","value":0},{"axisId":"relation","fromAgentId":"lina","profileRevision":null,"toAgentId":"sol","value":0},{"axisId":"relation","fromAgentId":"mira","profileRevision":null,"toAgentId":"lina","value":0},{"axisId":"relation","fromAgentId":"mira","profileRevision":null,"toAgentId":"sol","value":0},{"axisId":"relation","fromAgentId":"sol","profileRevision":null,"toAgentId":"lina","value":0},{"axisId":"relation","fromAgentId":"sol","profileRevision":null,"toAgentId":"mira","value":0}],"baseWorldRevision":0,"beliefs":[],"checkpoint":{"data":null,"dataDigest":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","encodingVersion":1,"engineId":"empty","engineRevision":0,"ruleDigest":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","version":1},"claims":[],"definitionRevision":1,"experiences":[],"growthHistory":[],"habits":[{"agentId":"lina","habitId":"habit","profileRevision":null,"value":false},{"agentId":"mira","habitId":"habit","profileRevision":null,"value":false},{"agentId":"sol","habitId":"habit","profileRevision":null,"value":false}],"revision":0,"traits":[{"agentId":"lina","axisId":"axis","profileRevision":null,"value":0},{"agentId":"mira","axisId":"axis","profileRevision":null,"value":0},{"agentId":"sol","axisId":"axis","profileRevision":null,"value":0}],"version":1,"worldId":"test-world","worldRevision":0}','{"attitudes":[{"axisId":"relation","fromAgentId":"lina","profileRevision":1,"toAgentId":"mira","value":-1},{"axisId":"relation","fromAgentId":"lina","profileRevision":null,"toAgentId":"sol","value":0},{"axisId":"relation","fromAgentId":"mira","profileRevision":null,"toAgentId":"lina","value":0},{"axisId":"relation","fromAgentId":"mira","profileRevision":null,"toAgentId":"sol","value":0},{"axisId":"relation","fromAgentId":"sol","profileRevision":null,"toAgentId":"lina","value":0},{"axisId":"relation","fromAgentId":"sol","profileRevision":null,"toAgentId":"mira","value":0}],"baseWorldRevision":0,"beliefs":[{"agentId":"lina","claim":{"id":"false-claim","kind":"life_claim"},"confidence":"certain","experienceIds":["told"],"id":"belief-a","stance":"believes","supersedes":null}],"checkpoint":{"data":null,"dataDigest":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","encodingVersion":1,"engineId":"empty","engineRevision":0,"ruleDigest":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","version":1},"claims":[{"disclosure":{"disclosures":[],"knowers":["lina","mira"],"publication":[]},"id":"false-claim","sourceEventId":"test-world:1","supersedes":null,"text":"The key is red","truth":"false"}],"definitionRevision":1,"experiences":[{"agentId":"lina","channel":"told","claims":[{"id":"false-claim","kind":"life_claim"}],"eventId":"test-world:1","id":"told","simulationTime":1},{"agentId":"mira","channel":"direct","claims":[{"id":"whisper","kind":"world_fact"}],"eventId":"test-world:1","id":"witness","simulationTime":1}],"growthHistory":[{"delta":{"agentId":"lina","axisId":"axis","evidenceIds":["told"],"kind":"trait","next":1,"previous":0},"lifeRevision":1,"profileRevision":1},{"delta":{"axisId":"relation","evidenceIds":["told"],"fromAgentId":"lina","kind":"attitude","next":-1,"previous":0,"toAgentId":"mira"},"lifeRevision":1,"profileRevision":1}],"habits":[{"agentId":"lina","habitId":"habit","profileRevision":null,"value":false},{"agentId":"mira","habitId":"habit","profileRevision":null,"value":false},{"agentId":"sol","habitId":"habit","profileRevision":null,"value":false}],"revision":1,"traits":[{"agentId":"lina","axisId":"axis","profileRevision":1,"value":1},{"agentId":"mira","axisId":"axis","profileRevision":null,"value":0},{"agentId":"sol","axisId":"axis","profileRevision":null,"value":0}],"version":1,"worldId":"test-world","worldRevision":1}');
CREATE TABLE life_steps (
 world_id TEXT NOT NULL REFERENCES worlds(id), step_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 source_world_revision INTEGER NOT NULL CHECK(source_world_revision >= 0),
 source_life_revision INTEGER NOT NULL CHECK(source_life_revision >= 0),
 step_json TEXT NOT NULL CHECK(json_valid(step_json)), digest TEXT NOT NULL,
 accepted_life_revision INTEGER CHECK(accepted_life_revision IS NULL OR accepted_life_revision >= 1),
 PRIMARY KEY(world_id, step_id), UNIQUE(world_id, idempotency_key), UNIQUE(world_id, accepted_life_revision),
 FOREIGN KEY(world_id, accepted_life_revision) REFERENCES life_commits(world_id, life_revision)
) STRICT;
CREATE TABLE life_work_ancestry (
 world_id TEXT NOT NULL REFERENCES worlds(id), subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 refs_json TEXT NOT NULL CHECK(json_valid(refs_json)), digest TEXT NOT NULL,
 life_revision INTEGER NOT NULL CHECK(life_revision > 0),
 PRIMARY KEY(world_id,subject_kind,subject_id,life_revision)
) STRICT;
CREATE TABLE life_work_experiences (
 world_id TEXT NOT NULL REFERENCES worlds(id), receipt_id TEXT NOT NULL, receipt_revision INTEGER NOT NULL CHECK(receipt_revision > 0),
 agent_id TEXT NOT NULL, experience_id TEXT NOT NULL, input_id TEXT NOT NULL, life_revision INTEGER NOT NULL CHECK(life_revision > 0),
 PRIMARY KEY(world_id,receipt_id,receipt_revision,agent_id), UNIQUE(world_id,experience_id),
 FOREIGN KEY(world_id,input_id) REFERENCES life_inputs(world_id,input_id),
 FOREIGN KEY(world_id,life_revision) REFERENCES life_commits(world_id,life_revision)
) STRICT;
CREATE TABLE life_work_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision > 0),
 input_id TEXT, event_json TEXT NOT NULL CHECK(json_valid(event_json)), previous_digest TEXT NOT NULL, next_digest TEXT NOT NULL,
 PRIMARY KEY(world_id, revision), UNIQUE(world_id,input_id),
 FOREIGN KEY(world_id,input_id) REFERENCES life_inputs(world_id,input_id)
) STRICT;
CREATE TABLE life_work_state (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id), state_json TEXT NOT NULL CHECK(json_valid(state_json)), digest TEXT NOT NULL
) STRICT;
CREATE TABLE world_activations (
 world_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_digest TEXT NOT NULL,
 draft_id TEXT NOT NULL, draft_revision INTEGER NOT NULL,
 confirmation_json TEXT NOT NULL CHECK(json_valid(confirmation_json)), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 PRIMARY KEY(world_id, idempotency_key),
 FOREIGN KEY(draft_id, draft_revision) REFERENCES world_draft_versions(draft_id, revision)
) STRICT;
CREATE TABLE world_author_grants (
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL, agent_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
 status TEXT NOT NULL CHECK(status IN ('active', 'revoked'))
) STRICT;
CREATE TABLE world_authoring_requests (
 request_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, draft_revision INTEGER NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), input_digest TEXT NOT NULL,
 dispatch_owner_json TEXT CHECK(dispatch_owner_json IS NULL OR json_valid(dispatch_owner_json)),
 FOREIGN KEY(draft_id, draft_revision) REFERENCES world_draft_versions(draft_id, revision)
) STRICT;
CREATE TABLE world_bindings (
 agent_id TEXT PRIMARY KEY, world_id TEXT REFERENCES worlds(id),
 revision INTEGER NOT NULL CHECK(revision >= 1), policy_json TEXT NOT NULL CHECK(json_valid(policy_json))
) STRICT;
CREATE TABLE world_definition_versions (
 world_id TEXT NOT NULL REFERENCES worlds(id), version INTEGER NOT NULL CHECK(version > 0),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
 PRIMARY KEY(world_id, version)
) STRICT;
INSERT INTO "world_definition_versions" VALUES('test-world',1,'{"id":"test-world","version":1,"title":"Synthetic world","timeUnit":"story-step","initialTime":0,"agents":["lina","mira","sol"],"places":[{"id":"garden","name":"Test garden","description":"An authored test place"},{"id":"study","name":"Test study","description":"Another test place"}],"scenes":[{"id":"meeting","placeId":"garden","description":"A quiet meeting","occupants":["lina","mira"]},{"id":"reading","placeId":"study","description":"Reading alone","occupants":["sol"]}],"lore":[{"id":"secret","text":"The hidden key is blue","knownTo":["lina"]}]}');
CREATE TABLE world_draft_versions (
 draft_id TEXT NOT NULL REFERENCES world_drafts(id), revision INTEGER NOT NULL CHECK(revision >= 1),
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)), digest TEXT NOT NULL,
 PRIMARY KEY(draft_id, revision)
) STRICT;
CREATE TABLE world_drafts (
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1)
) STRICT;
CREATE TABLE world_events (world_id TEXT NOT NULL REFERENCES worlds(id), idempotency_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), event_json TEXT NOT NULL, PRIMARY KEY(world_id, idempotency_key), UNIQUE(world_id, revision)) STRICT;
INSERT INTO "world_events" VALUES('test-world','shared-event',1,'{"worldId":"test-world","idempotencyKey":"shared-event","expectedRevision":0,"simulationTime":1,"kind":"activity","sceneId":"meeting","actorIds":["lina","mira"],"audience":["lina","mira"],"summary":"A bell rang during the meeting","facts":[{"id":"bell","text":"The bell rang once","knownTo":["lina","mira"]},{"id":"whisper","text":"Mira whispered a private word","knownTo":["mira"]}],"moves":[],"id":"test-world:1","revision":1,"acceptedAt":"1970-01-01T00:00:01.000Z","origin":"fictional","definitionVersion":1}');
CREATE TABLE world_packs (
 world_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), effective_revision INTEGER NOT NULL CHECK(effective_revision >= 0),
 pack_json TEXT NOT NULL CHECK(json_valid(pack_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id, version), UNIQUE(world_id, effective_revision),
 FOREIGN KEY(world_id, version) REFERENCES world_definition_versions(world_id, version)
) STRICT;
CREATE TABLE world_social_bootstraps (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id), bootstrap_json TEXT NOT NULL CHECK(json_valid(bootstrap_json)), digest TEXT NOT NULL
) STRICT;
CREATE TABLE world_social_resolutions (
 world_id TEXT NOT NULL REFERENCES worlds(id), request_id TEXT NOT NULL, request_digest TEXT NOT NULL,
 input_digest TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), result_digest TEXT,
 accepted_life_revision INTEGER CHECK(accepted_life_revision IS NULL OR accepted_life_revision >= 1),
 PRIMARY KEY(world_id, request_id), UNIQUE(world_id, accepted_life_revision),
 FOREIGN KEY(world_id, accepted_life_revision) REFERENCES life_commits(world_id, life_revision),
 CHECK((result_json IS NULL) = (result_digest IS NULL)),
 CHECK(accepted_life_revision IS NULL OR result_json IS NOT NULL)
) STRICT;
CREATE TABLE worlds (id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, state_json TEXT NOT NULL) STRICT;
INSERT INTO "worlds" VALUES('test-world','{"id":"test-world","version":1,"title":"Synthetic world","timeUnit":"story-step","initialTime":0,"agents":["lina","mira","sol"],"places":[{"id":"garden","name":"Test garden","description":"An authored test place"},{"id":"study","name":"Test study","description":"Another test place"}],"scenes":[{"id":"meeting","placeId":"garden","description":"A quiet meeting","occupants":["lina","mira"]},{"id":"reading","placeId":"study","description":"Reading alone","occupants":["sol"]}],"lore":[{"id":"secret","text":"The hidden key is blue","knownTo":["lina"]}]}','{"revision":1,"simulationTime":1,"scenes":[{"id":"meeting","placeId":"garden","description":"A quiet meeting","occupants":["lina","mira"]},{"id":"reading","placeId":"study","description":"Reading alone","occupants":["sol"]}],"facts":[{"id":"secret","text":"The hidden key is blue","knownTo":["lina"],"sourceEventId":null},{"id":"bell","text":"The bell rang once","knownTo":["lina","mira"],"sourceEventId":"test-world:1"},{"id":"whisper","text":"Mira whispered a private word","knownTo":["mira"],"sourceEventId":"test-world:1"}]}');
COMMIT;
