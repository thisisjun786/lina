// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thisisjun786/lina/internal/core/canon"
	"github.com/thisisjun786/lina/internal/core/ctlfiles"
	"github.com/thisisjun786/lina/internal/core/recall"
)

func TestImportBatchConsentDoesNotCoverEarlierMessages(t *testing.T) {
	root := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	controls, err := ctlfiles.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { controls.Close() })
	if err = controls.Acquire(); err != nil {
		t.Fatal(err)
	}
	db, err := canon.Open(t.Context(), canon.Config{Path: filepath.Join(root, "canon.sqlite"), Epoch: 1, Controls: controls, Migrations: canon.Migrations()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close(context.Background()) })
	const fixture = `
INSERT INTO import_batch VALUES('batch-old','2026-01-01T00:00:00Z'),('batch-new','2026-01-02T00:00:00Z');
INSERT INTO conv_event(id,conversation_id,person_id,agent_id,speaker_kind,surface,origin,occurred_at,recorded_at,time_quality,body)
 VALUES('older','chat','owner','agent','person','{"kind":"import"}','{"kind":"import"}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','recorded','earlier garden'),
 ('newer','chat','owner','agent','person','{"kind":"import"}','{"kind":"import"}','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','recorded','later garden');
INSERT INTO messenger_source(person,platform,account,mode,adapter,state,connected_at) VALUES('owner','fixture','account','official','fixture','import_only','2026-01-01T00:00:00Z');
INSERT INTO messenger_chat(platform,account,chat,kind) VALUES('fixture','account','chat','direct');
INSERT INTO messenger_record(platform,account,chat,message,event,occurred_at) VALUES
 ('fixture','account','chat','old','older','2026-01-01T00:00:00Z'),
 ('fixture','account','chat','new','newer','2026-01-02T00:00:00Z');
INSERT INTO messenger_record_revision VALUES
 ('fixture','account','chat','old',1,'older'),
 ('fixture','account','chat','new',1,'newer');
INSERT INTO messenger_legacy_ref VALUES
 ('fixture','fixture','message','old','fixture','account','chat','old','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','batch-old','2026-01-01T00:00:00Z','{}'),
 ('fixture','fixture','message','new','fixture','account','chat','new','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','batch-new','2026-01-02T00:00:00Z','{}');`
	if err = db.Write(t.Context(), func(tx *canon.Tx) error {
		_, err := tx.ExecContext(t.Context(), fixture)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	for countPending(t, db) > 0 {
		if _, err = recall.New(db, nil).DrainBatch(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if err = consentImportBatch(t.Context(), db, "batch-new"); err != nil {
		t.Fatal(err)
	}
	f := &batchEmbeddings{dimension: 2}
	vectors, err := recall.NewVectors(t.Context(), db, nil, f)
	if err != nil {
		t.Fatal(err)
	}
	for range 20 {
		if _, err = vectors.DrainBatch(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	joined := strings.Join(f.texts, "\n")
	if strings.Contains(joined, "earlier garden") || !strings.Contains(joined, "later garden") {
		t.Fatalf("consent covered the wrong messages: %q", f.texts)
	}
}

func countPending(t *testing.T, db *canon.Store) int {
	t.Helper()
	var n int
	if err := db.Read(t.Context(), func(tx *canon.Tx) error {
		return tx.QueryRowContext(t.Context(), "SELECT count(*) FROM recall_pending").Scan(&n)
	}); err != nil {
		t.Fatal(err)
	}
	return n
}

type batchEmbeddings struct {
	dimension int
	texts     []string
}

func (b *batchEmbeddings) VectorConfig() recall.VectorConfig {
	return recall.VectorConfig{Endpoint: "http://localhost/embeddings", Model: "test", Dimension: b.dimension}
}
func (b *batchEmbeddings) Embed(_ context.Context, texts []string) ([][]float32, error) {
	b.texts = append(b.texts, texts...)
	out := make([][]float32, len(texts))
	for i := range texts {
		out[i] = []float32{1, 0}
	}
	return out, nil
}
