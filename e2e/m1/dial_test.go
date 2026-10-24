// SPDX-License-Identifier: Apache-2.0

package e2e_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/thisisjun786/lina/internal/clientapi"
	"github.com/thisisjun786/lina/kit/protocol"
)

// errCoreStopped and errCoreSocket are the failures the inlined socket loops
// used to report. Callers stop the test; tests match these values rather than
// message text.
var (
	errCoreStopped = errors.New("Core stopped before serving")
	errCoreSocket  = errors.New("Core socket")
)

// dialCoreSocket retries the client socket until Core accepts this client.
// The loop waits 20 ms between attempts and stops after the same bound the
// call sites used, or sooner when ctx ends. A nil coreExit skips the
// early-exit check. A non-nil coreExit returns as soon as Core has stopped
// and puts that error back, so the caller's cleanup can still read it. The
// channel needs one free buffer slot for the put-back.
func dialCoreSocket(ctx context.Context, socket, client string, capabilities []protocol.Capability, coreExit chan error) (*clientapi.Client, error) {
	for attempt := 0; ; attempt++ {
		if coreExit != nil {
			select {
			case err := <-coreExit:
				coreExit <- err
				return nil, fmt.Errorf("%w: %w", errCoreStopped, err)
			default:
			}
		}
		c, err := clientapi.DialWithCapabilities(ctx, socket, client, capabilities)
		if err == nil {
			return c, nil
		}
		if ctx.Err() != nil || attempt > 1500 {
			return nil, fmt.Errorf("%w: %w", errCoreSocket, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestDialCoreSocketFailsFastWhenCoreExits(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	stopped := errors.New("core gone")
	exited := make(chan error, 1)
	exited <- stopped
	_, err := dialCoreSocket(ctx, filepath.Join(t.TempDir(), "missing.sock"), "probe", []protocol.Capability{{Name: "progress", Version: "1.0"}}, exited)
	if !errors.Is(err, errCoreStopped) || !errors.Is(err, stopped) {
		t.Fatalf("dial error: %v", err)
	}
	select {
	case got := <-exited:
		if got != stopped {
			t.Fatalf("put back %v", got)
		}
	default:
		t.Fatal("exit error was not put back")
	}
}

func TestDialCoreSocketStopsWhenContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	done := make(chan error, 1)
	go func() {
		_, err := dialCoreSocket(ctx, filepath.Join(t.TempDir(), "missing.sock"), "probe", nil, nil)
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, errCoreSocket) {
			t.Fatalf("dial error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("dial did not stop when the context ended")
	}
}
