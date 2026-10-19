import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
import test from "node:test"
import { fixture, shellToolCall } from "./runtime-test-support.mjs"

const checks = JSON.parse(process.env.ARACEAE_RUNTIME_CHECKS ?? "{}")
const binary = process.env.ARACEAE_CODEX_BIN
const options = { timeout: 120000 }
const executableNames = "araceae-executable-names" in checks
const layoutNames = "araceae-package-layout" in checks
const homeDirectory = "araceae-home-directory" in checks
const buildManifest = join(dirname(dirname(binary)), "araceae-build.json")
// Helpers and layout directories ship only in assembled packages; Cargo outputs and entrypoint artifacts contain the entrypoint alone.
const packaged = existsSync(buildManifest) && !JSON.parse(readFileSync(buildManifest, "utf8")).entrypoint_only

function listProcesses() {
  const output = process.platform === "win32"
    ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.Name }"], { encoding: "utf8" })
    : execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
  return output.split(/\r?\n/).map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), name: basename(command) }))
}

test("the packaged runtime and its code-mode host run under araceae process names", {
  ...options, skip: !(executableNames && packaged) && "requires an assembled package with araceae executable names",
}, async t => {
  const f = await fixture(t, [
    { match: { hasToolResult: true, toolResultContains: "CODE_MODE_HOST_OK" }, response: { content: "CODE_MODE_DONE" } },
    { match: { hasToolResult: false }, response: { toolCalls: [], customToolCalls: [{ type: "custom", name: "exec", input: 'text("CODE_MODE_HOST_OK")' }] } },
  ], { overrides: ["-c", "features.code_mode=true", "-c", "features.code_mode_host=true"] })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd })
  assert.equal(await server.turn(thread.id, "RUN_CODE_MODE"), "CODE_MODE_DONE")
  assert.ok(f.mock.getRequests()[0].body.customTools?.some(tool => tool.name === "exec"), "The packaged code-mode host must be available")
  const pid = server.process.pid
  const tree = listProcesses().filter(entry => entry.pid === pid || entry.ppid === pid)
  assert.match(tree.find(entry => entry.pid === pid)?.name ?? "", /^araceae/, JSON.stringify(tree))
  // Linux and macOS truncate process names, so only the stable prefix of araceae-code-mode-host is comparable.
  assert.ok(tree.some(entry => entry.ppid === pid && entry.name.startsWith("araceae-code")), JSON.stringify(tree))
  assert.deepEqual(tree.filter(entry => /^codex/i.test(entry.name)), [])
})

test("the Linux sandbox helper is dispatched only under its araceae name", {
  ...options, skip: !(executableNames && process.platform === "linux") && "requires a Linux runtime with araceae executable names",
}, t => {
  const codexHome = mkdtempSync(join(tmpdir(), "araceae-helper-name-"))
  t.after(() => rmSync(codexHome, { recursive: true, force: true }))
  const invoke = argv0 => spawnSync(binary, ["--help"], {
    argv0, encoding: "utf8", timeout: 15000, env: { ...process.env, CODEX_HOME: codexHome },
  })
  const helper = invoke("araceae-linux-sandbox")
  assert.equal(helper.status, 0, helper.stderr)
  assert.match(helper.stdout, /--sandbox-policy-cwd/)
  const retired = invoke("codex-linux-sandbox")
  assert.equal(retired.status, 0, retired.stderr)
  assert.doesNotMatch(retired.stdout, /--sandbox-policy-cwd/)
  assert.match(retired.stdout, /app-server/)
})

test("the packaged runtime puts its araceae-path tools on the PATH of child processes", {
  ...options, skip: !(layoutNames && packaged) && "requires an assembled package with the araceae layout",
}, async t => {
  const f = await fixture(t, [
    { match: { hasToolResult: true }, response: { content: "PATH_RECORDED" } },
    // Login shells may rebuild PATH from profile scripts; a non-login shell keeps the PATH the runtime prepared.
    { match: { hasToolResult: false }, response: request => ({
      toolCalls: [shellToolCall(request, "require('node:fs').writeFileSync('path.txt',process.env.PATH)", { login: false })],
    }) },
  ])
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert.equal(await server.turn(thread.id, "RECORD_CHILD_PATH"), "PATH_RECORDED")
  const entries = readFileSync(join(f.cwd, "path.txt"), "utf8").split(delimiter)
  assert.ok(entries.some(entry => basename(entry) === "araceae-path"), entries.join("\n"))
  assert.ok(!entries.some(entry => basename(entry) === "codex-path"), entries.join("\n"))
})

test("the runtime keeps its state under ~/.araceae when CODEX_HOME is unset", {
  ...options,
  // Windows resolves the profile directory through the shell known-folder API, which ignores HOME and USERPROFILE,
  // so a test cannot move the default home away from the real profile.
  skip: !(homeDirectory && process.platform !== "win32") && "requires a Linux or macOS runtime with the araceae home directory",
}, async t => {
  let userHome
  const f = await fixture(t, [
    { match: { userMessage: "DEFAULT_HOME_REQUEST" }, response: { content: "DEFAULT_HOME_ANSWER" } },
  ], { configure({ root, codexHome, environment }) {
    userHome = join(root, "user")
    mkdirSync(join(userHome, ".araceae"), { recursive: true })
    copyFileSync(join(codexHome, "config.toml"), join(userHome, ".araceae", "config.toml"))
    environment.HOME = userHome
    delete environment.CODEX_HOME
    delete environment.CODEX_SQLITE_HOME
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert.equal(await server.turn(thread.id, "DEFAULT_HOME_REQUEST"), "DEFAULT_HOME_ANSWER")
  await server.close()
  const sessions = readdirSync(join(userHome, ".araceae", "sessions"), { recursive: true }).map(String)
  assert.ok(sessions.some(entry => entry.endsWith(".jsonl") && entry.includes(thread.id)), sessions.join("\n"))
  assert.ok(!existsSync(join(userHome, ".codex")), readdirSync(userHome).join("\n"))
})
