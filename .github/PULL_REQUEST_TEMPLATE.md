## 变更摘要 (Summary)

<!-- 简要说明本次 PR 解决的问题、核心改动及涉及模块 -->

- **变更类型**：`feat` / `fix` / `refactor` / `style` / `docs` / `chore`
- **合入目标**：`develop`（日常开发） / `main`（正式发版） / `release/1.x`（维护热修）

## 关键改动清单 (Changes)

-

## 验证与自检清单 (Checklist)

- [ ] 遵循 `docs/DIRECTORY_STANDARD.md` 锁定目录结构，未在根目录堆放散落文件
- [ ] 新增/修改 HTTP API 已在 `backend/internal/server/iam.go` 登记 RBAC 权限并补齐 `frontend/src/modules/iam/audit.tsx` 双语审计事件
- [ ] 后端定向单测 / 核心测试通过，且前端 `tsc --noEmit && vite build` 零报错
- [ ] 前端页面已核查亮色/暗色主题、中/英双语与窄屏无折行崩塌
- [ ] 未破坏或污染既有持久化数据格式（向下兼容）

## 截图 / 联调记录 (Optional)

<!-- 涉及 UI 变更时建议附上前后对比截图 -->
