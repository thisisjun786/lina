// SPDX-License-Identifier: Apache-2.0
package fixture

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The five installed-worker scenarios must skip for one reason: Linux plus
// bubblewrap binding a fixture over /proc/loadavg.
func TestLoadavgScenariosShareOneSkip(t *testing.T) {
	root := filepath.Join("..", "..")
	sites := []string{
		"e2e/m1/worker_load_test.go",
		"e2e/m2/acp_added_workers_test.go",
		"e2e/m2/acp_decisions_test.go",
		"e2e/m2/acp_quota_test.go",
		"e2e/m2/cursor_worker_test.go",
	}
	used := 0
	for _, site := range sites {
		body, err := os.ReadFile(filepath.Join(root, site))
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		if strings.Contains(text, "fixture.RequireLoadavgFixture(t)") {
			used++
		}
		if strings.Contains(text, "installed worker capacity requires Linux host sampling") {
			t.Errorf("%s still skips for host sampling", site)
		}
		if strings.Contains(text, `if runtime.GOOS != "linux"`) {
			t.Errorf("%s still inlines the Linux check", site)
		}
	}
	if used != len(sites) {
		t.Errorf("shared helper used by %d of %d scenarios", used, len(sites))
	}
	helper, err := os.ReadFile("loadavg.go")
	if err != nil {
		t.Fatal(err)
	}
	const skip = `t.Skip("requires Linux and bubblewrap binding /proc/loadavg")`
	if strings.Count(string(helper), skip) != 1 {
		t.Fatalf("helper does not state the Linux and bubblewrap requirement once")
	}
}

func TestRequireLoadavgFixtureSkipsOffLinux(t *testing.T) {
	if os.Getenv("LINA_LOADAVG_SKIP_PROBE") == "1" {
		requireLoadavg(t, "darwin")
		t.Fatal("darwin must skip")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestRequireLoadavgFixtureSkipsOffLinux$", "-test.v", "-test.count=1")
	cmd.Env = append(os.Environ(), "LINA_LOADAVG_SKIP_PROBE=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("probe: %v\n%s", err, out)
	}
	text := string(out)
	if !strings.Contains(text, "SKIP") || !strings.Contains(text, "requires Linux and bubblewrap binding /proc/loadavg") {
		t.Fatalf("skip output:\n%s", text)
	}
}

func TestRequireLoadavgFixtureAllowsLinux(t *testing.T) {
	requireLoadavg(t, "linux")
}
