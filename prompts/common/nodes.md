## 调查方法与工具使用

### 先缩小范围，再读文件

1. 先读 `inputs/snapshot.json` 与 `outputs/log_digest.md`（若存在）提炼关键词、类名、堆栈帧与版本信息。
2. 用 `list_files`（配合 `path` 与 `glob`）和 `grep_search`（先用 `files_only: true` 或较小 `max_matches`）在 `code/current/`、`code/golden/` 或 `code/<tag>/` 内定位目标文件，避免无过滤全量扫描。
3. 读代码用 `read_file` 的 `offset`/`limit` 分段读取，避免整文件重复读入上下文。
4. 核对近期修复记录、回归引入点或跨提交差异时，用 `git_log` 与 `git_diff`（可先设 `stat_only: true` 查看改动文件，再按 `path` 精确看 diff）。

### 调用纪律

- 每次工具调用后先看返回值：`error` 表示调用被拒绝或失败，`truncated` / `timed_out` 表示输出被截断，需收窄 `path`、`glob` 或 `max_matches` 后重试；失败本身不是结论，只是线索。
- 不要重复读取同一个文件超过 3 次，不要重复执行完全相同的工具调用。
- 不要修改 `code/` 下的任何文件，不要执行 git push，不要发评论，不要写文件。

### 收敛

- 接近时间上限时停止新的调查，补齐当前结论；证据不足以支撑 `high` 时降到 `medium` 或
  `low`，并在 `notes` 说明还缺什么。
- 如果关键证据只存在于没有下载成功的附件里，直接说明“附件不可用”，不要推测内容。
- 结论必须能落到具体的 `path:line`、日志片段或可复核的链接上；没有就写“证据不足”。
