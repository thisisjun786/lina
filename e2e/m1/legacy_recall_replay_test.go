// SPDX-License-Identifier: Apache-2.0
package e2e_test

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"

	"github.com/thisisjun786/lina/internal/clientapi"
	"github.com/thisisjun786/lina/internal/core/assemble"
	"github.com/thisisjun786/lina/internal/core/boot"
	"github.com/thisisjun786/lina/internal/core/canon"
	"github.com/thisisjun786/lina/internal/core/ctlfiles"
	"github.com/thisisjun786/lina/internal/core/ledger"
	"github.com/thisisjun786/lina/internal/core/replay"
	"github.com/thisisjun786/lina/kit/protocol"
	"github.com/thisisjun786/lina/kit/provider"
)

// The fixture comes from the unmodified pre-#1670 binary. Keep its source
// revisions and digest: regenerating it with today's code loses this coverage.
func TestM1PreSharedRecallReplayInstalledCore(t *testing.T) {
	fixture, err := filepath.Abs("testdata/pre-shared-recall")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(fixture, "episodes.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var episode replay.Episode
	if err := json.Unmarshal(data, &episode); err != nil {
		t.Fatal(err)
	}
	if len(episode.Calls) != 0 || len(episode.Evidence.Assembly.Profile) != 1 {
		t.Fatal("fixture must retain its original memory-backed request")
	}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Input               []provider.Item
			Tools               []provider.ToolDecl
			Model, Instructions string
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		calls.Add(1)
		// Source.Load verifies the old digest before dispatch. Independently check
		// the model-bound bytes with the recorded Core-only request fields too.
		e := episode.Evidence
		rebuilt := provider.Request{Model: provider.ModelRef(request.Model), Effort: e.Effort, Purpose: provider.Turn,
			Instructions: request.Instructions, Items: request.Input, Tools: request.Tools,
			Fields: e.Fields, CacheIdentity: e.CacheIdentity, Layout: e.Layout.Clone()}
		if e.Capabilities != nil {
			rebuilt.Capabilities = e.Capabilities.Clone()
		}
		if got := assemble.Digest(rebuilt); got != e.Hash {
			t.Errorf("replayed digest = %s, old digest = %s", got, e.Hash)
		}
		emitResponse(w, "Synthetic historical replay complete.", true)
	}))
	defer server.Close()
	h, _ := installedConversationHarness(t, server.URL)
	restorePreRecallSources(t, fixture, h.root)
	core := h.command("core", "--state-root", h.root, "--socket", h.socket)
	core.command.Env = append(core.command.Env, "PATH="+preRecallSandboxPath(t), "LINA_RESPONSES_BASE_URL="+server.URL+"/v1", "LINA_RESPONSES_MODEL=fixture-model", "LINA_RESPONSES_API_KEY=synthetic-key")
	core.start(t)
	h.connect(core).Close()
	waitCoreReady(t, h)
	out := filepath.Join(h.root, "replayed-old-episode")
	p := h.command("replay", filepath.Join(fixture, "episodes.jsonl"), "--socket", h.socket, "--out", out)
	p.start(t)
	p.wait(t, 0)
	data, err = os.ReadFile(filepath.Join(out, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Selected int `json:"selected"`
		Replayed int `json:"replayed"`
		LeftOut  int `json:"left_out"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil || manifest.Selected != 1 || manifest.Replayed != 1 || manifest.LeftOut != 0 {
		t.Fatalf("old episode failed digest/source checks: %s (%v)", data, err)
	}
	if calls.Load() != 1 {
		t.Fatalf("model calls = %d, want 1", calls.Load())
	}
	// The old episode's memory sources must still match by text after upgrading.
	c, err := clientapi.DialWithCapabilities(h.ctx, h.socket, "test", []protocol.Capability{{Name: "memory", Version: "1.0"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	agent, person := episode.Evidence.Assembly.AgentID, c.Welcome.PersonID
	for _, query := range []string{"violet", "amber"} {
		op := "list"
		if _, err := c.Memory(h.ctx, protocol.MemoryRequest{Operation: &op, AgentID: &agent, Text: &query}); err != nil {
			t.Fatal(err)
		}
		frame, err := c.Receive(h.ctx)
		result, ok := frame.Payload.(protocol.MemoryResult)
		if err != nil || frame.Error != nil || !ok || result.Items == nil {
			t.Fatalf("memory query: %+v %v", frame, err)
		}
		if query == "violet" {
			if len(*result.Items) != 1 || (*result.Items)[0].ItemID != episode.Evidence.Assembly.Profile[0].ID {
				t.Fatalf("memory text match changed: %+v", result)
			}
		} else if len(*result.Items) != 0 {
			t.Fatal("memory query ignored its text")
		}
	}
	c.Close()
	h.stopCore(core)
	checkPreRecallLedger(t, h, episode, person)
}

// Search the restored historical ledger using the current shared recall entry.
func checkPreRecallLedger(t *testing.T, h *harness, ep replay.Episode, person string) {
	t.Helper()
	ctl, err := ctlfiles.Open(h.root)
	if err != nil {
		t.Fatal(err)
	}
	defer ctl.Close()
	if err := ctl.Acquire(); err != nil {
		t.Fatal(err)
	}
	epoch, err := ctl.Epoch()
	if err != nil {
		t.Fatal(err)
	}
	db, err := canon.Open(h.ctx, canon.Config{Path: filepath.Join(h.root, "canon/canon.sqlite"), Epoch: epoch, Controls: ctl, Migrations: boot.ApplicationMigrations()})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(h.ctx)
	for _, query := range []string{"notebook", "amber"} {
		hits, err := ledger.New(db, nil).Search(h.ctx, ledger.SearchQuery{AgentID: ep.Evidence.Assembly.AgentID, PersonID: person, Text: query})
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, hit := range hits {
			found = found || hit.ID == ep.Input.ID
		}
		if query == "notebook" && !found || query == "amber" && len(hits) != 0 {
			t.Fatalf("ledger search %q: %+v", query, hits)
		}
	}
}

func restorePreRecallSources(t *testing.T, fixture, state string) {
	t.Helper()
	file, err := os.Open(filepath.Join(fixture, "sources.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer compressed.Close()
	root, err := os.OpenRoot(state)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	archive := tar.NewReader(compressed)
	for {
		entry, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if entry.Typeflag != tar.TypeReg {
			t.Fatalf("unexpected fixture entry %s", entry.Name)
		}
		if err := root.MkdirAll(filepath.Dir(entry.Name), 0700); err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(archive)
		if err != nil {
			t.Fatal(err)
		}
		if err := root.WriteFile(entry.Name, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

// Expose only the sandbox launcher; host worker discovery is unrelated to replay.
func preRecallSandboxPath(t *testing.T) string {
	t.Helper()
	name := "bwrap"
	if runtime.GOOS == "darwin" {
		name = "sandbox-exec"
	}
	launcher, err := exec.LookPath(name)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	if err := os.Symlink(launcher, filepath.Join(directory, name)); err != nil {
		t.Fatal(err)
	}
	return directory
}
