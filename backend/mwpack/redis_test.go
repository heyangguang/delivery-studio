package mwpack_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"delivery-studio/mwpack"
)

const redisHA = `
id: rd-prod
title: 生产 Redis 集群
hosts:
  - {name: rd-1, ip: 10.0.2.11, disk: /dev/vdb}
  - {name: rd-2, ip: 10.0.2.12, disk: /dev/vdb}
  - {name: rd-3, ip: 10.0.2.13, disk: /dev/vdb}
controller: rd-1
instances:
  - id: cache
    component: redis
    placement: {primary: [rd-1], replica: [rd-2, rd-3]}
    params: {maxmemory: 6GB}
`

const redisSingle = `
id: rd-one
hosts:
  - {name: rd-1, ip: 10.0.2.11, disk: /dev/vdb}
instances:
  - id: cache
    component: redis
    placement: {primary: [rd-1]}
`

func TestRedisSolve(t *testing.T) {
	plan := mustSolve(t, fullCatalog(t), redisHA)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	in := plan.Instance("cache")
	if in == nil || strings.Join(in.Roles["replica"], ",") != "rd-2,rd-3" {
		t.Fatalf("instance = %+v", in)
	}
	// 3 machines and quorum 2 is the shape of the manual; a persistence warning is expected, nothing else about topology
	for _, w := range plan.Issues {
		if w.Severity == "error" {
			t.Errorf("unexpected error: %s", w.Message)
		}
	}
	single := mustSolve(t, fullCatalog(t), redisSingle)
	if err := single.Err(); err != nil {
		t.Fatal(err)
	}
	for _, p := range single.Instance("cache").Packages {
		if p.Name == "redis-sentinel" {
			t.Errorf("a single node must not install the sentinel")
		}
	}
}

func TestRedisSwapStepOnlyWhenChosen(t *testing.T) {
	install := func(yaml string) string {
		plan := mustSolve(t, fullCatalog(t), yaml)
		if err := plan.Err(); err != nil {
			t.Fatal(err)
		}
		b, err := mwpack.Render(plan, mwpack.RenderOptions{})
		if err != nil {
			t.Fatal(err)
		}
		f, ok := b.Project["playbooks/01-install.yml"]
		if !ok {
			t.Fatalf("no install playbook in %v", len(b.Project))
		}
		return string(f.Data)
	}
	if strings.Contains(install(redisHA), "tasks_from: swap") {
		t.Error("swap must stay untouched unless the plan chooses to turn it off")
	}
	on := strings.Replace(redisHA, "params: {maxmemory: 6GB}", "params: {maxmemory: 6GB, disable_swap: true}", 1)
	if !strings.Contains(install(on), "tasks_from: swap") {
		t.Error("choosing disable_swap must add the swap step to the install phase")
	}
}

func TestRedisQuorumMustBeAMajority(t *testing.T) {
	plan := mustSolve(t, fullCatalog(t), strings.Replace(redisHA, "params: {maxmemory: 6GB}", "params: {maxmemory: 6GB, sentinel_quorum: 1}", 1))
	if plan.Err() == nil {
		t.Fatal("quorum 1 of 3 sentinels is not a majority and must be refused")
	}
}

func TestRedisProjectIsValidAnsible(t *testing.T) {
	ansibleAvailable(t)
	swapOn := strings.Replace(redisHA, "params: {maxmemory: 6GB}", "params: {maxmemory: 6GB, disable_swap: true}", 1)
	for name, y := range map[string]string{"single": redisSingle, "ha": redisHA, "ha-swap": swapOn} {
		t.Run(name, func(t *testing.T) {
			plan := mustSolve(t, fullCatalog(t), y)
			if err := plan.Err(); err != nil {
				t.Fatal(err)
			}
			b, err := mwpack.Render(plan, mwpack.RenderOptions{Runner: "ansible-playbook -i inventory/hosts.yml"})
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			for n, f := range b.Project {
				p := filepath.Join(dir, filepath.FromSlash(n))
				os.MkdirAll(filepath.Dir(p), 0o755)
				os.WriteFile(p, f.Data, 0o644)
			}
			syntaxCheck(t, dir)
		})
	}
}

func TestRedisRenderedConfigs(t *testing.T) {
	ansibleAvailable(t)
	plan := mustSolve(t, fullCatalog(t), redisHA)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	b, err := mwpack.Render(plan, mwpack.RenderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for n, f := range b.Project {
		p := filepath.Join(dir, filepath.FromSlash(n))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, f.Data, 0o644)
	}
	os.MkdirAll(filepath.Join(dir, "secrets", "cache"), 0o700)
	os.WriteFile(filepath.Join(dir, "secrets", "cache", "redis"), []byte("S3cretRedisPassword0123456789ab\n"), 0o600)
	got := renderTemplates(t, plan, dir)

	primary := got["rd-1/cache/redis.conf"]
	for _, want := range []string{
		"bind 0.0.0.0", "protected-mode yes", "port 6379", "supervised systemd",
		"logfile /data/redis/log/redis-server.log", "dir /data/redis/data",
		"maxmemory 6442450944", "maxmemory-policy allkeys-lru", "maxmemory-samples 5",
		"save \"\"", "appendonly no", "repl-diskless-sync yes", "repl-backlog-size 1048576",
		"requirepass S3cretRedisPassword0123456789ab", "masterauth S3cretRedisPassword0123456789ab",
	} {
		if !strings.Contains(primary, want) {
			t.Errorf("primary redis.conf lacks %q:\n%s", want, primary)
		}
	}
	if strings.Contains(primary, "\nreplicaof ") {
		t.Errorf("the primary must not carry replicaof:\n%s", primary)
	}
	replica := got["rd-2/cache/redis.conf"]
	if strings.Count(replica, "\nreplicaof 10.0.2.11 6379") != 1 {
		t.Errorf("a replica needs exactly one replicaof the primary:\n%s", replica)
	}
	sentinel := got["rd-3/cache/sentinel.conf"]
	for _, want := range []string{
		"port 26379", "protected-mode no", "pidfile /run/sentinel/redis-sentinel.pid",
		"sentinel monitor mymaster 10.0.2.11 6379 2",
		"sentinel auth-pass mymaster S3cretRedisPassword0123456789ab",
		"sentinel down-after-milliseconds mymaster 30000", "sentinel parallel-syncs mymaster 1",
		"sentinel failover-timeout mymaster 180000", "sentinel deny-scripts-reconfig yes",
	} {
		if !strings.Contains(sentinel, want) {
			t.Errorf("sentinel.conf lacks %q:\n%s", want, sentinel)
		}
	}
	if strings.Index(sentinel, "sentinel monitor") > strings.Index(sentinel, "sentinel auth-pass") {
		t.Errorf("auth-pass must come after monitor:\n%s", sentinel)
	}
	lr := got["rd-1/cache/logrotate"]
	for _, want := range []string{"/data/redis/log/redis-server.log /data/redis/log/redis-sentinel.log {", "rotate 14", "maxsize 104857600", "create 0660 redis redis"} {
		if !strings.Contains(lr, want) {
			t.Errorf("logrotate lacks %q:\n%s", want, lr)
		}
	}
}

// Every delivery keeps a full log of each run under logs/: the plugin ships with the project and ansible.cfg enables it.
func TestProjectKeepsRunLogs(t *testing.T) {
	plan := mustSolve(t, fullCatalog(t), redisSingle)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	b, err := mwpack.Render(plan, mwpack.RenderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cb, ok := b.Project["callback_plugins/mw_log.py"]
	if !ok || !strings.Contains(string(cb.Data), "no_log") {
		t.Fatal("the log plugin is not part of the project")
	}
	cfg := string(b.Project["ansible.cfg"].Data)
	if !strings.Contains(cfg, "callbacks_enabled = mw_log") || !strings.Contains(cfg, "callback_plugins = callback_plugins") {
		t.Fatalf("ansible.cfg does not enable the log plugin:\n%s", cfg)
	}
	var handbook string
	for _, d := range b.Docs {
		handbook += string(d)
	}
	if !strings.Contains(handbook, "logs/") {
		t.Fatal("the handbook does not say where the logs are")
	}
}

// A step carries its tasks said as commands, for the customer who runs the delivery by hand.
func TestStepsCarryCommands(t *testing.T) {
	plan := mustSolve(t, fullCatalog(t), redisSingle)
	b, err := mwpack.Render(plan, mwpack.RenderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Deploy []struct {
			Steps []struct {
				ID      string
				Actions []mwpack.Action
			}
		}
	}
	if err := json.Unmarshal(b.PlanDoc, &doc); err != nil {
		t.Fatal(err)
	}
	n, withCmd := 0, 0
	for _, ph := range doc.Deploy {
		for _, s := range ph.Steps {
			for _, a := range s.Actions {
				n++
				if a.Cmd != "" {
					withCmd++
				}
			}
		}
	}
	if n < 20 || withCmd < 10 {
		t.Fatalf("too few actions in the plan: %d, %d with a command", n, withCmd)
	}
	if testing.Verbose() {
		for _, ph := range doc.Deploy {
			for _, s := range ph.Steps {
				for _, a := range s.Actions {
					t.Logf("%s | %s | %s", s.ID, a.Name, strings.ReplaceAll(a.Cmd, "\n", " ⏎ "))
				}
			}
		}
	}
}

// The commands are said with the deployment's values filled in, and never with a password.
func TestStepCommandsAreFilledIn(t *testing.T) {
	for name, y := range map[string]string{"redis": redisHA, "pg": pgSingle} {
		plan := mustSolve(t, fullCatalog(t), y)
		b, err := mwpack.Render(plan, mwpack.RenderOptions{})
		if err != nil {
			t.Fatal(name, err)
		}
		var doc struct {
			Deploy []struct {
				Steps []struct{ Actions []mwpack.Action }
			}
		}
		if err := json.Unmarshal(b.PlanDoc, &doc); err != nil {
			t.Fatal(err)
		}
		total, open := 0, 0
		for _, ph := range doc.Deploy {
			for _, s := range ph.Steps {
				for _, a := range s.Actions {
					if strings.Contains(a.Cmd, "ansible.builtin.password") {
						t.Errorf("%s: a password source in a command: %s", name, a.Cmd)
					}
					if a.Cmd != "" {
						total++
						if strings.Contains(a.Cmd, "{{") {
							open++
							t.Logf("%s open: %s | %s", name, a.Name, strings.ReplaceAll(a.Cmd, "\n", " ⏎ "))
						}
					}
				}
			}
		}
		if total == 0 || open*4 > total {
			t.Errorf("%s: %d of %d commands still carry variables", name, open, total)
		}
	}
}
