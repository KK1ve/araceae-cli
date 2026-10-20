import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer, request } from "node:http"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { createInterface } from "node:readline"
import { LLMock } from "@copilotkit/aimock"

const binary = process.env.ARACEAE_CODEX_BIN
assert.ok(binary && isAbsolute(binary), "ARACEAE_CODEX_BIN must name the built runtime by absolute path")

export class AppServer {
  constructor(environment, cwd, overrides = []) {
    this.pending = new Map()
    this.events = []
    this.waiters = new Set()
    this.nextId = 1
    this.stderr = ""
    this.approvals = []
    this.process = spawn(binary, ["-c", 'model_provider="aimock"', ...overrides, "app-server", "--listen", "stdio://"], {
      cwd, env: environment, stdio: ["pipe", "pipe", "pipe"],
    })
    this.process.stderr.on("data", data => { this.stderr = (this.stderr + data).slice(-16000) })
    this.closed = new Promise(resolve => this.process.once("exit", resolve))
    this.process.once("error", error => this.fail(error))
    this.process.once("exit", code => this.fail(new Error(`app-server exited ${code}: ${this.stderr}`)))
    this.lines = createInterface({ input: this.process.stdout })
    this.lines.on("line", line => {
      try { this.receive(JSON.parse(line)) }
      catch (error) { this.fail(error) }
    })
  }

  fail(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const waiter of this.waiters) waiter.reject(error)
    this.waiters.clear()
  }

  send(message) { this.process.stdin.write(`${JSON.stringify(message)}\n`) }

  receive(message) {
    if (message.method && message.id !== undefined) {
      if (this.reverseHandler) {
        this.reverseHandler(message)
      } else if (message.method === "item/tool/call") {
        try {
          assert.equal(message.params.tool, "echo_marker")
          assert.equal(message.params.arguments.value, "DYNAMIC_INPUT")
          this.send({ id: message.id, result: { success: true, contentItems: [{ type: "inputText", text: "DYNAMIC_RESULT" }] } })
        } catch (error) { this.fail(error) }
      } else if (message.method === "item/commandExecution/requestApproval" && this.declineCommands) {
        this.approvals.push(message.params)
        this.send({ id: message.id, result: { decision: "decline" } })
      } else {
        this.send({ id: message.id, error: { code: -32601, message: "Unexpected server request" } })
        this.fail(new Error(`Unexpected reverse request: ${message.method}`))
      }
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    } else if (message.method) {
      this.events.push(message)
      for (const waiter of this.waiters) {
        if (waiter.matches(message)) {
          this.waiters.delete(waiter)
          waiter.resolve(message)
        }
      }
    }
  }

  call(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${method}\n${this.stderr}`))
      }, 30000)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      this.send({ id, method, params })
    })
  }

  waitFor(matches) {
    const existing = this.events.find(matches)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`Notification timeout\n${this.stderr}`))
      }, 30000)
      const waiter = { matches,
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      }
      this.waiters.add(waiter)
    })
  }

  async initialize() {
    const response = await this.call("initialize", {
      clientInfo: { name: "araceae_runtime_test", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    })
    assert.ok(response.userAgent)
    this.send({ method: "initialized", params: {} })
  }

  async turn(threadId, prompt) {
    const { turn } = await this.call("turn/start", { threadId, input: [{ type: "text", text: prompt }] })
    const completed = await this.waitFor(message => message.method === "turn/completed" && message.params.turn.id === turn.id)
    assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed.params.turn))
    return this.events.filter(message => message.method === "item/completed" && message.params.turnId === turn.id)
      .map(message => message.params.item).filter(item => item.type === "agentMessage").map(item => item.text).join("")
  }

  async close() {
    this.process.stdin.end()
    const timer = setTimeout(() => this.process.kill(), 3000)
    try { await this.closed } finally { clearTimeout(timer); this.lines.close() }
  }
}

export function shellToolCall(request, script, shellArgs = {}) {
  const tool = request.tools.find(tool => ["exec_command", "shell_command", "shell"].includes(tool.function?.name))
  assert.ok(tool, "The model request must expose a native shell tool")
  const command = `node -e "${script}"`
  const args = tool.function.name === "exec_command" ? { cmd: command, ...shellArgs }
    : tool.function.name === "shell_command" ? { command, ...shellArgs }
      : { command: ["node", "-e", script] }
  return { name: tool.function.name, namespace: tool.namespace, arguments: JSON.stringify(args) }
}

export async function fixture(t, fixtures, settings = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "araceae-runtime-e2e-")))
  const mock = new LLMock({ host: "127.0.0.1", port: 0, strict: true, latency: 0, chunkSize: 8, responsesTools: "extended" })
  mock.addFixtures(fixtures)
  await mock.start()
  const codexHome = join(root, "home")
  const cwd = join(root, "workspace")
  await mkdir(codexHome)
  await mkdir(cwd)
  await writeFile(join(codexHome, "config.toml"), `
model = "gpt-5.4"
model_reasoning_effort = "low"
model_provider = "unconfigured-default"
approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "disabled"
[analytics]
enabled = false
[features]
code_mode = false
code_mode_host = false
[agents]
enabled = false
[model_providers.aimock]
name = "AIMock"
base_url = "${mock.url}/v1"
wire_api = "responses"
env_key = "ARACEAE_TEST_API_KEY"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`)
  const environment = { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: join(root, "state"), ARACEAE_TEST_API_KEY: "runtime-test-key" }
  delete environment.OPENAI_API_KEY
  delete environment.CODEX_API_KEY
  const servers = []
  t.after(async () => {
    for (const server of servers) await server.close()
    await mock.stop()
    await rm(root, { recursive: true, force: true })
  })
  if (settings.configure) await settings.configure({ root, cwd, codexHome, environment, mock })
  return { root, cwd, mock, codexHome, environment, async connect() {
    const server = new AppServer(environment, cwd, settings.overrides)
    servers.push(server)
    await server.initialize()
    return server
  } }
}

export async function listen(t, handler, connect) {
  const server = createServer(handler)
  if (connect) server.on("connect", connect)
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return `http://127.0.0.1:${server.address().port}`
}

/** Forwards a request unchanged to `upstream`. */
export function proxy(upstream, req, res) {
  const forwarded = request(upstream + req.url, { method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode, response.headers)
    response.pipe(res)
  })
  forwarded.on("error", error => res.destroy(error))
  req.pipe(forwarded)
}

/** Writes a provider auth command that returns an expired token first and logs each refused token. */
export async function credentialHelper(root, name) {
  const invocations = join(root, `${name}.jsonl`)
  const helper = join(root, `${name}.cjs`)
  await writeFile(helper, [
    "const fs = require('node:fs')",
    `const log = ${JSON.stringify(invocations)}`,
    "const prior = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0",
    "fs.appendFileSync(log, JSON.stringify({ rejected: process.env.ARACEAE_PROVIDER_AUTH_REJECTED_TOKEN ?? null }) + '\\n')",
    "process.stdout.write(prior === 0 ? 'EXPIRED_PROVIDER_TOKEN' : 'FRESH_PROVIDER_TOKEN')",
  ].join("\n"))
  return {
    invocations,
    config: `\n[model_providers.aimock.auth]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(helper)}]\nrefresh_interval_ms = 3600000\n`,
  }
}
