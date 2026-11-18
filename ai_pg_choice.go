package main

import "strings"

// Only human messages establish the architecture choice; model-written defaults
// and assistant questions listing both options are not consent.
func pgArchitectureChoice(messages []aiMsg) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role != "user" {
			continue
		}
		t := strings.ToLower(messages[i].Text)
		if strings.Contains(t, "还是") || strings.Contains(t, "区别") || strings.Contains(t, "是什么") || strings.Contains(t, "哪个好") {
			return ""
		}
		patroni := strings.Contains(t, "patroni")
		native := strings.Contains(t, "原生") || strings.Contains(t, "人工切换")
		if strings.Contains(t, "不要patroni") || strings.Contains(t, "不用patroni") || strings.Contains(t, "不要 patroni") || strings.Contains(t, "不用 patroni") {
			patroni = false
			native = true
		}
		if strings.Contains(t, "不要原生") || strings.Contains(t, "不用原生") {
			native = false
		}
		if patroni && !native {
			return "patroni"
		}
		if native && !patroni {
			return "replication"
		}
	}
	return ""
}

func pgArchitectureAsk() *aiAsk {
	return &aiAsk{Questions: []askQuestion{{Question: "PostgreSQL 主从部署请选择实现方案", Options: []askOption{
		{Label: "原生主从方案", Description: "PostgreSQL 原生流复制；主库读写、从库只读，故障后人工切换，不引入 Patroni 或 etcd。"},
		{Label: "Patroni 主从方案", Description: "Patroni 管理主从并自动故障切换；平台部署 etcd，需满足协调服务仲裁和健康副本条件。"},
	}}}}
}

func needsPGArchitectureAsk(app, text string, messages []aiMsg) bool {
	t := strings.ToLower(text)
	if !strings.Contains(t, "postgresql") && !strings.Contains(t, "pg") {
		for _, other := range []string{"redis", "nginx", "etcd", "mysql"} {
			if strings.Contains(t, other) {
				return false
			}
		}
	}
	if app != "postgresql" && !strings.Contains(t, "postgresql") && !strings.Contains(t, "pg") {
		return false
	}
	if pgArchitectureChoice(messages) != "" {
		return false
	}
	for _, word := range []string{"主从", "一主", "1主", "1 主", "高可用", "replica", "primary", "standby"} {
		if strings.Contains(t, word) {
			return true
		}
	}
	return false
}
