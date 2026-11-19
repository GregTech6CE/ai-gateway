# 发布与打包

`master` 每次构建都会把 4 个应用打成自包含 `.tgz`，滚动覆盖 tag 为 `snapshot` 的
Release。下载地址固定：

```text
https://github.com/<owner>/<repo>/releases/download/snapshot/gt6-ci-<short>.tgz
https://github.com/<owner>/<repo>/releases/download/snapshot/gt6-qqbot-<short>.tgz
https://github.com/<owner>/<repo>/releases/download/snapshot/gt6-agent-svc-<short>.tgz
https://github.com/<owner>/<repo>/releases/download/snapshot/gt6-github-svc-<short>.tgz
https://github.com/<owner>/<repo>/releases/download/snapshot/SHASUMS256.txt
```

`<short>` 是 `git rev-parse --short=7 HEAD`。

## 产物结构

```text
package/package.json
package/dist/**          # 该应用构建后的全部文件
```

`dist` 由 tsdown 打成自包含 bundle，只引用 `node:*`；解包后可直接
`node package/dist/main.js`（`apps/ci` 为 `node package/dist/index.js <job>`），不需要
安装依赖。归档不包含 `src/`、`test/`、`node_modules/` 或文档。

`SHASUMS256.txt` 每行 `<sha256>  <filename>`，可这样校验：

```bash
sha256sum -c --ignore-missing SHASUMS256.txt
```

## 本地打包

```bash
node common/scripts/install-run-rush.js rebuild
node scripts/pack-release.mjs --out release
cd release && sha256sum -c --ignore-missing SHASUMS256.txt
```

`--hash <short>` 可覆盖提交号（默认取 HEAD），`--repo <dir>` 指定仓库根目录。
输出目录默认 `<repo>/release`，已在 `.gitignore` 中排除。

打包只读取 `dist/`：`dist` 缺失或为空会直接失败，不会静默产出空包。相同输入产出相同
字节（归档内 mtime 固定为 0），便于比对与缓存。

## 流水线

[`.github/workflows/release-snapshot.yml`](../.github/workflows/release-snapshot.yml)
在 push 到 `master` 时触发，`docs/**` 与 `**/*.md` 的纯文档变更被忽略；也可以手动
`workflow_dispatch`（同样只接受 `master`，避免分支构建改写 `snapshot` 资产）：

- `force_rebuild=false`（默认）：若 `snapshot` 已包含当前 commit 的 4 个资产，跳过发布；
  缺任何一个都会重新构建补齐。
- `force_rebuild=true`：忽略已有资产，重新构建并覆盖。

流水线顺序固定：

1. `install` → `rebuild`（不读 build cache）→ `typecheck` → `test`；
2. 打包 4 个 `.tgz` 与 `SHASUMS256.txt`；
3. 创建或复用 `snapshot` Release（`prerelease`）；
4. **先**上传 4 个 `.tgz`，全部成功后**再**覆盖 `SHASUMS256.txt`；
5. 回读校验：下载清单与 `gt6-ci-*.tgz`，`grep` 断言 4 行齐全，再跑
   `sha256sum -c --ignore-missing`。

`concurrency: release-publish` 串行化发布，避免两次运行交叉覆盖资产。

## 已知限制

- 只有一个滚动 tag：新 commit 会覆盖旧资产，历史版本需要从对应 commit 重新打包。
- 清单与资产之间没有事务：极端情况下（上传完 tgz、清单尚未覆盖时中断），清单可能仍
  指向上一版资产；重新运行流水线即可修复。
- 打包脚本不签名，来源可信度依赖 GitHub Release 与仓库权限。
