# 部署

四个容器的隔离编排：`qqbot`、`agent-svc`、`github-writer` 与唯一的出网出口
`egress-proxy`。目标是让「QQ 群文本 → 模型 → GitHub 写回」这条链路里，任一容器被
prompt injection 攻破时都拿不到完整凭据链。

## 1. 拓扑

```text
                    ┌────────────── egress-net（可出公网）──────────────┐
                    │                                                  │
                    │            egress-proxy（Tinyproxy :8888）         │
                    │                  ▲            │                  │
                    └──────────────────┼────────────┼──────────────────┘
                                       │            │ 只放行白名单域名
        ┌──────────────────────────────┴────────────┴──────────────────────────┐
        │                     internal-net（internal: true，无公网网关）        │
        │                                                                      │
        │   qqbot ──RPC──► agent-svc                                           │
        │     │                │                                               │
        │     └──RPC──► github-writer                                          │
        └──────────────────────────────────────────────────────────────────────┘
```

- `internal-net` 没有默认路由：业务容器即使知道外网 IP 也连不出去，只能走代理。
- `egress-proxy` 是唯一同时接入两张网的容器；它按
  `deploy/egress-allowlist-docker.txt` 做域名白名单，默认拒绝。
- 业务容器不发布宿主端口。

## 2. 凭据矩阵

| 容器 | 持有 | 明确不持有 |
|---|---|---|
| `qqbot` | QQ `appId`/`appSecret`、两个 RPC token | 模型 key、GitHub token/私钥 |
| `agent-svc` | `MODEL_KEY_*`、`RPC_TOKEN_AGENT` | GitHub 任何凭据 |
| `github-writer` | GitHub token 或 App 私钥、`RPC_TOKEN_GITHUB` | 模型 key、QQ 凭据 |
| `egress-proxy` | 无业务凭据 | 全部 |

镜像本身不含任何凭据；配置与 token 都由 compose 以只读方式挂载。

## 3. 前置条件

- Docker Engine + Compose v2（`docker compose version` 可用）。
- 构建镜像前先产出 `dist`：

  ```bash
  node common/scripts/install-run-rush.js install
  node common/scripts/install-run-rush.js rebuild
  ```

- `NODE_USE_ENV_PROXY=1` 需要 Node 22.21+；`node:22-slim` 跟随 22.x 最新版本。

## 4. 首次部署

```bash
cd deploy

# 1. 配置：示例里有占位符，复制后逐项替换
cp config/qqbot.example.json config/qqbot.json
cp config/agent-svc.example.json config/agent-svc.json
cp config/github-svc.example.json config/github-svc.json

# 2. RPC token：两个服务用文件，qqbot 的配置里内联同样的值
mkdir -p secrets
openssl rand -hex 32 > secrets/rpc-token-agent
openssl rand -hex 32 > secrets/rpc-token-github

# 3. GitHub 凭据（token 模式）
printf '%s' '<GITHUB_TOKEN>' > secrets/github-token

# 4. 模型 key 通过环境变量注入（名称来自 config/models.json 的 api_key_env）
export MODEL_KEY_MISTRAL='...'
export MODEL_KEY_CLINEPASS='...'

# 5. 校验与启动
docker compose config
docker compose build
docker compose up -d
```

`deploy/config/*.json` 与 `deploy/secrets/` 已被 `.gitignore` 排除，只有
`*.example.json` 会入库。

### GitHub App 模式

1. 把私钥放到 `deploy/secrets/github-app.pem`；
2. 在 `deploy/docker-compose.yml` 的 `github-writer.volumes` 取消注释私钥挂载；
3. 把 `github-svc.json` 的 `github` 段改成：

   ```json
   {
     "mode": "app",
     "app_id": "<APP_ID>",
     "private_key_file": "/run/secrets/github-app.pem",
     "installation_id": 123456
   }
   ```

`installation_id` 可省略，服务会按仓库查询 `/repos/{repo}/installation` 并缓存。

compose 仍然声明并挂载了 `github-token` secret：App 模式不再读取它，但为了让
`docker compose config` 通过，需要保留 `deploy/secrets/github-token`（内容任意），
或者同时删除 compose 里的 secret 声明与 `github-writer.secrets` 中的条目。

## 5. 配置要点

### `config/qqbot.json`

字段含义见 [qqbot.md](qqbot.md)。容器里只需要确认：

- `stateDir` 必须是 `/app/state`（命名卷挂载点）；
- `agentEndpoint` / `githubWriterEndpoint` 用容器名：`http://agent-svc:8080`、
  `http://github-writer:8080`；
- `agentToken` / `githubWriterToken` 与服务侧 `secrets/rpc-token-*` 内容一致。

### `config/agent-svc.json`

| 字段 | 说明 |
|---|---|
| `server` | 监听地址；容器内固定 `0.0.0.0:8080` |
| `auth.token` | 指向 `/run/secrets/rpc-token-agent` |
| `paths.config_dir` | 挂载到 `/app/repo-config` 的仓库白名单目录 |
| `paths.prompts_dir` | 挂载到 `/app/prompts` 的提示词目录 |
| `model` | 池名、角色、温度、输出上限与单次超时 |
| `tasks` | 并发、任务 TTL、容量与整体超时 |

启动时会检查 `models.json` 的池/角色是否存在，且至少有一个 endpoint 能取到 key；
否则进程直接退出，healthcheck 失败。

### `config/github-svc.json`

| 字段 | 说明 |
|---|---|
| `auth.token` | 指向 `/run/secrets/rpc-token-github` |
| `paths.config_dir` | 仓库白名单目录 |
| `github` | `token` 或 `app` 两种模式 |
| `issues` | 幂等缓存 TTL/容量与 GitHub 请求超时 |

## 6. 出网白名单

`deploy/egress-allowlist-docker.txt` 同时是 Tinyproxy 的 Filter 文件：每行一个
POSIX 扩展正则，`#` 开头为注释。当前放行：

- `api.sgroup.qq.com`、`bots.qq.com`（QQ HTTP API 与 WebSocket 网关）
- `api.github.com`（写回）
- `api.mistral.ai`、`api.cline.bot`（模型池）

新增模型 endpoint 或更换 GitHub 域名时，改这一份文件并重建代理镜像：

```bash
docker compose build egress-proxy
docker compose up -d egress-proxy
```

`deploy/egress-allowlist.txt` 是 CI 的 harden-runner 清单，两者用途不同，不要合并。

## 7. 运维

```bash
docker compose ps
docker compose logs -f --tail=100 agent-svc
docker compose exec agent-svc node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>console.log(r.status))"
```

- `agent-svc` / `github-writer` 健康检查走 `/healthz`，免鉴权。
- `egress-proxy` 的访问日志写在容器内 `/tmp/tinyproxy.log`（tmpfs），用
  `docker compose exec egress-proxy cat /tmp/tinyproxy.log` 查看；容器重启即清空。
  不用 `LogFile "/dev/stdout"`：tinyproxy 启动时会 stat 日志文件，管道会被判定为
  「changed before it could be opened」而放弃日志。
- `qqbot` 没有 HTTP 端口：进程存活即视为运行；`SIGTERM` 后先等后台建单任务收尾
  （最多 10 秒）再退出。
- `stateDir` 卷保存 QQ 的 session id 与 last seq；删除卷会让下一次连接重新 Identify。
- 任务表与幂等缓存都在内存：重启后正在进行的任务丢失，QQ 侧会提示用户重试；已创建的
  Issue 不受影响。

### 升级

```bash
node common/scripts/install-run-rush.js rebuild
docker compose build
docker compose up -d
```

镜像只拷贝 `dist` 与 `package.json`，升级不需要在容器里装依赖。

### 回滚

镜像 tag 固定为 `:local`。需要回滚时切回上一版代码重新 `rebuild` + `build`，
或自行给镜像打语义 tag 并改 compose 的 `image`。

## 8. 安全不变量

1. 业务容器只接入 `internal-net`；代理是唯一出口，默认拒绝。
2. 三个业务容器都 `read_only`、`cap_drop: ALL`、`no-new-privileges`、非 root。
3. 凭据按容器拆分：agent 没有 GitHub，writer 没有模型 key，qqbot 两者都没有。
4. RPC 认证统一 `Authorization: Bearer`，服务端用 `crypto.timingSafeEqual`
   （先 SHA-256 再比较）做常量时间比对。
5. 写回前强制 `scanText`；命中凭据直接 422，不调用 GitHub。
6. 仓库白名单来自 `config/repos.json`，未登记或未启用一律 403。

## 9. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `agent-svc` 反复重启 | 没有模型 key | 检查 `MODEL_KEY_*` 是否注入 |
| `qqbot` 启动即退出 | 配置缺失/非法 | 看容器日志里的 `配置错误（...）` |
| RPC 401 | 两侧 token 不一致 | 比对 `secrets/rpc-token-*` 与 `qqbot.json` |
| RPC 403 | 仓库不在白名单或 `enabled: false` | 改 `config/repos.json` |
| 写回 422 | 正文命中凭据扫描 | 检查 Issue 草稿里的 token/密钥 |
| 写回 502 | GitHub 认证失败或 5xx | 检查 token/App 权限与 `api.github.com` 白名单 |
| 出网 403 | 域名不在 Docker 白名单 | 改 `egress-allowlist-docker.txt` 并重建代理 |
| `NODE_USE_ENV_PROXY` 不生效 | Node < 22.21 | 升级基础镜像 |

## 10. 已知限制

- 单副本设计：任务表、幂等缓存与会话都在进程内，扩容前需要换成共享存储。
- 幂等缓存只在成功创建后写入：如果进程在「GitHub 已创建、缓存尚未写入」之间崩溃，
  同一 `requestId` 的重试会再建一条 Issue。要彻底消除需要在 GitHub 侧做去重标记。
- `qqbot.json` 里的两个 RPC token 是内联值（Step 3 的配置契约），因此该文件必须按
  密钥对待；两个服务侧的 token 已经是文件引用。
- compose 的 `MODEL_KEY_MISTRAL` / `MODEL_KEY_CLINEPASS` 是写死的变量名；换 endpoint
  或改 `api_key_env` 时要同步修改 compose。
- Tinyproxy 只做域名白名单，不检查路径或方法；它防的是「把凭据发到别处」，不是
  「向允许的域名发送了不该发的请求」。
