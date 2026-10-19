# Araceae Codex Runtime

基于固定 Codex 源码提交，通过功能补丁队列构建 app-server 运行时。补丁、构建脚本和源码锁由本仓库管理；`codex/` 是固定提交的上游 Git 子模块，`.worktrees/` 是应用补丁的独立工作树。

## 补丁范围

源码基线为 Codex `0.163.0`，提交和 Rust 工具链记录在 [runtime-source-lock.json](manifests/runtime-source-lock.json)。[.gitmodules](.gitmodules) 指向官方上游，`codex` 的 gitlink 与源码锁记录同一提交。[series](patches/codex/series) 决定应用顺序，[metadata.json](patches/codex/metadata.json) 记录补丁哈希、依赖和检查项。

| 补丁 | 职责 |
| --- | --- |
| `align-workspace-lock.patch` | 将 Cargo.lock 中 160 个本地包的版本与 workspace 的 `0.163.0` 对齐；外部依赖不变。未裁剪基线也应用此构建修复。 |
| `minimal-runtime-entrypoint.patch` | 新增 `araceae-codex-runtime` crate，组合原生 app-server 和 `codex-arg0`，不依赖 TUI、exec、cloud-tasks 或 daemon 的产品入口。 |
| `require-explicit-model-provider.patch` | 要求显式 provider 和 base URL，拒绝原生账号认证和缺失配置。 |
| `remove-cloud-config.patch` | 仅加载本地配置与策略，移除官方云配置 loader。 |
| `remove-remote-control.patch` | 移除远程控制 RPC、传输和后台任务；协议导出与实际注册表同步。 |
| `disable-native-skills.patch` | 禁用原生技能发现、安装、监视及注入，保留空列表和拒绝写入的控制协议。 |
| `remove-native-plugin-marketplace.patch` | 移除原生插件市场 RPC、启动同步和插件加载。 |
| `remove-official-apps.patch` | 移除官方 Apps RPC 和 hosted MCP 自动注册。 |
| `remove-cloud-history-notes.patch` | 移除云历史笔记扩展，关闭模型默认值对该功能的激活。 |
| `remove-cloud-git-attribution.patch` | 移除云 Git 归因扩展及其账号策略查询。 |
| `provider-scoped-model-catalog.patch` | 默认使用随包模型元数据，仅访问显式配置的 provider 模型目录。 |
| `provider-scoped-compaction.patch` | 默认通过所选模型生成摘要，远程压缩需显式声明能力。 |
| `remove-feedback-upload.patch` | 移除反馈 RPC 与上传模块，保留本地诊断。 |
| `remove-analytics-upload.patch` | 保留共享埋点接口，移除事件队列和发送任务。 |
| `remove-otel-exporters.patch` | 移除 OTLP/Statsig exporter、相关依赖和运行时重载任务。 |
| `remove-managed-account-flows.patch` | 移除原生登录、额度、账号查询和 workload identity；保留 provider 凭证刷新及独立 OAuth。 |
| `araceae-executable-names.patch` | 入口、code-mode host、Linux 沙箱 helper 别名和 Windows 沙箱 helper 改用 `araceae` 前缀；运行时按新名称查找和启动 helper，上游打包器新增 `araceae` variant。 |
| `araceae-package-layout.patch` | 包内资源目录、PATH 目录和布局清单改为 `araceae-resources/`、`araceae-path/`、`araceae-package.json`；运行时按新名称识别包布局、查找 bwrap 与 Windows helper。 |
| `araceae-home-directory.patch` | 未设置 `CODEX_HOME` 时默认数据目录改为 `~/.araceae`；Windows 提权沙箱 runner 的 cwd junction 随之移到 `%USERPROFILE%\.araceae\.sandbox\cwd`，`-c` 帮助与 macOS 沙箱报错中的默认配置路径同步。 |

运行时保留以下入口：

```text
araceae --version
araceae --help
araceae [-c key=value ...] app-server --listen stdio://
araceae app-server generate-json-schema --experimental --out DIR
araceae app-server generate-ts --experimental --out DIR
```

运行时及其拉起的 helper 进程名均以 `araceae` 开头：

| 平台 | 进程 | 来源 |
| --- | --- | --- |
| 全部 | `araceae[.exe]` | 包内入口 `bin/araceae[.exe]` |
| 全部 | `araceae-code-mode-host[.exe]` | 启用 code mode 时由入口启动的 `bin/araceae-code-mode-host[.exe]` |
| Linux | `araceae-linux-sandbox` | 指向入口的 arg0 别名，在 bwrap 内外执行沙箱阶段；`bwrap` 保留上游名称 |
| Windows | `araceae-command-runner[-<版本>].exe` | 提权沙箱的 runner：`araceae-resources/araceae-command-runner.exe` 复制到 `CODEX_HOME/.sandbox-bin/` 后启动，复制失败时直接启动包内文件 |
| Windows | `araceae-windows-sandbox-setup.exe` | `araceae-resources/araceae-windows-sandbox-setup.exe`，沙箱初始化（经 UAC）和刷新时启动 |

配置、会话、日志与状态库默认位于 `~/.araceae`（Windows 为 `%USERPROFILE%\.araceae`）。`CODEX_HOME` 及其他 `CODEX_*` 环境变量沿用上游名称，设置 `CODEX_HOME` 时以其为准。项目内的 `.codex/` 配置目录及其沙箱写保护保持上游名称，因此主目录本身作为项目目录时，`~/.codex` 按项目配置目录处理，受项目信任设置约束。

保留通用 MCP/OAuth、动态工具、子 Agent、Default/Plan、结构化询问、权限审批、沙箱、本地历史、后台终端、图片和搜索能力、普通摘要压缩与平台 helper。搜索和图片生成仍取决于所选 provider 的支持。未从目标依赖中消失的共享 crate 不等于仍能启用被删除的服务。

运行时不再读取原生账号作为模型回退。`model_provider`、provider 的 `base_url` 必须显式配置；缺失配置或要求原生 OpenAI 账号时返回配置错误。模型凭证支持 `env_key`、`auth.command` 和显式无需鉴权的 provider。`auth.command` 的标准输出为纯令牌，401 后仍能刷新；通用 MCP OAuth 和显式 gateway OAuth 独立保留。依赖 Codex 账号的企业 MCP `EmaAuth` 返回不可用错误。

例如本地无需鉴权的 Responses provider：

```toml
model = "local-model"
model_provider = "local"
[model_providers.local]
name = "Local Responses"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"
requires_openai_auth = false
```

需要密钥时在 provider 下设置 `env_key`，或配置 `auth.command`。全局 `OPENAI_API_KEY` / `CODEX_API_KEY` 和已有 `auth.json` 不构成隐式回退；显式 `env_key` 仍可指定这些变量。

`skills/list` 为每个 cwd 返回空 `skills` / `errors`；`skills/config/write` 和额外技能根写入返回明确错误。应用侧 `load_skill` 动态工具照常执行。原生插件、Apps、技能和遥测开关不能恢复被裁剪的能力。被移除的 RPC 不再出现在稳定版或实验版 JSON Schema / TypeScript 方法联合类型中，直接调用时返回 JSON-RPC 错误；共享 payload 类型可以继续保留。

repoverge 的下载、签名和 Electron 接入在其自身仓库完成。此仓库只构建与验证运行时，范围与依赖见[功能精简计划](docs/repoverge-codex-feature-pruning-plan.md)。

## 构建

需要 Git、Python 3.11+、rustup 和源码锁指定的 Rust 工具链。模型端到端测试需要 Node.js 22+、pnpm 11.13.0。以下命令用于 Linux/macOS；Windows 将 `python3` 替换为 `python`。

Linux GNU 构建需要 C/C++ 工具链、Clang、CMake、pkg-config，以及 libcap、OpenSSL 开发文件；未裁剪 CLI 还需要 ALSA 开发文件。Windows 使用 MSVC 工具链，macOS 使用 Xcode 命令行工具。V8 预编译资源与 ripgrep 由固定上游提交的打包模块下载并校验。

克隆仓库时可使用 `git clone --recurse-submodules`。普通克隆也可直接运行以下命令，`prepare` 会初始化缺失的 Codex 子模块；单独初始化使用 `git submodule update --init --depth 1 -- codex`。

```bash
python3 scripts/patches.py check
python3 scripts/patches.py prepare
python3 scripts/patches.py apply
python3 scripts/build_runtime.py --profile release --jobs 8
```

`check` 与 `prepare` 校验 Git 索引中 `codex` 的 gitlink、`.gitmodules` URL 和源码锁一致。`prepare` 从锁定提交创建 detached worktree；已有的 `codex/` 分支和工作区不会被切换，补丁也不会写入子模块工作区。工作树已存在时命令报错，使用 `--name` 创建其他工作树。

构建前校验完整补丁队列、工作树状态、workspace 版本及工具链。所有 Cargo 构建使用 `--locked`。入口以明确的 package/bin 构建，打包时通过上游 `--entrypoint-bin` 接口装配。源码锁的 `runtime` 与 `baseline` 两节各自声明打包 variant、可执行文件名和布局名称：运行时装配为 `bin/araceae`、`araceae-*` helper 及 `araceae-resources/`、`araceae-path/`、`araceae-package.json`，未裁剪基线保留上游 `codex` 名称；构建与制品检查都按包所属的一节取名。helper 也从同一工作树构建；Linux 的 bwrap 在入口编译前计算并嵌入校验值。

`--target` 指定上游打包器支持的 Rust target；默认使用宿主 target。跨编译还需要对应的 linker、SDK 和系统库。`--profile dev-small --entrypoint-only` 可生成用于快速验证的入口制品，该制品缺少 helper，不用于安装包分发。

## 验收

```bash
pnpm install --frozen-lockfile
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 scripts/check_patch_prefixes.py --name prefix-validation

export ARACEAE_PACKAGE_DIR=/absolute/path/to/dist/package
python3 scripts/verify_runtime.py --package "$ARACEAE_PACKAGE_DIR" --report artifacts/runtime-verification.json
export ARACEAE_CODEX_BIN="$ARACEAE_PACKAGE_DIR/bin/araceae"
pnpm test
```

Windows 的二进制路径使用 `bin/araceae.exe`，并通过 `$env:ARACEAE_CODEX_BIN` 设置环境变量。测试要求显式的绝对路径，缺失时失败，不回退到系统 Codex。

补丁工作流测试运行真实 Git 命令，覆盖子模块首次初始化、源码锁一致性、顺序重放、失败停止、单补丁刷新、依赖与哈希校验、工作区保护和重复构建源码树。制品检查验证文件哈希、包布局与可执行文件名、命令、稳定版/实验版 JSON Schema 与 TypeScript、整包依赖和内部 apply_patch 分发，并拒绝仍内嵌已改名 helper、布局旧名称或 `~/.codex` 默认路径文案的入口二进制。`check_patch_prefixes.py` 从干净基线依次构建每个含运行入口的前缀，并执行累计验收；报告写入 `artifacts/patch-prefixes.json`。前缀制品只用于验收，分发构建要求完整队列。

`pnpm test` 执行基础模型流程；`verify_runtime.py --archive ARCHIVE --e2e` 根据制品补丁清单追加裁剪验收。AIMock 用例覆盖流式输出、跨进程恢复、应用动态工具、原生技能隔离、通用 MCP、Plan 询问、子 Agent provider 继承、后台终端、普通摘要压缩、显式模型目录、401 凭证刷新、无需鉴权 provider、审批拒绝和中断。代理与本地接收端记录尝试恢复旧功能开关后的外联，同时确认 token 用量通知保留。完整安装包还通过 code mode 实际拉起 helper，确认入口与 code-mode host 的进程名以 `araceae` 开头；Linux 上确认只有 `araceae-linux-sandbox` 这个 argv0 进入沙箱 helper；shell 子进程的 PATH 含包内 `araceae-path`，说明运行时按新名称识别了包布局。Linux 与 macOS 上另以未设置 `CODEX_HOME` 的临时 `HOME` 启动运行时，确认配置从 `~/.araceae/config.toml` 读取、会话写入 `~/.araceae/sessions`，且不创建 `~/.codex`；Windows 的用户目录经系统 known-folder API 解析，无法在测试中重定向，不做此项。通用 MCP OAuth 使用本地授权服务器验证发现、PKCE、回调和令牌交换；这些用例不替代真实厂商模型、第三方授权服务或 Electron 整体验收。

未裁剪基线可单独构建和运行相同验收：

```bash
python3 scripts/patches.py prepare --name baseline --baseline
python3 scripts/patches.py apply --worktree .worktrees/baseline
python3 scripts/build_runtime.py --worktree .worktrees/baseline --profile dev-small --entrypoint-only --output artifacts/baseline
```

“未裁剪”表示只有源码锁声明的构建修复，不包含功能裁剪。基线与产品制品分别记录各自的补丁摘要。

## 制品

`dist/` 中的目录与归档名称以入口名开头（运行时为 `araceae`，基线为 `codex`），并包含上游版本、基线/运行时类别、补丁摘要、target 和构建 profile。Windows 输出 ZIP，Linux/macOS 输出 tar.gz，旁附归档 SHA-256 文件。

运行时包沿用上游布局结构，目录与清单使用 `araceae` 前缀：

```text
bin/araceae[.exe]
bin/araceae-code-mode-host[.exe]
araceae-path/rg[.exe]
araceae-resources/                 # bwrap，或 araceae-command-runner.exe 与 araceae-windows-sandbox-setup.exe
araceae-package.json
araceae-build.json
dependencies.txt
```

`araceae-build.json` 记录上游提交、实际补丁顺序与哈希、源码树、Cargo.lock 哈希、Rust 工具链、目标平台、构建 profile，以及包内文件哈希。应用下载归档后应核验归档哈希及构建身份，不能只依靠 `araceae --version` 区分同一上游版本的不同补丁组合。

`python3 scripts/verify_runtime.py --archive ARCHIVE --e2e` 会读取同名 `.sha256` 文件，在独立目录解压后校验文件并运行协议与 AIMock 验收。Linux 安装 `strace` 后可追加 `--network-trace artifacts/runtime-connect.log`，记录测试进程及其子进程的 `connect` 系统调用，并拒绝非回环 IP 连接。模型、MCP 与 OAuth 测试服务均位于回环地址；这个检查观察测试执行期间的连接，不是运行时的联网限制。只核验其他平台的归档时使用 `--integrity-only`，该模式不表示二进制运行验收通过。

[CI workflow](.github/workflows/runtime.yml) 仅在向 GitHub 推送 `v*` 标签时触发构建，使用 `release` profile。三个构建任务均生成 amd64（x86_64）安装包：

| 平台 | Runner | Rust target | Artifact | 归档格式 |
| --- | --- | --- | --- | --- |
| Windows | `windows-2025` | `x86_64-pc-windows-msvc` | `araceae-windows-amd64-release` | ZIP |
| macOS | `macos-15-intel` | `x86_64-apple-darwin` | `araceae-macos-amd64-release` | tar.gz |
| Linux | `ubuntu-24.04` | `x86_64-unknown-linux-gnu` | `araceae-linux-amd64-release` | tar.gz |

创建并推送版本标签以触发构建，例如：

```bash
git tag v0.1.0
git push origin v0.1.0
```

每个平台在上传前执行补丁工作流测试、归档与协议校验、AIMock 模型端到端验收；Linux 还检查测试期间的网络连接。Rust 依赖缓存按平台、工具链和构建 profile 隔离。基线和逐补丁前缀验收使用“验收”章节中的本地命令运行。

运行成功后，在该次 Actions 运行页面的 **Artifacts** 下载对应平台制品；其中包含安装包归档及同名 `.sha256` 校验文件，保留 30 天。解压安装包后使用 `bin/araceae`（Windows 为 `bin/araceae.exe`），保留同包的 helper 和资源目录。验收报告单独存放在 `verification-<平台>-amd64-<profile>`。Linux 包面向 Ubuntu 24.04 及兼容的 glibc 系统。

该流程不发布 GitHub Release，也不执行 macOS notarization 或 Windows 代码签名。签名会改变文件哈希，签名后的分发流程需要重新生成文件清单和归档哈希。

源码树重放以哈希比较；二进制构建仍受系统编译器、SDK 和链接器影响，不承诺跨宿主逐字节一致。性能与体积比较需要相同 target、profile、符号处理方式，并分别比较入口、helper 和整个安装包。

## 维护补丁

一个补丁处理一个功能，包含该功能需要的源码、配置、协议、依赖清单和验证修改。每个补丁在其前置补丁之上保持可构建。补丁名称稳定，顺序和依赖由清单管理；未改动的补丁不重新导出。

修改已有补丁时，准备工作树并停在对应前缀：

```bash
python3 scripts/patches.py prepare --name edit-entrypoint
python3 scripts/patches.py apply --worktree .worktrees/edit-entrypoint --through minimal-runtime-entrypoint.patch
# 编辑工作树中的目标文件，随后将变更纳入当前补丁提交。
git -C .worktrees/edit-entrypoint add codex-rs/runtime-cli
git -C .worktrees/edit-entrypoint commit --amend --no-edit
python3 scripts/patches.py refresh --worktree .worktrees/edit-entrypoint --patch minimal-runtime-entrypoint.patch
python3 scripts/patches.py apply --worktree .worktrees/edit-entrypoint
```

`refresh` 只接受当前队列末端的一个提交，更新该补丁和对应哈希。它不自动重写其他补丁。新增功能补丁同样从目标前缀创建单一提交，用 `git format-patch -1 --stdout --full-index --binary --zero-commit --no-numbered --no-signature` 导出，再登记到 `series` 和 `metadata.json`。

升级上游时，在 `codex/` 获取并切换到目标提交，同步修改源码锁的提交、tag、版本与工具链。运行 `git add codex manifests/runtime-source-lock.json` 暂存对应 gitlink，再执行 `patches.py check` 并准备独立工作树；更换上游 URL 时还需同步 `.gitmodules`。使用固定提交，不使用 `git submodule update --remote` 跟随上游分支。

严格重放遇到冲突后立即停止，失败补丁与已应用提交保存在该 worktree 的 Git 私有状态中；`patches.py status` 可查看。修复失败补丁的流程为：

```bash
git -C .worktrees/upgrade status
# 修复当前补丁涉及的文件并 git add。
git -C .worktrees/upgrade am --continue
python3 scripts/patches.py refresh --worktree .worktrees/upgrade --patch PATCH_NAME.patch
python3 scripts/patches.py apply --worktree .worktrees/upgrade
```

维护过程中可以人工使用三方合并辅助判断；日常构建不自动采用三方合并，也不跳过失败补丁。若上游已实现某项补丁目的，核对功能后从队列中移除该补丁并调整依赖。失败后的继续应用和最终的干净重放都必须验证，公共文件的上下文变化仍可能影响后续补丁。

刷新完成后，至少在另一个工作树运行整套队列、构建和相关验收。弃用工作树通过 `git -C codex worktree remove PATH` 删除；该命令会拒绝未提交的修改，不使用强制删除清理修复现场。
