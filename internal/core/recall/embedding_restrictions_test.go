// SPDX-License-Identifier: Apache-2.0
package recall_test

import (
	"context"
	"github.com/thisisjun786/lina/internal/core/canon"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/thisisjun786/lina/internal/core/memory"
	"github.com/thisisjun786/lina/internal/core/recall"
)

func TestEmbeddingRejectsProtectedReplayAndViewCopies(t *testing.T) {
	db := database(t)
	at := time.Unix(1700000000, 0)
	admitAt(t, db, "protected", "conversation", "owner", "agent", "protected fixture", at, "")
	admitAt(t, db, "replay-copy", "conversation", "owner", "agent", "protected replay fixture", at, "protected")
	admitAt(t, db, "view-copy", "conversation", "owner", "agent", "protected view fixture", at, "")
	write(t, db, "INSERT INTO ev_rel(event_id,target_id,kind,ordinal) VALUES('view-copy','protected','view_of',0)")
	remember(t, db, "agent", "", "protected fixture", memory.NeverLeaves, "protected")
	admitAt(t, db, "public", "conversation", "owner", "agent", "public fixture", at, "")
	drain(t, db)
	for _, id := range []string{"protected", "replay-copy", "view-copy"} {
		if n := count(t, db, "SELECT count(*) FROM recall_embed_eligible WHERE kind='event' AND source_id=?", id); n != 0 {
			t.Errorf("%s is embedding eligible: count=%d, want 0", id, n)
		}
	}
	endpoint := &fakeEmbeddings{model: "fixture", dimension: 2}
	vectors, err := recall.NewVectors(t.Context(), db, nil, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	finishVectors(t, db, vectors)
	if !reflect.DeepEqual(endpoint.texts, []string{"public fixture"}) {
		t.Errorf("embedding endpoint received %q, want only public fixture", endpoint.texts)
	}
}

// Reader and outbound embedding restrictions must agree on typed, cyclic
// provenance, without hiding the independent public sources of a derived view.
func TestEmbeddingRestrictionMatchesSourceTraversal(t *testing.T) {
	db := database(t)
	at := time.Unix(1700000000, 0)
	event := func(id string) { admitAt(t, db, id, "conversation", "owner", "agent", id+" fixture", at, "") }
	for _, id := range []string{"protected", "public", "mixed-view", "legacy-source", "view-original", "protected-view", "private-source", "body-asset"} {
		event(id)
	}
	admitAt(t, db, "protected-replay", "conversation", "owner", "agent", "protected replay fixture", at, "protected")
	admitAt(t, db, "nested-copy", "conversation", "owner", "agent", "nested fixture", at, "mixed-view")
	write(t, db, `INSERT INTO ev_rel VALUES('mixed-view','public','view_of',0),('mixed-view','protected','view_of',1),('protected-view','view-original','view_of',0)`)
	// Protecting a replay reaches its original, then all dependent views.
	remember(t, db, "agent", "", "protected replay fixture", memory.NeverLeaves, "protected-replay")
	remember(t, db, "agent", "", "protected-view fixture", memory.NeverLeaves, "protected-view")
	legacy := remember(t, db, "agent", "", "legacy-source fixture", memory.NeverLeaves, "legacy-source")
	write(t, db, "DELETE FROM cite WHERE view_kind='memory' AND view_id=?", legacy)
	private := remember(t, db, "agent", "", "private-source fixture", memory.Private, "private-source")
	middle := remember(t, db, "agent", "", "protected fixture", memory.Local, "protected")
	root := remember(t, db, "agent", "", "protected fixture", memory.NeverLeaves, "protected")
	write(t, db, "DELETE FROM cite WHERE view_kind='memory' AND view_id=?", root)
	write(t, db, `INSERT INTO cite(view_kind,view_id,added_revision,ordinal,target_kind,target_id,target_revision,precision,role) VALUES('memory',?,'1',0,'memory',?,'1','none','cites')`, root, middle)
	for _, id := range []string{"material-event", "material-copy"} {
		write(t, db, `INSERT INTO conv_event(id,conversation_id,person_id,agent_id,speaker_kind,surface,occurred_at,recorded_at,time_quality,origin,material_id,material_revision)
 VALUES(?,'conversation','owner','agent','person','{}','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','recorded','{"kind":"native"}','body-asset',1)`, id)
	}
	remember(t, db, "agent", "", "protected material fixture", memory.NeverLeaves, "material-event")
	for _, id := range []string{"summary-a", "summary-b"} {
		write(t, db, `INSERT INTO sum_node VALUES(?,'conversation',0,'fixture','1','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z',0,'ready',?,'',1)`, id, id+" fixture")
	}
	write(t, db, `INSERT INTO cite(view_kind,view_id,added_revision,ordinal,target_kind,target_id,target_revision,precision,role) VALUES
 ('summary','summary-a','1',0,'event','protected','0','event','covers'),
 ('summary','summary-a','1',1,'event','public','0','event','covers'),
 ('summary','summary-a','1',2,'summary','summary-b','1','none','cites'),
 ('summary','summary-b','1',0,'summary','summary-a','1','none','cites')`)
	// A dropped citation cannot restrict its former target.
	write(t, db, `INSERT INTO cite(view_kind,view_id,added_revision,dropped_revision,ordinal,target_kind,target_id,target_revision,precision,role) VALUES('memory',?,'1','2',1,'event','public','0','event','cites')`, root)
	read := func(context.Context, string) (string, error) { return "protected material fixture", nil }
	index := recall.New(db, read)
	for attempts := 0; count(t, db, "SELECT count(*) FROM recall_pending") > 0; attempts++ {
		if attempts == 20 {
			t.Fatal("index did not drain")
		}
		if _, err := index.DrainBatch(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	checks := []struct {
		kind, id string
		blocked  bool
	}{
		{"event", "protected", true}, {"event", "protected-replay", true}, {"event", "mixed-view", true}, {"event", "nested-copy", true},
		{"event", "legacy-source", true}, {"event", "view-original", true}, {"event", "protected-view", true},
		{"event", "material-event", true}, {"event", "material-copy", true}, {"summary", "summary-a", true}, {"summary", "summary-b", true},
		{"memory", middle, true}, {"memory", root, true}, {"memory", legacy, true},
		{"event", "public", false}, {"event", "body-asset", false}, {"event", "private-source", false}, {"memory", private, false},
	}
	for _, check := range checks {
		t.Run(check.kind+"/"+check.id, func(t *testing.T) {
			if n := count(t, db, "SELECT count(*) FROM recall_doc WHERE kind=? AND source_id=?", check.kind, check.id); n != 1 {
				t.Fatalf("fixture document count=%d", n)
			}
			err := db.Read(t.Context(), func(tx *canon.Tx) error {
				blocked, err := recall.SourceRestricted(t.Context(), tx, recall.Scope{Person: "owner", Agent: "agent", ExternalModel: true}, check.kind, check.id)
				if err != nil {
					return err
				}
				if blocked != check.blocked {
					t.Errorf("reader restricted=%v, want %v", blocked, check.blocked)
				}
				var eligible bool
				if err := tx.QueryRowContext(t.Context(), "SELECT EXISTS(SELECT 1 FROM recall_embed_eligible WHERE kind=? AND source_id=?)", check.kind, check.id).Scan(&eligible); err != nil {
					return err
				}
				if eligible == check.blocked {
					t.Errorf("embedding eligible=%v, want %v", eligible, !check.blocked)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
	endpoint := &fakeEmbeddings{model: "fixture", dimension: 2}
	vectors, err := recall.NewVectors(t.Context(), db, read, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	finishVectors(t, db, vectors)
	want := []string{"body-asset fixture", "private-source fixture", "private-source fixture", "public fixture"}
	slices.Sort(endpoint.texts)
	if !reflect.DeepEqual(endpoint.texts, want) {
		t.Errorf("embedding endpoint received %q, want %q", endpoint.texts, want)
	}
}

func TestEmbeddingRechecksMaterialRestrictionsBeforeDispatch(t *testing.T) {
	db := database(t)
	write(t, db, `INSERT INTO conv_event(id,conversation_id,person_id,agent_id,speaker_kind,surface,occurred_at,recorded_at,time_quality,origin,material_id,material_revision) VALUES
 ('original','conversation','owner','agent','person','{}','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','recorded','{"kind":"native"}','shared-body',1),
 ('derived','conversation','owner','agent','person','{}','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','recorded','{"kind":"native"}','shared-body',1)`)
	item := remember(t, db, "agent", "", "material fixture", memory.Local, "original")
	read := func(context.Context, string) (string, error) { return "material fixture", nil }
	index := recall.New(db, read)
	if _, err := index.DrainBatch(t.Context()); err != nil {
		t.Fatal(err)
	}
	endpoint := &fakeEmbeddings{model: "fixture", dimension: 2}
	restricted := false
	vectors, err := recall.NewVectors(t.Context(), db, func(ctx context.Context, _ string) (string, error) {
		if !restricted {
			restricted = true
			if err := db.Write(ctx, func(tx *canon.Tx) error {
				_, err := tx.ExecContext(ctx, "UPDATE memory_item SET scope='never-leaves',record=json_set(record,'$.scope','never-leaves') WHERE id=?", item)
				return err
			}); err != nil {
				return "", err
			}
		}
		return "material fixture", nil
	}, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := vectors.DrainBatch(t.Context()); err != nil {
		t.Fatal(err)
	}
	if !restricted {
		t.Fatal("fixture did not exercise the material read")
	}
	if endpoint.calls != 0 {
		t.Fatalf("late restriction leaked %q", endpoint.texts)
	}
	if n := vectorCount(t, db); n != 0 {
		t.Fatalf("late restriction published %d vectors", n)
	}
}
