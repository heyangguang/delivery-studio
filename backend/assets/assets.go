package assets

import "embed"

//go:embed store_assets/*
var StoreAssets embed.FS

//go:embed ai_skills/*.md
var SkillFiles embed.FS

//go:embed runtime_assets
var RuntimeAssets embed.FS

//go:embed ai_prices.json
var BuiltinPricesJSON []byte

//go:embed go_messages_en.json
var GoMessagesEnJSON []byte

//go:embed 组件清单设计.md
var ComponentGuide string

//go:embed 平台公共流程契约.md
var SharedContract string
