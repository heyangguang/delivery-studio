package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Metadata uses PostgreSQL in shared deployments. File persistence is restricted
// to loopback HTTP previews, so a production service cannot silently lose data.
type storeRepository struct{ db *sql.DB }

func openStoreRepository(dsn string) (*storeRepository, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(3)
	db.SetConnMaxLifetime(30 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		return nil, errors.New("无法连接平台PostgreSQL，请检查数据库环境变量、网络和TLS配置")
	}
	const schema = `CREATE TABLE IF NOT EXISTS middleware_store_users(username text PRIMARY KEY,role text NOT NULL,salt text NOT NULL,password_hash text NOT NULL,iterations integer NOT NULL);
CREATE TABLE IF NOT EXISTS middleware_store_jobs(id text PRIMARY KEY,owner text NOT NULL REFERENCES middleware_store_users(username),document jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS middleware_store_jobs_owner ON middleware_store_jobs(owner);
CREATE TABLE IF NOT EXISTS middleware_store_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,occurred_at timestamptz NOT NULL DEFAULT now(),document jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS middleware_store_catalog(app_id text PRIMARY KEY,document jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS middleware_store_sessions(id text PRIMARY KEY,username text NOT NULL,status text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),document jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS middleware_store_sessions_user ON middleware_store_sessions(username,updated_at DESC);
ALTER TABLE middleware_store_users ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false;`
	if _, err = db.ExecContext(ctx, schema); err != nil {
		db.Close()
		return nil, errors.New("平台数据库表初始化失败，请检查账户权限和数据库版本")
	}
	return &storeRepository{db}, nil
}
func (r *storeRepository) users() (map[string]storeUser, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT username,role,salt,password_hash,iterations,disabled FROM middleware_store_users")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]storeUser{}
	for rows.Next() {
		var u storeUser
		if err = rows.Scan(&u.Username, &u.Role, &u.Salt, &u.PasswordHash, &u.Iterations, &u.Disabled); err != nil {
			return nil, err
		}
		result[u.Username] = u
	}
	return result, rows.Err()
}
func (r *storeRepository) addUser(u storeUser) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx, "INSERT INTO middleware_store_users(username,role,salt,password_hash,iterations) VALUES($1,$2,$3,$4,$5)", u.Username, u.Role, u.Salt, u.PasswordHash, u.Iterations)
	return err
}
func (r *storeRepository) deleteUser(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx, "DELETE FROM middleware_store_users WHERE username=$1", name)
	return err
}
func (r *storeRepository) updateUser(u storeUser) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx, "UPDATE middleware_store_users SET role=$2,salt=$3,password_hash=$4,iterations=$5,disabled=$6 WHERE username=$1", u.Username, u.Role, u.Salt, u.PasswordHash, u.Iterations, u.Disabled)
	return err
}
func (r *storeRepository) saveJob(j storeJob) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b, _ := json.Marshal(j)
	_, err := r.db.ExecContext(ctx, "INSERT INTO middleware_store_jobs(id,owner,document) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET document=excluded.document,owner=excluded.owner", j.ID, j.Owner, b)
	return err
}
func (r *storeRepository) jobs() (map[string]storeJob, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT document FROM middleware_store_jobs")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]storeJob{}
	for rows.Next() {
		var b []byte
		var j storeJob
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(b, &j); err != nil {
			return nil, err
		}
		result[j.ID] = j
	}
	return result, rows.Err()
}
func (r *storeRepository) deleteJob(id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.db.ExecContext(ctx, "DELETE FROM middleware_store_jobs WHERE id=$1", id)
	return err
}
func (r *storeRepository) audit(v any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	b, _ := json.Marshal(v)
	_, err := r.db.ExecContext(ctx, "INSERT INTO middleware_store_audit(document) VALUES($1)", b)
	return err
}
func (r *storeRepository) catalog(id string, doc any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b, _ := json.Marshal(doc)
	_, err := r.db.ExecContext(ctx, "INSERT INTO middleware_store_catalog(app_id,document) VALUES($1,$2) ON CONFLICT(app_id) DO UPDATE SET document=excluded.document", id, b)
	return err
}
func (r *storeRepository) saveSession(sess storeSession, status string) error {
	return r.saveSessionTimeout(sess, status, 5*time.Second)
}
func (r *storeRepository) saveSessionTimeout(sess storeSession, status string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	b, _ := json.Marshal(sess)
	_, err := r.db.ExecContext(ctx, "INSERT INTO middleware_store_sessions(id,username,status,updated_at,document) VALUES($1,$2,$3,now(),$4) ON CONFLICT(id) DO UPDATE SET username=excluded.username,status=excluded.status,updated_at=excluded.updated_at,document=excluded.document", sess.ID, sess.User, status, b)
	return err
}
func (r *storeRepository) sessionsActive() (map[string]storeSession, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT document FROM middleware_store_sessions WHERE status='active'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]storeSession{}
	for rows.Next() {
		var b []byte
		var s storeSession
		if err = rows.Scan(&b); err == nil && json.Unmarshal(b, &s) == nil && s.ID != "" {
			out[s.ID] = s
		}
	}
	return out, rows.Err()
}
func (r *storeRepository) sessionsClosed(from, to time.Time) ([]storeSession, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT document FROM middleware_store_sessions WHERE status='closed' AND updated_at >= $1 AND updated_at < $2 ORDER BY updated_at DESC LIMIT 5000", from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []storeSession
	for rows.Next() {
		var b []byte
		var s storeSession
		if err = rows.Scan(&b); err == nil && json.Unmarshal(b, &s) == nil && s.ID != "" {
			out = append(out, s)
		}
	}
	return out, rows.Err()
}

func (s *storeServer) persistJob(j storeJob) error {
	if s.repo != nil {
		return s.repo.saveJob(j)
	}
	return writeJSON(s.jobDir(j.ID)+"/job.json", j)
}
