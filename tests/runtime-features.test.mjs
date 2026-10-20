import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { join } from "node:path"
import test from "node:test"
import { credentialHelper, fixture, listen, proxy } from "./runtime-test-support.mjs"

const checks = JSON.parse(process.env.ARACEAE_RUNTIME_CHECKS ?? "{}")
const options = { timeout: 120000 }
function scenario(check, name, run) {
  test(name, { ...options, skip: !(check in checks) }, run)
}
async function config(home, update) {
  const path = join(home, "config.toml")
  await writeFile(path, update(await readFile(path, "utf8")))
}
/** Forwards a request after keeping its parsed Responses body, which aimock only journals in normalized form. */
function record(upstream, bodies, req, res) {
  const chunks = []
  req.on("data", chunk => chunks.push(chunk))
  req.on("end", () => {
    const body = Buffer.concat(chunks)
    if (req.url.endsWith("/responses")) bodies.push(JSON.parse(body.toString("utf8")))
    const forwarded = request(upstream + req.url, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers)
      response.pipe(res)
    })
    forwarded.on("error", error => res.destroy(error))
    forwarded.end(body)
  })
}
scenario("provider-auth-rejected-token", "a refresh after HTTP 401 hands the refused credential to the auth command", async t => {
  const observed = []
  let upstream
  let helper
  const endpoint = await listen(t, (req, res) => {
    if (!req.url.endsWith("/responses")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); return }
    observed.push(req.headers.authorization)
    if (req.headers.authorization === "Bearer EXPIRED_PROVIDER_TOKEN") {
      req.resume()
      res.writeHead(401, { "content-type": "application/json" })
      res.end('{"error":{"message":"Expired provider token","type":"invalid_request_error","code":"invalid_api_key"}}')
      return
    }
    proxy(upstream, req, res)
  })
  const f = await fixture(t, [{ match: {}, response: { content: "REJECTED_TOKEN_HANDOFF_OK" } }], { configure: async ({ root, codexHome, mock, environment }) => {
    upstream = mock.url
    helper = await credentialHelper(root, "provider-credential")
    environment.ARACEAE_PROVIDER_AUTH_REJECTED_TOKEN = "AMBIENT_SENTINEL"
    await config(codexHome, text => text.replace(mock.url, endpoint).replace('env_key = "ARACEAE_TEST_API_KEY"\n', "") + helper.config)
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert.equal(await server.turn(thread.id, "HAND_OFF_REJECTED_TOKEN"), "REJECTED_TOKEN_HANDOFF_OK")
  assert.deepEqual(observed.slice(0, 2), ["Bearer EXPIRED_PROVIDER_TOKEN", "Bearer FRESH_PROVIDER_TOKEN"])
  const calls = (await readFile(helper.invocations, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(calls.map(call => call.rejected), [null, "EXPIRED_PROVIDER_TOKEN"])
  assert.ok(!server.stderr.includes("FRESH_PROVIDER_TOKEN"))
})

scenario("raw-usage-notifications", "usage completions reach clients without raw-event opt-in, after resume and for child threads", async t => {
  const f = await fixture(t, [
    { match: { userMessage: "CHILD_USAGE_TASK" }, response: { content: "CHILD_USAGE_DONE" } },
    { match: { hasToolResult: true }, response: { content: "PARENT_USAGE_DONE" } },
    { match: { userMessage: "<subagent_notification>" }, response: { content: "PARENT_USAGE_DONE" } },
    { match: { userMessage: "SPAWN_CHILD_FOR_USAGE" }, response: { toolCalls: [{
      name: "spawn_agent", namespace: "multi_agent_v1", arguments: JSON.stringify({ message: "CHILD_USAGE_TASK" }),
    }] } },
    { match: { userMessage: "FIRST_USAGE_TURN" }, response: { content: "FIRST_USAGE_DONE" } },
    { match: { userMessage: "RESUMED_USAGE_TURN" }, response: { content: "RESUMED_USAGE_DONE" } },
  ], { overrides: ["-c", "agents.enabled=true"] })
  const completed = (server, threadId) => server.events.filter(event => event.method === "rawResponse/completed" && event.params.threadId === threadId)
  let server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert.equal(await server.turn(thread.id, "FIRST_USAGE_TURN"), "FIRST_USAGE_DONE")
  assert.equal(completed(server, thread.id).length, 1)
  assert.ok(completed(server, thread.id)[0].params.usage, JSON.stringify(completed(server, thread.id)[0]))
  assert.ok(!server.events.some(event => event.method === "rawResponseItem/completed"))
  await server.close()

  server = await f.connect()
  await server.call("thread/resume", { threadId: thread.id, cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert.equal(await server.turn(thread.id, "RESUMED_USAGE_TURN"), "RESUMED_USAGE_DONE")
  assert.equal(completed(server, thread.id).length, 1)

  // A child that finishes before the parent's turn ends reports back, so the parent may answer again.
  assert.match(await server.turn(thread.id, "SPAWN_CHILD_FOR_USAGE"), /^(?:PARENT_USAGE_DONE)+$/)
  const child = await server.waitFor(event => event.method === "rawResponse/completed" && event.params.threadId !== thread.id)
  assert.ok(child.params.threadId)
  assert.ok(!server.events.some(event => event.method === "rawResponseItem/completed"))
})

const envelopeConfig = '\n[model_providers.aimock.error_envelope]\nauth_failure_reasons = ["ERROR_LOGIN_EXPIRED"]\nauth_failure_message_pattern = "登录已(?:失效|过期)"\n'

scenario("platform-error-envelope", "an HTTP 200 credential-refusal envelope refreshes the refused token", async t => {
  const observed = []
  let upstream
  let helper
  const endpoint = await listen(t, (req, res) => {
    if (!req.url.endsWith("/responses")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); return }
    observed.push(req.headers.authorization)
    if (req.headers.authorization === "Bearer EXPIRED_PROVIDER_TOKEN") {
      req.resume()
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ code: 16, reason: "user.v1.ERROR_LOGIN_EXPIRED", message: "登录已失效" }))
      return
    }
    proxy(upstream, req, res)
  })
  const f = await fixture(t, [{ match: {}, response: { content: "ENVELOPE_REFRESH_OK" } }], { configure: async ({ root, codexHome, mock }) => {
    upstream = mock.url
    helper = await credentialHelper(root, "envelope-credential")
    await config(codexHome, text => text.replace(mock.url, endpoint).replace('env_key = "ARACEAE_TEST_API_KEY"\n', "") + envelopeConfig + helper.config)
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert.equal(await server.turn(thread.id, "REFRESH_AFTER_ENVELOPE"), "ENVELOPE_REFRESH_OK")
  assert.deepEqual(observed.slice(0, 2), ["Bearer EXPIRED_PROVIDER_TOKEN", "Bearer FRESH_PROVIDER_TOKEN"])
  const calls = (await readFile(helper.invocations, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(calls.map(call => call.rejected), [null, "EXPIRED_PROVIDER_TOKEN"])
})

scenario("platform-error-envelope", "an ordinary HTTP 200 error envelope fails the turn once with the gateway reason", async t => {
  const observed = []
  const endpoint = await listen(t, (req, res) => {
    if (!req.url.endsWith("/responses")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); return }
    observed.push(req.url)
    req.resume()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ code: 7, reason: "system.v1.MODEL_DISABLED", message: "模型已停用" }))
  })
  const f = await fixture(t, [], { configure: async ({ codexHome, mock }) => {
    await config(codexHome, text => text.replace(mock.url, endpoint) + envelopeConfig)
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  const { turn } = await server.call("turn/start", { threadId: thread.id, input: [{ type: "text", text: "DISABLED_MODEL_REQUEST" }] })
  const completed = await server.waitFor(message => message.method === "turn/completed" && message.params.turn.id === turn.id)
  assert.equal(completed.params.turn.status, "failed", JSON.stringify(completed.params.turn))
  assert.match(JSON.stringify(completed.params.turn.error ?? server.events.filter(event => event.method === "error")), /MODEL_DISABLED/)
  assert.equal(observed.length, 1)
})

scenario("platform-error-envelope", "invalid envelope patterns are rejected while loading configuration", async t => {
  const f = await fixture(t, [], { configure: async ({ codexHome }) => {
    await config(codexHome, text => text + '\n[model_providers.aimock.error_envelope]\nauth_failure_message_pattern = "("\n')
  } })
  const { spawnSync } = await import("node:child_process")
  const result = spawnSync(process.env.ARACEAE_CODEX_BIN, ["-c", 'model_provider="aimock"', "app-server", "--listen", "stdio://"], { cwd: f.cwd, env: f.environment, encoding: "utf8", timeout: 15000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /auth_failure_message_pattern/)
})

scenario("subagent-model-lock", "a locked subagent keeps the parent model and effort whatever the spawn call, defaults, or role select", async t => {
  const bodies = []
  let upstream
  const endpoint = await listen(t, (req, res) => record(upstream, bodies, req, res))
  const f = await fixture(t, [
    { match: { userMessage: "LOCKED_CHILD_TASK" }, response: { content: "LOCKED_CHILD_DONE" } },
    { match: { hasToolResult: true }, response: { content: "LOCKED_PARENT_DONE" } },
    { match: { userMessage: "<subagent_notification>" }, response: { content: "LOCKED_PARENT_DONE" } },
    { match: { userMessage: "SPAWN_LOCKED_CHILD" }, response: { toolCalls: [{
      name: "spawn_agent", namespace: "multi_agent_v1",
      arguments: JSON.stringify({ message: "LOCKED_CHILD_TASK", agent_type: "researcher", model: "gpt-5.5", reasoning_effort: "high" }),
    }] } },
  ], { configure: async ({ codexHome, mock }) => {
    upstream = mock.url
    await writeFile(join(codexHome, "researcher.toml"), 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "medium"\n')
    await config(codexHome, text => text.replace(mock.url, endpoint)
      .replace("[features]\n", "[features]\nmodel_catalog_in_context = true\n")
      .replace("[agents]\nenabled = false\n", [
        "[agents]", "enabled = true", "lock_subagent_model = true",
        'default_subagent_model = "gpt-5.5"', 'default_subagent_reasoning_effort = "high"',
        "[agents.researcher]", 'description = "Research role"', 'config_file = "./researcher.toml"', "",
      ].join("\n")))
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  // A child that finishes before the parent's turn ends reports back, so the parent may answer again.
  assert.match(await server.turn(thread.id, "SPAWN_LOCKED_CHILD"), /^(?:LOCKED_PARENT_DONE)+$/)
  await server.waitFor(event => event.method === "turn/completed" && event.params.threadId !== thread.id)

  const spawn = bodies[0].tools.find(tool => tool.name === "multi_agent_v1")?.tools.find(tool => tool.name === "spawn_agent")
  assert.ok(spawn, JSON.stringify(bodies[0].tools.map(tool => tool.name)))
  assert.ok(spawn.parameters.properties.agent_type)
  assert.equal(spawn.parameters.properties.model, undefined)
  assert.equal(spawn.parameters.properties.reasoning_effort, undefined)
  assert.ok(!spawn.description.includes("`model`"), spawn.description)
  assert.ok(bodies.every(body => !JSON.stringify(body.input).includes("<model_catalog>")))
  const child = bodies.filter(body => {
    const input = JSON.stringify(body.input)
    return input.includes("LOCKED_CHILD_TASK") && !input.includes("SPAWN_LOCKED_CHILD")
  })
  assert.equal(child.length, 1)
  assert.equal(child[0].model, "gpt-5.4")
  assert.equal(child[0].reasoning?.effort, "low")
})

scenario("application-context-world-state", "application context is one replaceable developer message that survives local compaction", async t => {
  const bodies = []
  let upstream
  const endpoint = await listen(t, (req, res) => record(upstream, bodies, req, res))
  const f = await fixture(t, [{ match: {}, response: { content: "APPLICATION_CONTEXT_OK" } }], { configure: async ({ codexHome, mock }) => {
    upstream = mock.url
    await config(codexHome, text => text.replace(mock.url, endpoint))
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  const start = (text, value) => server.call("turn/start", { threadId: thread.id, input: [{ type: "text", text }],
    ...value === undefined ? {} : { additionalContext: { application_policy: { kind: "application", value } } } })
  const turn = async (text, value) => {
    const { turn } = await start(text, value)
    const completed = await server.waitFor(event => event.method === "turn/completed" && event.params.turn.id === turn.id)
    assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed.params.turn))
  }
  const contexts = () => bodies.at(-1).input.filter(item => item.type === "message" && item.role === "developer")
    .flatMap(item => item.content.map(part => part.text)).filter(text => text.startsWith("<application_context>"))
  const policy = (value, notice = "") => `<application_context>\n${notice}<application_policy>\n${value}\n</application_policy>\n</application_context>`

  await turn("FIRST_CONTEXT_TURN", "POLICY_ONE")
  assert.deepEqual(contexts(), [policy("POLICY_ONE")])
  await turn("REPEATED_CONTEXT_TURN", "POLICY_ONE")
  assert.deepEqual(contexts(), [policy("POLICY_ONE")])

  await server.call("thread/compact/start", { threadId: thread.id })
  const compacted = await server.waitFor(event => event.method === "item/completed" && event.params.item.type === "contextCompaction")
  await server.waitFor(event => event.method === "turn/completed" && event.params.turn.id === compacted.params.turnId)
  await turn("AFTER_COMPACTION_TURN", "POLICY_ONE")
  assert.deepEqual(contexts(), [policy("POLICY_ONE")])
  await turn("OMITTED_CONTEXT_TURN")
  assert.deepEqual(contexts(), [policy("POLICY_ONE")])

  await turn("CHANGED_CONTEXT_TURN", "POLICY_TWO")
  assert.deepEqual(contexts(), [policy("POLICY_ONE"),
    policy("POLICY_TWO", "This application context replaces all previously provided application context.\n\n")])

  const requests = bodies.length
  await assert.rejects(start("OVERSIZED_CONTEXT_TURN", "x".repeat(50000)), /10000 estimated tokens/)
  assert.equal(bodies.length, requests)
})

scenario("apply-patch-function-tool", "the JSON function form of apply_patch edits files and returns malformed patches to the model", async t => {
  const bodies = []
  let upstream
  const endpoint = await listen(t, (req, res) => record(upstream, bodies, req, res))
  const applyPatch = input => ({ toolCalls: [{ name: "apply_patch", arguments: JSON.stringify({ input }) }] })
  const f = await fixture(t, [
    { match: { hasToolResult: true, toolResultContains: "apply_patch verification failed" }, response: { content: "PATCH_REJECTED" } },
    { match: { hasToolResult: true }, response: { content: "PATCH_APPLIED" } },
    { match: { userMessage: "PATCH_MALFORMED" }, response: applyPatch("*** Begin Patch\n*** Frobnicate File: notes.txt\n*** End Patch\n") },
    { match: { userMessage: "PATCH_WITH_FUNCTION" }, response: applyPatch("*** Begin Patch\n*** Add File: notes.txt\n+FUNCTION_PATCH_OK\n*** End Patch\n") },
  ], { configure: async ({ codexHome, mock }) => {
    upstream = mock.url
    await config(codexHome, text => text.replace(mock.url, endpoint)
      .replace('web_search = "disabled"\n', 'web_search = "disabled"\napply_patch_tool_type = "function"\n'))
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })

  assert.equal(await server.turn(thread.id, "PATCH_WITH_FUNCTION"), "PATCH_APPLIED")
  const tool = bodies[0].tools.find(tool => tool.name === "apply_patch")
  assert.equal(tool?.type, "function", JSON.stringify(bodies[0].tools.map(tool => [tool.type, tool.name])))
  assert.deepEqual(tool.parameters.required, ["input"])
  assert.equal(await readFile(join(f.cwd, "notes.txt"), "utf8"), "FUNCTION_PATCH_OK\n")
  const change = server.events.find(event => event.method === "item/completed" && event.params.item.type === "fileChange")
  assert.equal(change?.params.item.status, "completed", JSON.stringify(change))
  assert.ok(bodies.at(-1).input.some(item => item.type === "function_call_output"))

  assert.equal(await server.turn(thread.id, "PATCH_MALFORMED"), "PATCH_REJECTED")
  const rejected = bodies.at(-1).input.filter(item => item.type === "function_call_output").at(-1)
  assert.match(JSON.stringify(rejected.output), /apply_patch verification failed/)
  assert.equal(await readFile(join(f.cwd, "notes.txt"), "utf8"), "FUNCTION_PATCH_OK\n")
})
