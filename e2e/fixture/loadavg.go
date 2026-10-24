// SPDX-License-Identifier: Apache-2.0
package fixture

import (
	"runtime"
	"testing"
)

// RequireLoadavgFixture skips hosts that cannot bind a fixture over
// /proc/loadavg. A Linux host without bubblewrap still fails in the scenario.
func RequireLoadavgFixture(t *testing.T) {
	t.Helper()
	requireLoadavg(t, runtime.GOOS)
}

func requireLoadavg(t *testing.T, goos string) {
	t.Helper()
	if goos != "linux" {
		t.Skip("requires Linux and bubblewrap binding /proc/loadavg")
	}
}
