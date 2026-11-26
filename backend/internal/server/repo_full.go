package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
)

const fullStoreSchemaSQL = `
CREATE TABLE IF NOT EXISTS middleware_store_migrations(
	mig_key text PRIMARY KEY,
	migrated_at timestamptz NOT NULL DEFAULT now(),
	summary jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS middleware_store_settings(
	namespace text PRIMARY KEY,
	document jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS middleware_store_job_specs(
	job_id text PRIMARY KEY,
	cluster_id text NOT NULL DEFAULT '',
	spec_yaml text NOT NULL DEFAULT '',
	plan_json jsonb,
	lock_json jsonb,
	progress_json jsonb,
	patches_json jsonb,
	proposals_json jsonb,
	amendments_json jsonb,
	run_logs_json jsonb,
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS middleware_store_job_specs_cluster ON middleware_store_job_specs(cluster_id);
CREATE TABLE IF NOT EXISTS middleware_store_cluster_state(
	cluster_id text PRIMARY KEY,
	baseline_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
	live_snapshot jsonb,
	drift_report jsonb,
	probe_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
	data_source text NOT NULL DEFAULT 'static_spec',
	last_probed_at text NOT NULL DEFAULT '',
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS middleware_store_components(
	name text NOT NULL,
	slot text NOT NULL,
	rev integer NOT NULL DEFAULT 0,
	files jsonb NOT NULL DEFAULT '{}'::jsonb,
	meta jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (name, slot)
);
CREATE TABLE IF NOT EXISTS middleware_store_exec_state(
	slot text PRIMARY KEY,
	document jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS middleware_store_cluster_automation(
	cluster_id text PRIMARY KEY,
	document jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS middleware_store_rehearsal_tasks(
	id text PRIMARY KEY,
	cluster_id text NOT NULL,
	rehearsal_id text NOT NULL DEFAULT '',
	state text NOT NULL,
	created_at text NOT NULL,
	document jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS middleware_store_rehearsal_tasks_cluster ON middleware_store_rehearsal_tasks(cluster_id, created_at DESC);
CREATE INDEX IF NOT EXISTS middleware_store_rehearsal_tasks_state ON middleware_store_rehearsal_tasks(state);
CREATE TABLE IF NOT EXISTS middleware_store_rehearsals(
	id text PRIMARY KEY,
	cluster_id text NOT NULL,
	stage text NOT NULL DEFAULT '',
	applied boolean NOT NULL DEFAULT false,
	updated_at text NOT NULL DEFAULT '',
	document jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS middleware_store_rehearsals_cluster ON middleware_store_rehearsals(cluster_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS middleware_store_cluster_docs(
	cluster_id text NOT NULL,
	doc_key text NOT NULL,
	document jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (cluster_id, doc_key)
);
CREATE TABLE IF NOT EXISTS middleware_store_sec_scans(
	slot text PRIMARY KEY,
	document jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS middleware_store_sec_triage(
	triage_key text PRIMARY KEY,
	vuln_id text NOT NULL DEFAULT '',
	updated_at text NOT NULL DEFAULT '',
	document jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS middleware_store_kv_records(
	scope text NOT NULL,
	item_key text NOT NULL,
	sort_ts text NOT NULL DEFAULT '',
	document jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (scope, item_key)
);
CREATE INDEX IF NOT EXISTS middleware_store_kv_records_scope ON middleware_store_kv_records(scope, sort_ts DESC);
CREATE TABLE IF NOT EXISTS middleware_store_ai_usage(
	id text PRIMARY KEY,
	month text NOT NULL,
	at_ts text NOT NULL,
	username text NOT NULL DEFAULT '',
	feature text NOT NULL DEFAULT '',
	document jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS middleware_store_ai_usage_at ON middleware_store_ai_usage(at_ts);
`

func (r *storeRepository) saveAIUsage(u aiUsage) error {
	if u.ID == "" || len(u.At) < 7 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b, err := json.Marshal(u)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `
		INSERT INTO middleware_store_ai_usage(id, month, at_ts, username, feature, document)
		VALUES($1, $2, $3, $4, $5, $6)
		ON CONFLICT(id) DO UPDATE SET at_ts=excluded.at_ts, document=excluded.document`,
		u.ID, u.At[:7], u.At, u.User, u.Feature, b)
	return err
}

func (r *storeRepository) listAIUsageBetween(fromISO, toISO string) ([]aiUsage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx,
		"SELECT document FROM middleware_store_ai_usage WHERE at_ts >= $1 AND at_ts < $2 ORDER BY at_ts ASC",
		fromISO, toISO)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []aiUsage{}
	for rows.Next() {
		var b []byte
		var u aiUsage
		if rows.Scan(&b) == nil && json.Unmarshal(b, &u) == nil {
			out = append(out, u)
		}
	}
	return out, rows.Err()
}

// ---- Migrations ----

func (r *storeRepository) hasMigration(key string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var k string
	err := r.db.QueryRowContext(ctx, "SELECT mig_key FROM middleware_store_migrations WHERE mig_key=$1", key).Scan(&k)
	return err == nil && k == key
}

func (r *storeRepository) recordMigration(key string, summary any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b, _ := json.Marshal(summary)
	if len(b) == 0 {
		b = []byte("{}")
	}
	_, err := r.db.ExecContext(ctx,
		"INSERT INTO middleware_store_migrations(mig_key, summary) VALUES($1, $2) ON CONFLICT(mig_key) DO UPDATE SET migrated_at=now(), summary=excluded.summary",
		key, b)
	return err
}

// ---- Settings ----

func (r *storeRepository) getSettingRaw(ns string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var b []byte
	err := r.db.QueryRowContext(ctx, "SELECT document FROM middleware_store_settings WHERE namespace=$1", ns).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

func (r *storeRepository) saveSettingRaw(ns string, doc []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx,
		"INSERT INTO middleware_store_settings(namespace, document, updated_at) VALUES($1, $2, now()) ON CONFLICT(namespace) DO UPDATE SET document=excluded.document, updated_at=now()",
		ns, doc)
	return err
}

func (r *storeRepository) saveSettingValue(ns string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return r.saveSettingRaw(ns, b)
}

func (r *storeRepository) loadSettingValue(ns string, out any) (bool, error) {
	b, ok, err := r.getSettingRaw(ns)
	if err != nil || !ok {
		return false, err
	}
	if err := json.Unmarshal(b, out); err != nil {
		return false, err
	}
	return true, nil
}

// ---- Job Specs & Structured Artifacts ----

func (r *storeRepository) upsertJobSpecYAML(jobID, clusterID string, specYAML []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO middleware_store_job_specs(job_id, cluster_id, spec_yaml, updated_at)
		VALUES($1, $2, $3, now())
		ON CONFLICT(job_id) DO UPDATE SET
			cluster_id = CASE WHEN excluded.cluster_id <> '' THEN excluded.cluster_id ELSE middleware_store_job_specs.cluster_id END,
			spec_yaml = excluded.spec_yaml,
			updated_at = now()`,
		jobID, clusterID, string(specYAML))
	return err
}

func (r *storeRepository) getJobSpecYAML(jobID string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var y string
	err := r.db.QueryRowContext(ctx, "SELECT spec_yaml FROM middleware_store_job_specs WHERE job_id=$1", jobID).Scan(&y)
	if errors.Is(err, sql.ErrNoRows) || strings.TrimSpace(y) == "" {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return []byte(y), true, nil
}

func (r *storeRepository) upsertJobPlanAndLock(jobID, clusterID string, planJSON, lockJSON []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var planArg, lockArg any
	if len(planJSON) > 0 {
		planArg = planJSON
	}
	if len(lockJSON) > 0 {
		lockArg = lockJSON
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO middleware_store_job_specs(job_id, cluster_id, plan_json, lock_json, updated_at)
		VALUES($1, $2, $3, $4, now())
		ON CONFLICT(job_id) DO UPDATE SET
			cluster_id = CASE WHEN excluded.cluster_id <> '' THEN excluded.cluster_id ELSE middleware_store_job_specs.cluster_id END,
			plan_json = COALESCE(excluded.plan_json, middleware_store_job_specs.plan_json),
			lock_json = COALESCE(excluded.lock_json, middleware_store_job_specs.lock_json),
			updated_at = now()`,
		jobID, clusterID, planArg, lockArg)
	return err
}

func (r *storeRepository) getJobPlanJSON(jobID string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var b []byte
	err := r.db.QueryRowContext(ctx, "SELECT plan_json FROM middleware_store_job_specs WHERE job_id=$1", jobID).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) || len(b) == 0 {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

func (r *storeRepository) getJobLockJSON(jobID string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var b []byte
	err := r.db.QueryRowContext(ctx, "SELECT lock_json FROM middleware_store_job_specs WHERE job_id=$1", jobID).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) || len(b) == 0 {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

var allowedJobDocCols = map[string]bool{
	"progress_json":   true,
	"patches_json":    true,
	"proposals_json":  true,
	"amendments_json": true,
	"run_logs_json":   true,
}

func (r *storeRepository) upsertJobDocCol(jobID, col string, doc []byte) error {
	if !allowedJobDocCols[col] {
		return errors.New("invalid job doc column")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	q := "INSERT INTO middleware_store_job_specs(job_id, " + col + ", updated_at) VALUES($1, $2, now()) ON CONFLICT(job_id) DO UPDATE SET " + col + "=excluded." + col + ", updated_at=now()"
	_, err := r.db.ExecContext(ctx, q, jobID, doc)
	return err
}

func (r *storeRepository) getJobDocCol(jobID, col string) ([]byte, bool, error) {
	if !allowedJobDocCols[col] {
		return nil, false, errors.New("invalid job doc column")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var b []byte
	err := r.db.QueryRowContext(ctx, "SELECT "+col+" FROM middleware_store_job_specs WHERE job_id=$1", jobID).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) || len(b) == 0 {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

// ---- Components ----

type compSlotRow struct {
	Name  string
	Slot  string
	Rev   int
	Files fileSet
	Meta  []byte
}

func (r *storeRepository) getComponentSlot(name, slot string) (compSlotRow, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var rev int
	var fb, mb []byte
	err := r.db.QueryRowContext(ctx, "SELECT rev, files, meta FROM middleware_store_components WHERE name=$1 AND slot=$2", name, slot).Scan(&rev, &fb, &mb)
	if errors.Is(err, sql.ErrNoRows) {
		return compSlotRow{}, false, nil
	}
	if err != nil {
		return compSlotRow{}, false, err
	}
	files := fileSet{}
	if len(fb) > 0 {
		_ = json.Unmarshal(fb, &files)
	}
	return compSlotRow{Name: name, Slot: slot, Rev: rev, Files: files, Meta: mb}, true, nil
}

func (r *storeRepository) hasComponentSlot(name, slot string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var rev int
	err := r.db.QueryRowContext(ctx, "SELECT rev FROM middleware_store_components WHERE name=$1 AND slot=$2", name, slot).Scan(&rev)
	return err == nil
}

func (r *storeRepository) saveComponentSlot(name, slot string, rev int, files fileSet, meta any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	fb, err := json.Marshal(files)
	if err != nil {
		return err
	}
	var mb []byte
	switch v := meta.(type) {
	case nil:
		mb = []byte("{}")
	case []byte:
		if len(v) == 0 {
			mb = []byte("{}")
		} else {
			mb = v
		}
	default:
		mb, err = json.Marshal(v)
		if err != nil {
			return err
		}
	}
	_, err = r.db.ExecContext(ctx, `
		INSERT INTO middleware_store_components(name, slot, rev, files, meta, updated_at)
		VALUES($1, $2, $3, $4, $5, now())
		ON CONFLICT(name, slot) DO UPDATE SET rev=excluded.rev, files=excluded.files, meta=excluded.meta, updated_at=now()`,
		name, slot, rev, fb, mb)
	return err
}

func (r *storeRepository) deleteComponentSlot(name, slot string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx, "DELETE FROM middleware_store_components WHERE name=$1 AND slot=$2", name, slot)
	return err
}

func (r *storeRepository) deleteComponentAll(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx, "DELETE FROM middleware_store_components WHERE name=$1 AND slot <> 'verifications'", name)
	return err
}

func (r *storeRepository) listLiveComponents() ([]compSlotRow, error) {
	return r.listComponentsBySlot("live")
}

func (r *storeRepository) listV2Components() ([]compSlotRow, error) {
	return r.listComponentsBySlot("v2")
}

func (r *storeRepository) listComponentsBySlot(slot string) ([]compSlotRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT name, rev, files, meta FROM middleware_store_components WHERE slot=$1 ORDER BY name", slot)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []compSlotRow
	for rows.Next() {
		var name string
		var rev int
		var fb, mb []byte
		if err := rows.Scan(&name, &rev, &fb, &mb); err != nil {
			return nil, err
		}
		files := fileSet{}
		_ = json.Unmarshal(fb, &files)
		out = append(out, compSlotRow{Name: name, Slot: slot, Rev: rev, Files: files, Meta: mb})
	}
	return out, rows.Err()
}

func (r *storeRepository) listDraftComponentNames() ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT name FROM middleware_store_components WHERE slot='draft' ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil && name != "" {
			out = append(out, name)
		}
	}
	return out, rows.Err()
}

func (r *storeRepository) listComponentRevisions(name string) ([]revMeta, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT rev, meta FROM middleware_store_components WHERE name=$1 AND slot LIKE 'history:%' ORDER BY rev ASC", name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []revMeta
	for rows.Next() {
		var rev int
		var mb []byte
		if rows.Scan(&rev, &mb) == nil {
			var m revMeta
			if json.Unmarshal(mb, &m) == nil {
				if m.Rev == 0 {
					m.Rev = rev
				}
				out = append(out, m)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Rev < out[j].Rev })
	return out, rows.Err()
}

// ---- Executions, Agents, Cluster Automation & Rehearsal Tasks ----

func (r *storeRepository) getExecStateSlot(slot string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var b []byte
	err := r.db.QueryRowContext(ctx, "SELECT document FROM middleware_store_exec_state WHERE slot=$1", slot).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

func (r *storeRepository) saveExecStateSlot(slot string, doc []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx,
		"INSERT INTO middleware_store_exec_state(slot, document, updated_at) VALUES($1, $2, now()) ON CONFLICT(slot) DO UPDATE SET document=excluded.document, updated_at=now()",
		slot, doc)
	return err
}

func (r *storeRepository) getClusterAutomation(clusterID string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var b []byte
	err := r.db.QueryRowContext(ctx, "SELECT document FROM middleware_store_cluster_automation WHERE cluster_id=$1", clusterID).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

func (r *storeRepository) saveClusterAutomation(clusterID string, doc []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx,
		"INSERT INTO middleware_store_cluster_automation(cluster_id, document, updated_at) VALUES($1, $2, now()) ON CONFLICT(cluster_id) DO UPDATE SET document=excluded.document, updated_at=now()",
		clusterID, doc)
	return err
}

func (r *storeRepository) listAllClusterAutomations() (map[string][]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT cluster_id, document FROM middleware_store_cluster_automation")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]byte{}
	for rows.Next() {
		var cid string
		var b []byte
		if rows.Scan(&cid, &b) == nil && cid != "" {
			out[cid] = b
		}
	}
	return out, rows.Err()
}

func (r *storeRepository) saveRehearsalTask(t rehearsalExecTask) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	b, err := json.Marshal(t)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `
		INSERT INTO middleware_store_rehearsal_tasks(id, cluster_id, rehearsal_id, state, created_at, document)
		VALUES($1, $2, $3, $4, $5, $6)
		ON CONFLICT(id) DO UPDATE SET cluster_id=excluded.cluster_id, rehearsal_id=excluded.rehearsal_id, state=excluded.state, document=excluded.document`,
		t.ID, t.ClusterID, t.RehearsalID, t.State, t.CreatedAt, b)
	return err
}

func (r *storeRepository) getRehearsalTask(clusterID, taskID string) (rehearsalExecTask, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var b []byte
	var err error
	if clusterID != "" {
		err = r.db.QueryRowContext(ctx, "SELECT document FROM middleware_store_rehearsal_tasks WHERE id=$1 AND cluster_id=$2", taskID, clusterID).Scan(&b)
	} else {
		err = r.db.QueryRowContext(ctx, "SELECT document FROM middleware_store_rehearsal_tasks WHERE id=$1", taskID).Scan(&b)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return rehearsalExecTask{}, false, nil
	}
	if err != nil {
		return rehearsalExecTask{}, false, err
	}
	var t rehearsalExecTask
	if json.Unmarshal(b, &t) != nil || t.ID == "" {
		return rehearsalExecTask{}, false, nil
	}
	return t, true, nil
}

func (r *storeRepository) listRehearsalTasks(clusterID, rehearsalID string, limit int) ([]rehearsalExecTask, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var rows *sql.Rows
	var err error
	if rehearsalID != "" {
		if limit > 0 {
			rows, err = r.db.QueryContext(ctx, "SELECT document FROM middleware_store_rehearsal_tasks WHERE cluster_id=$1 AND rehearsal_id=$2 ORDER BY created_at DESC LIMIT $3", clusterID, rehearsalID, limit)
		} else {
			rows, err = r.db.QueryContext(ctx, "SELECT document FROM middleware_store_rehearsal_tasks WHERE cluster_id=$1 AND rehearsal_id=$2 ORDER BY created_at DESC", clusterID, rehearsalID)
		}
	} else {
		if limit > 0 {
			rows, err = r.db.QueryContext(ctx, "SELECT document FROM middleware_store_rehearsal_tasks WHERE cluster_id=$1 ORDER BY created_at DESC LIMIT $2", clusterID, limit)
		} else {
			rows, err = r.db.QueryContext(ctx, "SELECT document FROM middleware_store_rehearsal_tasks WHERE cluster_id=$1 ORDER BY created_at DESC", clusterID)
		}
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []rehearsalExecTask{}
	for rows.Next() {
		var b []byte
		var t rehearsalExecTask
		if rows.Scan(&b) == nil && json.Unmarshal(b, &t) == nil && t.ID != "" {
			out = append(out, t)
		}
	}
	return out, rows.Err()
}

func (r *storeRepository) listActiveRehearsalTasks() ([]rehearsalExecTask, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT document FROM middleware_store_rehearsal_tasks WHERE state IN ('queued','leased','running') ORDER BY created_at ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []rehearsalExecTask{}
	for rows.Next() {
		var b []byte
		var t rehearsalExecTask
		if rows.Scan(&b) == nil && json.Unmarshal(b, &t) == nil && t.ID != "" {
			out = append(out, t)
		}
	}
	return out, rows.Err()
}

// ---- Change Rehearsals & Cluster Docs ----

func (r *storeRepository) saveRehearsal(rh changeRehearsal) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	b, err := json.Marshal(rh)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `
		INSERT INTO middleware_store_rehearsals(id, cluster_id, stage, applied, updated_at, document)
		VALUES($1, $2, $3, $4, $5, $6)
		ON CONFLICT(id) DO UPDATE SET cluster_id=excluded.cluster_id, stage=excluded.stage, applied=excluded.applied, updated_at=excluded.updated_at, document=excluded.document`,
		rh.ID, rh.ClusterID, rh.Stage, rh.Applied, rh.UpdatedAt, b)
	return err
}

func (r *storeRepository) getRehearsal(clusterID, rid string) (changeRehearsal, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var b []byte
	err := r.db.QueryRowContext(ctx, "SELECT document FROM middleware_store_rehearsals WHERE id=$1 AND cluster_id=$2", rid, clusterID).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return changeRehearsal{}, false, nil
	}
	if err != nil {
		return changeRehearsal{}, false, err
	}
	var rh changeRehearsal
	if json.Unmarshal(b, &rh) != nil || rh.ID == "" {
		return changeRehearsal{}, false, nil
	}
	return rh, true, nil
}

func (r *storeRepository) deleteRehearsal(clusterID, rid string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx, "DELETE FROM middleware_store_rehearsals WHERE id=$1 AND cluster_id=$2", rid, clusterID)
	return err
}

func (r *storeRepository) listClusterRehearsals(clusterID string) ([]changeRehearsal, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT document FROM middleware_store_rehearsals WHERE cluster_id=$1 ORDER BY updated_at DESC", clusterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []changeRehearsal{}
	for rows.Next() {
		var b []byte
		var rh changeRehearsal
		if rows.Scan(&b) == nil && json.Unmarshal(b, &rh) == nil && rh.ID != "" {
			out = append(out, rh)
		}
	}
	return out, rows.Err()
}

func (r *storeRepository) listRehearsalClusterIDs() ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT DISTINCT cluster_id FROM middleware_store_rehearsals")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var cid string
		if rows.Scan(&cid) == nil && cid != "" {
			out = append(out, cid)
		}
	}
	return out, rows.Err()
}

func (r *storeRepository) getClusterDoc(clusterID, docKey string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var b []byte
	err := r.db.QueryRowContext(ctx, "SELECT document FROM middleware_store_cluster_docs WHERE cluster_id=$1 AND doc_key=$2", clusterID, docKey).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

func (r *storeRepository) saveClusterDoc(clusterID, docKey string, doc []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx,
		"INSERT INTO middleware_store_cluster_docs(cluster_id, doc_key, document, updated_at) VALUES($1, $2, $3, now()) ON CONFLICT(cluster_id, doc_key) DO UPDATE SET document=excluded.document, updated_at=now()",
		clusterID, docKey, doc)
	return err
}

func (r *storeRepository) deleteClusterDoc(clusterID, docKey string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx, "DELETE FROM middleware_store_cluster_docs WHERE cluster_id=$1 AND doc_key=$2", clusterID, docKey)
	return err
}

// ---- Security Advisories, Scans & VEX Triage ----

func (r *storeRepository) getSecScanSlot(slot string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var b []byte
	err := r.db.QueryRowContext(ctx, "SELECT document FROM middleware_store_sec_scans WHERE slot=$1", slot).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

func (r *storeRepository) saveSecScanSlot(slot string, doc []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx,
		"INSERT INTO middleware_store_sec_scans(slot, document, updated_at) VALUES($1, $2, now()) ON CONFLICT(slot) DO UPDATE SET document=excluded.document, updated_at=now()",
		slot, doc)
	return err
}

func (r *storeRepository) loadSecTriageMap() (map[string]secTriageRecord, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT triage_key, document FROM middleware_store_sec_triage")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]secTriageRecord{}
	for rows.Next() {
		var k string
		var b []byte
		var rec secTriageRecord
		if rows.Scan(&k, &b) == nil && json.Unmarshal(b, &rec) == nil && k != "" {
			out[k] = rec
		}
	}
	return out, rows.Err()
}

func (r *storeRepository) replaceSecTriageMap(m map[string]secTriageRecord) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM middleware_store_sec_triage"); err != nil {
		return err
	}
	for k, rec := range m {
		if k == "" {
			continue
		}
		b, _ := json.Marshal(rec)
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO middleware_store_sec_triage(triage_key, vuln_id, updated_at, document) VALUES($1, $2, $3, $4)",
			k, rec.VulnID, rec.UpdatedAt, b); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ---- Cluster State (Layer 2 Overrides + Layer 3 Live Machine Snapshot) ----

func (r *storeRepository) getClusterStateRow(clusterID string) (overrides, liveSnap, driftRep, probePol []byte, dataSource, lastProbedAt string, ok bool, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = r.db.QueryRowContext(ctx, `
		SELECT baseline_overrides, live_snapshot, drift_report, probe_policy, data_source, last_probed_at
		FROM middleware_store_cluster_state WHERE cluster_id=$1`, clusterID).
		Scan(&overrides, &liveSnap, &driftRep, &probePol, &dataSource, &lastProbedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil, nil, "", "", false, nil
	}
	if err != nil {
		return nil, nil, nil, nil, "", "", false, err
	}
	return overrides, liveSnap, driftRep, probePol, dataSource, lastProbedAt, true, nil
}

func (r *storeRepository) saveClusterStateRow(clusterID string, overrides, liveSnap, driftRep, probePol []byte, dataSource, lastProbedAt string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if len(overrides) == 0 {
		overrides = []byte("{}")
	}
	if len(probePol) == 0 {
		probePol = []byte("{}")
	}
	var liveArg, driftArg any
	if len(liveSnap) > 0 && string(liveSnap) != "null" {
		liveArg = liveSnap
	}
	if len(driftRep) > 0 && string(driftRep) != "null" {
		driftArg = driftRep
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO middleware_store_cluster_state(cluster_id, baseline_overrides, live_snapshot, drift_report, probe_policy, data_source, last_probed_at, updated_at)
		VALUES($1, $2, $3, $4, $5, $6, $7, now())
		ON CONFLICT(cluster_id) DO UPDATE SET
			baseline_overrides = excluded.baseline_overrides,
			live_snapshot = excluded.live_snapshot,
			drift_report = excluded.drift_report,
			probe_policy = excluded.probe_policy,
			data_source = excluded.data_source,
			last_probed_at = excluded.last_probed_at,
			updated_at = now()`,
		clusterID, overrides, liveArg, driftArg, probePol, dataSource, lastProbedAt)
	return err
}

// ---- Scoped KV Records (AI Chats, Portal, KB, User Prefs, File Index, AI Usage) ----

func (r *storeRepository) getKV(scope, key string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var b []byte
	err := r.db.QueryRowContext(ctx, "SELECT document FROM middleware_store_kv_records WHERE scope=$1 AND item_key=$2", scope, key).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

func (r *storeRepository) putKV(scope, key, sortTS string, doc []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO middleware_store_kv_records(scope, item_key, sort_ts, document, updated_at)
		VALUES($1, $2, $3, $4, now())
		ON CONFLICT(scope, item_key) DO UPDATE SET sort_ts=excluded.sort_ts, document=excluded.document, updated_at=now()`,
		scope, key, sortTS, doc)
	return err
}

func (r *storeRepository) deleteKV(scope, key string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx, "DELETE FROM middleware_store_kv_records WHERE scope=$1 AND item_key=$2", scope, key)
	return err
}

func (r *storeRepository) listKV(scope string, limit int) (map[string][]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var rows *sql.Rows
	var err error
	if limit > 0 {
		rows, err = r.db.QueryContext(ctx, "SELECT item_key, document FROM middleware_store_kv_records WHERE scope=$1 ORDER BY sort_ts DESC LIMIT $2", scope, limit)
	} else {
		rows, err = r.db.QueryContext(ctx, "SELECT item_key, document FROM middleware_store_kv_records WHERE scope=$1 ORDER BY sort_ts DESC", scope)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]byte{}
	for rows.Next() {
		var k string
		var b []byte
		if rows.Scan(&k, &b) == nil && k != "" {
			out[k] = b
		}
	}
	return out, rows.Err()
}
