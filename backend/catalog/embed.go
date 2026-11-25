// Package catalog embeds the built-in component manifests, roles and templates.
package catalog

import "embed"

// FS holds one directory per component: <name>/component.yaml and <name>/roles/.
//
// The all: prefix matters: without it embed leaves out every file whose name starts with "_" or ".", and task files
// that other tasks include are named that way (_wait_ready.yml, _patch.yml). They were missing from every delivery
// until a real run failed on them; TestEveryIncludedTaskFileIsEmbedded keeps it from happening again.
//
//go:embed all:etcd all:haproxy all:keepalived all:nginx all:external-lb all:postgresql all:patroni all:redis
var FS embed.FS

// Dir is the same content as an fs.FS rooted at the components.
func Dir() embed.FS { return FS }
