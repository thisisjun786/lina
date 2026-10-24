// SPDX-License-Identifier: Apache-2.0
package messenger_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/thisisjun786/lina/internal/core/canon"
	"github.com/thisisjun786/lina/internal/core/messenger"
)

func TestGapNoticeRetriesAfterAdmissionFailureAndRestart(t *testing.T) {
	f := newFixture(t)
	source := f.connect(t)
	adapter := &fakeAdapter{window: 48 * time.Hour, chats: []messenger.Chat{{ID: "dm-1", Name: "Direct", Kind: "direct", LastMessageID: "m-1"}}, pages: map[string][]messenger.Page{"": {{Messages: []messenger.Message{message("m-1", messenger.RoutePerson, f.now, "only")}, Next: "m-1", Through: f.now}}}}
	service := messenger.NewService(f.store, map[string]messenger.Adapter{"discord": adapter}, time.Hour)
	if _, err := service.Sync(t.Context(), source); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(49 * time.Hour)
	interrupted := errors.New("notice admission interrupted")
	service.Notify = func(context.Context, messenger.Source, messenger.ChatRecord, string) error { return interrupted }
	if _, err := service.Sync(t.Context(), source); !errors.Is(err, interrupted) {
		t.Fatalf("injection: %v", err)
	}
	if got := count(t, f.db, "SELECT count(*) FROM messenger_gap"); got != 1 {
		t.Fatalf("gap not committed: %d", got)
	}
	service.Close()
	// Rebuild all messenger state from canon; the next pass has fresh coverage.
	service = messenger.NewService(messenger.Open(f.db, nil, f.removal).WithClock(func() time.Time { return f.now }), map[string]messenger.Adapter{"discord": adapter}, time.Hour)
	defer service.Close()
	delivered := 0
	service.Notify = func(context.Context, messenger.Source, messenger.ChatRecord, string) error { delivered++; return nil }
	for range 2 {
		if _, err := service.Sync(t.Context(), source); err != nil {
			t.Fatal(err)
		}
	}
	if delivered != 1 {
		t.Fatalf("recovered gap notices = %d, want 1", delivered)
	}
}

func TestGapAndPendingNoticeCommitTogether(t *testing.T) {
	f := newFixture(t)
	source := f.connect(t)
	if err := f.db.Write(t.Context(), func(tx *canon.Tx) error {
		_, err := tx.ExecContext(t.Context(), `CREATE TRIGGER fail_notice BEFORE INSERT ON messenger_gap_notice BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.NoteGap(t.Context(), source, "dm-1"); err == nil {
		t.Fatal("outbox failure was ignored")
	}
	if got := count(t, f.db, "SELECT count(*) FROM messenger_gap"); got != 0 {
		t.Fatalf("gap committed without pending warning: %d", got)
	}
}

func TestPendingGapSurvivesClearAndRetriesWithoutAnAdapter(t *testing.T) {
	f := newFixture(t)
	source := f.connect(t)
	if _, err := f.store.NoteGap(t.Context(), source, "dm-1"); err != nil {
		t.Fatal(err)
	}
	if err := f.store.ClearGap(t.Context(), source, "dm-1"); err != nil {
		t.Fatal(err)
	}
	source.State = messenger.StateNeedsSignIn
	if err := f.store.Connect(t.Context(), source); err != nil {
		t.Fatal(err)
	}
	service := messenger.NewService(f.store, nil, time.Hour)
	defer service.Close()
	var ids []string
	service.Notify = func(_ context.Context, _ messenger.Source, chat messenger.ChatRecord, id string) error {
		ids = append(ids, id)
		if chat.Chat != "dm-1" || id == "" {
			t.Fatalf("notice lost identity: %+v %q", chat, id)
		}
		if len(ids) == 1 {
			return errors.New("interrupted admission")
		}
		return nil
	}
	for range 3 {
		service.SyncAll(t.Context(), nil)
	}
	if len(ids) != 2 || ids[0] != ids[1] {
		t.Fatalf("retry identity: %v", ids)
	}
	if got := count(t, f.db, "SELECT count(*) FROM messenger_gap_notice"); got != 0 {
		t.Fatalf("acknowledged notices remain: %d", got)
	}
}
