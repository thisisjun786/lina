// SPDX-License-Identifier: Apache-2.0
package boot

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	coreexec "github.com/thisisjun786/lina/internal/core/exec"
	"github.com/thisisjun786/lina/internal/core/guard"
	"github.com/thisisjun786/lina/internal/core/memory"
	"github.com/thisisjun786/lina/internal/core/recall"
	"github.com/thisisjun786/lina/kit/lease"
)

type recallEmbeddings struct{ calls int }

func (*recallEmbeddings) VectorConfig() recall.VectorConfig {
	return recall.VectorConfig{Endpoint: "fixture", Model: "fixture", Dimension: 2}
}
func (e *recallEmbeddings) Embed(_ context.Context, texts []string) ([][]float32, error) {
	e.calls++
	vectors := make([][]float32, len(texts))
	for i := range vectors {
		vectors[i] = []float32{1, 0}
	}
	return vectors, nil
}

func TestLiveRecallVectorsAndLexicalReplay(t *testing.T) {
	r, _ := turnRuntime(t)
	source := queuedContextEvent(t, r, "semantic-source", "The observatory telescope is violet.", guard.EntryOwner, "")
	item, err := coreexec.NewMemory(r.db, r.materials, nil).Remember(t.Context(), memory.Write{Person: r.person, Agent: r.agent, Item: memory.Item{
		Kind: memory.Fact, Content: source.Body.Text(), Subject: memory.Subject{Kind: memory.Person, ID: r.person}, Basis: memory.Stated,
		Evidence: []memory.Evidence{{Kind: memory.Event, ID: source.ID, Precision: memory.Exact}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	input, _ := admitTurnInput(t, r, "stargazing")
	read := func(ctx context.Context, id string) (string, error) {
		event, err := r.journal().Get(ctx, id)
		return event.Body.DerivedText(), err
	}
	index := recall.New(r.db, read)
	for {
		n, err := index.DrainBatch(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			break
		}
	}
	adapter := &recallEmbeddings{}
	vectors, err := recall.NewVectors(t.Context(), r.db, read, adapter)
	if err != nil {
		t.Fatal(err)
	}
	for {
		n, err := vectors.DrainBatch(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			break
		}
	}
	root := r
	if r.router != nil {
		root = r.router.root
	}
	root.vectors = vectors
	packet, err := r.topicPacket(t.Context(), input, time.Now())
	if err != nil || len(packet) != 1 || packet[0].ID != "memory:"+item.ID {
		t.Errorf("semantic topic memory: %v %v", packet, err)
	}
	for _, replay := range []bool{false, true} {
		var visible func(context.Context, recall.Result) error
		if replay {
			visible = func(context.Context, recall.Result) error { return nil }
		}
		spec, handler := r.recallTool(visible)
		in, err := spec.Schema(json.RawMessage(`{"query":"stargazing","kinds":["memory"]}`))
		if err != nil {
			t.Fatal(err)
		}
		before := adapter.calls
		out, err := handler(t.Context(), lease.Lease{}, in)
		if err != nil {
			t.Fatal(err)
		}
		var result struct{ Results []recall.Result }
		if err := json.Unmarshal(out.Body, &result); err != nil {
			t.Fatal(err)
		}
		if replay {
			if len(result.Results) != 0 || adapter.calls != before {
				t.Errorf("replay used live embeddings: %v calls=%d", result.Results, adapter.calls-before)
			}
		} else if len(result.Results) != 1 || result.Results[0].ID != item.ID || adapter.calls != before+1 {
			t.Errorf("semantic recall tool: %v calls=%d", result.Results, adapter.calls-before)
		}
	}
}
