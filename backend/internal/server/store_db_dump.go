package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func resolveStoreDSN(configFile, explicitURL string) (string, error) {
	if strings.TrimSpace(explicitURL) != "" {
		return strings.TrimSpace(explicitURL), nil
	}
	if strings.TrimSpace(configFile) != "" {
		if b, err := os.ReadFile(configFile); err == nil {
			var raw struct {
				DatabaseURLEnv string `json:"database_url_env"`
			}
			_ = json.Unmarshal(b, &raw)
			envName := strings.TrimSpace(raw.DatabaseURLEnv)
			if envName == "" {
				envName = "MIDDLEWARE_STORE_DATABASE_URL"
			}
			if v := strings.TrimSpace(os.Getenv(envName)); v != "" {
				return v, nil
			}
		}
	}
	for _, k := range []string{"DELIVERY_STUDIO_DATABASE_URL", "MIDDLEWARE_STORE_DATABASE_URL", "MW_DB", "DATABASE_URL"} {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v, nil
		}
	}
	return "", errors.New("未找到 PostgreSQL 连接地址，请提供 --db-url 或配置数据库环境变量")
}

type exportTableSpec struct {
	name string
	pks  []string
}

var orderedExportTables = []exportTableSpec{
	{"middleware_store_users", []string{"username"}},
	{"middleware_store_migrations", []string{"mig_key"}},
	{"middleware_store_settings", []string{"namespace"}},
	{"middleware_store_catalog", []string{"app_id"}},
	{"middleware_store_jobs", []string{"id"}},
	{"middleware_store_job_specs", []string{"job_id"}},
	{"middleware_store_cluster_state", []string{"cluster_id"}},
	{"middleware_store_components", []string{"name", "slot"}},
	{"middleware_store_exec_state", []string{"slot"}},
	{"middleware_store_cluster_automation", []string{"cluster_id"}},
	{"middleware_store_rehearsal_tasks", []string{"id"}},
	{"middleware_store_rehearsals", []string{"id"}},
	{"middleware_store_cluster_docs", []string{"cluster_id", "doc_key"}},
	{"middleware_store_sec_scans", []string{"slot"}},
	{"middleware_store_sec_triage", []string{"triage_key"}},
	{"middleware_store_kv_records", []string{"scope", "item_key"}},
	{"middleware_store_ai_usage", []string{"id"}},
	{"middleware_store_audit", nil},
}

func sqlTextB64Expr(s string) string {
	return "convert_from(decode('" + base64.StdEncoding.EncodeToString([]byte(s)) + "','base64'),'UTF8')"
}

func formatSQLValue(val any, dataType string) string {
	if val == nil {
		return "NULL"
	}
	switch v := val.(type) {
	case bool:
		if v {
			return "TRUE"
		}
		return "FALSE"
	case int64:
		return strconv.FormatInt(v, 10)
	case int32:
		return strconv.FormatInt(int64(v), 10)
	case int:
		return strconv.Itoa(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case time.Time:
		return "'" + v.UTC().Format(time.RFC3339Nano) + "'::timestamptz"
	case []byte:
		expr := sqlTextB64Expr(string(v))
		if dataType == "jsonb" {
			return expr + "::jsonb"
		}
		if strings.Contains(dataType, "timestamp") {
			return expr + "::timestamptz"
		}
		return expr
	case string:
		expr := sqlTextB64Expr(v)
		if dataType == "jsonb" {
			return expr + "::jsonb"
		}
		if strings.Contains(dataType, "timestamp") {
			return expr + "::timestamptz"
		}
		return expr
	default:
		expr := sqlTextB64Expr(fmt.Sprint(v))
		if dataType == "jsonb" {
			return expr + "::jsonb"
		}
		return expr
	}
}

func storeDBExportCommand(args []string) error {
	f := flag.NewFlagSet("store db-export", flag.ContinueOnError)
	config := f.String("config", "", "服务配置文件路径")
	dbURL := f.String("db-url", "", "PostgreSQL 连接 URL")
	output := f.String("output", "delivery-studio-seed.sql", "导出的 SQL 文件路径")
	if err := f.Parse(args); err != nil {
		return err
	}
	dsn, err := resolveStoreDSN(*config, *dbURL)
	if err != nil {
		return err
	}
	repo, err := openStoreRepository(dsn)
	if err != nil {
		return err
	}
	defer repo.db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	var buf bytes.Buffer
	buf.WriteString("-- Delivery Studio Full PostgreSQL Offline Seed\n")
	buf.WriteString("-- Generated at: " + time.Now().UTC().Format(time.RFC3339) + "\n")
	buf.WriteString("SET client_encoding = 'UTF8';\n")
	buf.WriteString("BEGIN;\n\n")
	buf.WriteString(`CREATE TABLE IF NOT EXISTS middleware_store_users(username text PRIMARY KEY,role text NOT NULL,salt text NOT NULL,password_hash text NOT NULL,iterations integer NOT NULL,disabled boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS middleware_store_jobs(id text PRIMARY KEY,owner text NOT NULL REFERENCES middleware_store_users(username),document jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS middleware_store_jobs_owner ON middleware_store_jobs(owner);
CREATE TABLE IF NOT EXISTS middleware_store_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,occurred_at timestamptz NOT NULL DEFAULT now(),document jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS middleware_store_catalog(app_id text PRIMARY KEY,document jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS middleware_store_sessions(id text PRIMARY KEY,username text NOT NULL,status text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),document jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS middleware_store_sessions_user ON middleware_store_sessions(username,updated_at DESC);
ALTER TABLE middleware_store_users ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false;
`)
	buf.WriteString(fullStoreSchemaSQL)
	buf.WriteString("\n")

	totalRows := 0
	tableCounts := map[string]int{}

	for _, tbl := range orderedExportTables {
		colRows, err := repo.db.QueryContext(ctx, `
			SELECT column_name, data_type, is_identity
			FROM information_schema.columns
			WHERE table_schema='public' AND table_name=$1
			ORDER BY ordinal_position`, tbl.name)
		if err != nil {
			return err
		}
		var cols []string
		var types []string
		for colRows.Next() {
			var cname, dtype, isIdent string
			if err := colRows.Scan(&cname, &dtype, &isIdent); err != nil {
				colRows.Close()
				return err
			}
			if strings.EqualFold(isIdent, "YES") {
				continue
			}
			cols = append(cols, cname)
			types = append(types, dtype)
		}
		colRows.Close()
		if len(cols) == 0 {
			continue
		}

		orderClause := ""
		if len(tbl.pks) > 0 {
			orderClause = " ORDER BY " + strings.Join(tbl.pks, ", ")
		} else if tbl.name == "middleware_store_audit" {
			orderClause = " ORDER BY id ASC"
		}
		dataRows, err := repo.db.QueryContext(ctx, "SELECT "+strings.Join(cols, ", ")+" FROM "+tbl.name+orderClause)
		if err != nil {
			return err
		}

		buf.WriteString("-- Table: " + tbl.name + "\n")
		if tbl.name == "middleware_store_audit" {
			buf.WriteString("DO $audit_guard$ BEGIN IF NOT EXISTS (SELECT 1 FROM middleware_store_audit LIMIT 1) THEN\n")
		}

		pkSet := map[string]bool{}
		for _, pk := range tbl.pks {
			pkSet[pk] = true
		}
		var updateParts []string
		for _, c := range cols {
			if !pkSet[c] {
				updateParts = append(updateParts, c+"=EXCLUDED."+c)
			}
		}

		cnt := 0
		for dataRows.Next() {
			raw := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range raw {
				ptrs[i] = &raw[i]
			}
			if err := dataRows.Scan(ptrs...); err != nil {
				dataRows.Close()
				return err
			}
			vals := make([]string, len(cols))
			for i := range raw {
				vals[i] = formatSQLValue(raw[i], types[i])
			}
			stmt := "INSERT INTO " + tbl.name + "(" + strings.Join(cols, ",") + ") VALUES(" + strings.Join(vals, ",") + ")"
			if len(tbl.pks) > 0 {
				if len(updateParts) > 0 {
					stmt += " ON CONFLICT(" + strings.Join(tbl.pks, ",") + ") DO UPDATE SET " + strings.Join(updateParts, ",")
				} else {
					stmt += " ON CONFLICT(" + strings.Join(tbl.pks, ",") + ") DO NOTHING"
				}
			}
			stmt += ";\n"
			buf.WriteString(stmt)
			cnt++
			totalRows++
		}
		dataRows.Close()
		if tbl.name == "middleware_store_audit" {
			buf.WriteString("END IF; END $audit_guard$;\n")
		}
		buf.WriteString("\n")
		tableCounts[tbl.name] = cnt
	}

	buf.WriteString("COMMIT;\n")

	if err := os.MkdirAll(filepath.Dir(*output), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(*output, buf.Bytes(), 0o600); err != nil {
		return err
	}
	summary, _ := json.Marshal(map[string]any{
		"output":     *output,
		"bytes":      buf.Len(),
		"total_rows": totalRows,
		"tables":     tableCounts,
	})
	fmt.Println(string(summary))
	return nil
}

func storeDBImportCommand(args []string) error {
	f := flag.NewFlagSet("store db-import", flag.ContinueOnError)
	config := f.String("config", "", "服务配置文件路径")
	dbURL := f.String("db-url", "", "PostgreSQL 连接 URL")
	input := f.String("input", "", "待导入的 SQL 文件路径")
	onlyIfEmpty := f.Bool("only-if-empty", false, "仅当用户表为空时才导入种子数据")
	if err := f.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*input) == "" {
		return errors.New("必须指定 --input SQL 文件路径")
	}
	sqlBytes, err := os.ReadFile(*input)
	if err != nil {
		return err
	}
	dsn, err := resolveStoreDSN(*config, *dbURL)
	if err != nil {
		return err
	}
	repo, err := openStoreRepository(dsn)
	if err != nil {
		return err
	}
	defer repo.db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
	defer cancel()

	if *onlyIfEmpty {
		var userCount int
		if err := repo.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM middleware_store_users").Scan(&userCount); err == nil && userCount > 0 {
			fmt.Printf("数据库已有 %d 个账户，跳过初始种子导入。\n", userCount)
			return nil
		}
	}

	if _, err := repo.db.ExecContext(ctx, string(sqlBytes)); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("数据库导入失败: %w", err)
	}
	var userCount, jobCount int
	_ = repo.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM middleware_store_users").Scan(&userCount)
	_ = repo.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM middleware_store_jobs").Scan(&jobCount)
	fmt.Printf("数据库导入完成：共 %d 个账户、%d 条交付/集群记录。\n", userCount, jobCount)
	return nil
}
