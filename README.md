# 故障工单 AI / 人工复核服务

这是一个基于 **Node.js + SQLite** 的局域网复核服务。它把原来只能在本地打开的单 HTML 工具升级为多人可用的服务，同时保留离线版本：

```text
outputs/fault-ticket-review.html
```

## 运行要求

- Node.js **22.5+**（使用 Node 原生 `node:sqlite`，无需安装 SQLite 服务）；
- Windows、Linux、macOS 均可；
- 第一版使用 HTTP，适合可信内网，不建议直接暴露到公网。

## 本地启动

PowerShell：

```powershell
cd C:\path\to\fault-ticket-review-service
npm install
Copy-Item .env.example .env
npm start
```

浏览器访问：

```text
http://127.0.0.1:8080
```

服务默认监听：

```text
HOST=0.0.0.0
PORT=8080
```

因此局域网内其他电脑可访问：

```text
http://服务器IP:8080
```

Windows 防火墙需要允许 Node.js 或 TCP 8080 入站连接。例如管理员 PowerShell：

```powershell
New-NetFirewallRule -DisplayName "Fault Ticket Review 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

## 首次使用

1. 第一次打开页面会进入“初始化管理员”页面；
2. 创建首个管理员账号；
3. 普通用户自行注册姓名、登录名和密码；
4. 管理员在“管理后台 → 用户审核”中审核通过；
5. 管理员在“批次管理”中上传 CSV 并发布；
6. 审核通过的用户登录后即可查看已发布批次。

上传同一文件时，服务会使用 SHA-256 指纹复用已有批次，不会重复导入。

## 配置

可在 `.env` 中配置：

```ini
HOST=0.0.0.0
PORT=8080
DATA_DIR=./data
SESSION_DAYS=7
MAX_UPLOAD_MB=80
```

`DATA_DIR` 中会保存：

```text
data/review.sqlite       SQLite 数据库
 data/datasets/            原始 CSV 文件
```

生产部署时不要把 `DATA_DIR` 放在临时目录。建议使用 Windows 服务、任务计划、PM2 或 Linux systemd 保持服务常驻。

## 复核流程

- 点击“领取并开始复核”后，工单负责人绑定为当前登录用户；
- 其他普通用户可以查看，但不能编辑已经被领取的工单；
- 选择三种结论或编辑备注后，约 500ms 防抖自动保存到服务端；
- 浏览器 `localStorage` 同时保存本地草稿，服务端草稿优先恢复；
- 点击“提交复核”才会写入 `completed` 正式结果；
- 正式提交后默认只读；
- 管理员可以重开或重新分配工单；
- 所有领取、保存、提交、重开、改派操作会写入 `review_events`，便于追责。

顶部会分别显示：

- 当前登录用户；
- 当前工单状态；
- 当前复核负责人姓名和登录名；
- 最近保存时间；
- 正式提交时间；
- 原 CSV 中的“原始人工标注人”和标注时间。

## 导出与备份

管理员选择批次后可导出：

- UTF-8 BOM CSV，适合 Excel 和飞书表格；
- JSON，适合后续系统接入；
- SQLite 数据库备份。

导出在全部原始字段后追加：

```text
review_status
review_conclusion
review_note
reviewer_id
reviewer_name
reviewer_username
claimed_at
reviewed_at
```

原始 CSV 的 `human_reviewed_by`、`human_reviewed_at` 不会被覆盖。

旧版离线 HTML 导出的 JSON 可通过管理员 API 导入：

```text
POST /api/admin/import-legacy
Content-Type: application/json

{
  "dataset_id": "目标批次 ID",
  "rows": [
    {
      "data": { "main_ticket_number": "...", "similar_ticket_number": "..." },
      "review_conclusion": "uncertain",
      "review_note": "离线复核备注"
    }
  ]
}
```

## 主要 API

```text
GET  /api/setup/status
POST /api/setup/admin
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/session

GET  /api/admin/users
POST /api/admin/users/:id/approve
POST /api/admin/users/:id/disable
GET  /api/admin/backup
POST /api/admin/import-legacy

GET  /api/datasets
POST /api/datasets
POST /api/datasets/:id/publish
POST /api/datasets/:id/archive
GET  /api/datasets/:id/facets
GET  /api/datasets/:id/rows
GET  /api/datasets/:id/rows/:rowId
POST /api/datasets/:id/rows/:rowId/claim
PUT  /api/datasets/:id/rows/:rowId/draft
POST /api/datasets/:id/rows/:rowId/submit
POST /api/datasets/:id/rows/:rowId/reopen
POST /api/datasets/:id/rows/:rowId/assign
GET  /api/datasets/:id/export.csv
GET  /api/datasets/:id/export.json
```

## 备份建议

定期备份以下内容：

```text
data/review.sqlite
data/datasets/
```

最好在服务停止或数据库 checkpoint 后复制 SQLite 文件。页面中的“下载备份”会先执行 WAL checkpoint，再下载数据库。

## 安全说明

- 第一版是 HTTP 内网服务；
- 请通过防火墙限制访问范围；
- 生产环境建议使用 Nginx/IIS 反向代理增加 HTTPS；
- 不要把 `.env`、`data/review.sqlite` 或 `data/datasets` 提交到公开代码仓库；
- 定期停用离职或不再参与复核的账号。
