import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { join } from "node:path"
import test from "node:test"
import { fixture, listen } from "./runtime-test-support.mjs"

const checks = JSON.parse(process.env.ARACEAE_RUNTIME_CHECKS ?? "{}")
const binary = process.env.ARACEAE_CODEX_BIN
const options = { timeout: 120000 }
function scenario(check, name, run) {
  test(name, { ...options, skip: !(check in checks) }, run)
}
async function config(home, update) {
  const path = join(home, "config.toml")
  await writeFile(path, update(await readFile(path, "utf8")))
}

for (const [check, contract] of Object.entries(checks)) {
  if (!contract.methods) continue
  scenario(check, `${check}: removed RPCs cannot be invoked`, async t => {
    const f = await fixture(t, [])
    const server = await f.connect()
    for (const method of contract.methods) {
      await assert.rejects(server.call(method, {}), /Invalid request|not found|unavailable|unsupported/i, method)
    }
  })
}

scenario("explicit-provider", "missing or managed providers fail even when native credentials exist", async t => {
  const f = await fixture(t, [], { configure: async ({ codexHome }) => {
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "NATIVE_FALLBACK_SENTINEL" }))
    await config(codexHome, text => text.replace('model_provider = "unconfigured-default"\n', ""))
  } })
  const missing = spawnSync(binary, ["app-server", "--listen", "stdio://"], { cwd: f.cwd, env: f.environment, encoding: "utf8", timeout: 15000 })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /Explicit model_provider/)
  const managed = spawnSync(binary, ["-c", 'model_provider="openai"', "app-server"], { cwd: f.cwd, env: f.environment, encoding: "utf8", timeout: 15000 })
  assert.notEqual(managed.status, 0)
  assert.match(managed.stderr, /native account authentication/)
  assert.equal(f.mock.getRequests().length, 0)
})

scenario("explicit-provider", "invalid provider overrides cannot bypass validation during thread creation", async t => {
  const f = await fixture(t, [])
  const server = await f.connect()
  await assert.rejects(server.call("thread/start", { cwd: f.cwd, modelProvider: "openai" }), /native account authentication/)
})

scenario("no-native-skills", "native skill files stay out of new and resumed model context", async t => {
  const f = await fixture(t, [{ match: {}, response: { content: "SKILL_ISOLATION_OK" } }], {
    overrides: ["-c", "features.skill_search=true"],
    configure: async ({ cwd, codexHome }) => {
      for (const base of [join(cwd, ".agents", "skills"), join(codexHome, "skills")]) {
        await mkdir(join(base, "native-marker"), { recursive: true })
        await writeFile(join(base, "native-marker", "SKILL.md"), "---\nname: native-marker\ndescription: NATIVE_SKILL_SECRET_SENTINEL\n---\nNATIVE_SKILL_SECRET_SENTINEL\n")
      }
    },
  })
  let server = await f.connect()
  const listed = await server.call("skills/list", { cwds: [f.cwd], forceReload: true })
  assert.deepEqual(listed.data, [{ cwd: f.cwd, skills: [], errors: [] }])
  await assert.rejects(server.call("skills/config/write", { path: join(f.codexHome, "skills", "native-marker", "SKILL.md"), enabled: false }), /disabled/)
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  await server.turn(thread.id, "VERIFY_SKILL_ISOLATION")
  await server.close()
  server = await f.connect()
  await server.call("thread/resume", { threadId: thread.id, cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  await server.turn(thread.id, "VERIFY_RESUMED_SKILL_ISOLATION")
  for (const record of f.mock.getRequests()) {
    assert.ok(!JSON.stringify(record.body).includes("NATIVE_SKILL_SECRET_SENTINEL"))
    assert.ok(!record.body.tools.some(tool => /skill_search/.test(tool.function?.name ?? "")))
  }
})

scenario("provider-auth-only", "provider credentials refresh after HTTP 401 without native account state", async t => {
  const observed = []
  let upstream
  const endpoint = await listen(t, (req, res) => {
    if (!req.url.endsWith("/responses")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); return }
    observed.push(req.headers.authorization)
    if (req.headers.authorization === "Bearer EXPIRED_PROVIDER_TOKEN") {
      req.resume(); res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"Expired provider token","type":"invalid_request_error","code":"invalid_api_key"}}'); return
    }
    const proxy = request(upstream + req.url, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res)
    })
    proxy.on("error", error => res.destroy(error)); req.pipe(proxy)
  })
  const f = await fixture(t, [{ match: {}, response: { content: "REFRESHED_PROVIDER_OK" } }], { configure: async ({ root, codexHome, mock }) => {
    upstream = mock.url
    const counter = join(root, "credential-count")
    const helper = join(root, "provider-credential.cjs")
    await writeFile(helper, `const fs=require('node:fs');const p=${JSON.stringify(counter)};const n=Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1;fs.writeFileSync(p,String(n));process.stdout.write(n===1?'EXPIRED_PROVIDER_TOKEN':'FRESH_PROVIDER_TOKEN');`)
    await writeFile(join(codexHome, "auth.json"), "INVALID_NATIVE_ACCOUNT_DATA")
    await config(codexHome, text => text.replace(mock.url, endpoint).replace('env_key = "ARACEAE_TEST_API_KEY"\n', "") + `\n[model_providers.aimock.auth]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(helper)}]\nrefresh_interval_ms = 3600000\n`)
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert.equal(await server.turn(thread.id, "REFRESH_PROVIDER_TOKEN"), "REFRESHED_PROVIDER_OK")
  assert.deepEqual(observed.slice(0, 2), ["Bearer EXPIRED_PROVIDER_TOKEN", "Bearer FRESH_PROVIDER_TOKEN"])
  assert.ok(!server.stderr.includes("FRESH_PROVIDER_TOKEN"))
  assert.equal(await readFile(join(f.codexHome, "auth.json"), "utf8"), "INVALID_NATIVE_ACCOUNT_DATA")
})

scenario("provider-auth-only", "an explicitly unauthenticated provider works without native credentials", async t => {
  const f = await fixture(t, [{ match: {}, response: { content: "LOCAL_PROVIDER_OK" } }], {
    configure: async ({ codexHome, environment }) => {
      delete environment.ARACEAE_TEST_API_KEY
      await config(codexHome, text => text.replace('env_key = "ARACEAE_TEST_API_KEY"\n', 'requires_openai_auth = false\n'))
    },
  })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert.equal(await server.turn(thread.id, "UNAUTHENTICATED_PROVIDER"), "LOCAL_PROVIDER_OK")
})

scenario("no-native-skills", "application load_skill remains a dynamic tool", async t => {
  const f = await fixture(t, [
    { match: { hasToolResult: true, toolResultContains: "APPLICATION_SKILL_BODY" }, response: { content: "APPLICATION_SKILL_OK" } },
    { match: { hasToolResult: false }, response: { toolCalls: [{ name: "load_skill", arguments: '{"name":"application-skill"}' }] } },
  ])
  const server = await f.connect()
  server.reverseHandler = message => {
    assert.equal(message.method, "item/tool/call")
    assert.equal(message.params.tool, "load_skill")
    server.send({ id: message.id, result: { success: true, contentItems: [{ type: "inputText", text: "APPLICATION_SKILL_BODY" }] } })
  }
  const { thread } = await server.call("thread/start", { cwd: f.cwd, dynamicTools: [{ name: "load_skill", description: "Load an application skill", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }] })
  assert.equal(await server.turn(thread.id, "LOAD_APPLICATION_SKILL"), "APPLICATION_SKILL_OK")
})

scenario("no-official-apps", "a configured MCP stdio tool still executes", async t => {
  const f = await fixture(t, [
    { match: { hasToolResult: true }, response: { content: "MCP_OK" } },
    { match: { hasToolResult: false }, response: request => {
      const tool = request.tools.find(tool => /marker/.test(tool.function?.name ?? ""))
      assert.ok(tool, JSON.stringify(request.tools))
      return { toolCalls: [{ name: tool.function.name, namespace: tool.namespace, arguments: "{}" }] }
    } },
  ], { configure: async ({ root, codexHome }) => {
    const helper = join(root, "mcp-fixture.cjs")
    await writeFile(helper, `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'marker',description:'Return marker',inputSchema:{type:'object',properties:{}}}]}:m.method==='tools/call'?{content:[{type:'text',text:'GENERIC_MCP_RESULT'}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`)
    await config(codexHome, text => text + `\n[mcp_servers.fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(helper)}]\n`)
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd })
  try {
    assert.equal(await server.turn(thread.id, "CALL_GENERIC_MCP"), "MCP_OK")
  } catch (error) {
    const outputs = f.mock.getRequests().flatMap(record => record.body.messages.filter(message => message.role === "tool"))
    throw new Error(`MCP outputs: ${JSON.stringify(outputs)}\n${server.stderr}`, { cause: error })
  }
  assert.ok(JSON.stringify(f.mock.getRequests().at(-1).body.messages).includes("GENERIC_MCP_RESULT"))
  assert.ok(server.events.some(event => event.method === "mcpServer/startupStatus/updated" && event.params.name === "fixture" && event.params.status === "ready"))
})

scenario("runtime-e2e", "Plan mode asks structured questions and receives the answer", async t => {
  const f = await fixture(t, [
    { match: { hasToolResult: true, toolResultContains: "KEEP_PLAN" }, response: { content: "PLAN_ANSWERED" } },
    { match: { hasToolResult: false }, response: { toolCalls: [{ name: "request_user_input", arguments: JSON.stringify({ questions: [{ id: "direction", header: "Direction", question: "Choose a direction", options: [{ label: "KEEP_PLAN", description: "Keep the plan" }, { label: "CHANGE_PLAN", description: "Change the plan" }] }] }) }] } },
  ])
  const server = await f.connect()
  server.reverseHandler = message => {
    assert.equal(message.method, "item/tool/requestUserInput")
    assert.equal(message.params.questions[0].id, "direction")
    server.send({ id: message.id, result: { answers: { direction: { answers: ["KEEP_PLAN"] } } } })
  }
  const { thread } = await server.call("thread/start", { cwd: f.cwd })
  const { turn } = await server.call("turn/start", { threadId: thread.id, input: [{ type: "text", text: "PLAN_QUESTION" }], collaborationMode: { mode: "plan", settings: { model: "gpt-5.4", reasoning_effort: "low", developer_instructions: null } } })
  const completed = await server.waitFor(event => event.method === "turn/completed" && event.params.turn.id === turn.id)
  assert.equal(completed.params.turn.status, "completed")
  assert.ok(server.events.some(event => event.method === "item/agentMessage/delta" && event.params.delta.includes("PLAN_")))
  assert.equal(f.mock.getRequests().length, 2)
})

scenario("provider-compaction", "manual compaction uses the configured Responses provider and preserves continuation", async t => {
  const f = await fixture(t, [{ match: {}, response: { content: "COMPACTED_PROVIDER_CONTEXT" } }])
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd })
  await server.turn(thread.id, "SEED_COMPACTION_CONTEXT")
  const start = f.mock.getRequests().length
  await server.call("thread/compact/start", { threadId: thread.id })
  const compacted = await server.waitFor(event => event.method === "item/completed" && event.params.item.type === "contextCompaction")
  await server.waitFor(event => event.method === "turn/completed" && event.params.turn.id === compacted.params.turnId)
  assert.ok(f.mock.getRequests().length > start, "Compaction must use the selected model")
  assert.equal(await server.turn(thread.id, "CONTINUE_COMPACTED_THREAD"), "COMPACTED_PROVIDER_CONTEXT")
})

scenario("provider-auth-only", "enabled legacy services and telemetry settings cannot trigger uploads", async t => {
  const outbound = []
  const trap = await listen(t, (req, res) => {
    outbound.push({ method: req.method, url: req.url, host: req.headers.host })
    req.resume(); res.writeHead(503); res.end()
  }, (req, socket) => {
    outbound.push({ method: "CONNECT", url: req.url })
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n")
  })
  const f = await fixture(t, [{ match: {}, response: { content: "NO_UPLOAD_OK" } }], {
    overrides: ["-c", "features.apps=true", "-c", "features.plugins=true", "-c", "features.remote_plugin=true", "-c", "features.skill_search=true"],
    configure: async ({ codexHome, environment }) => {
      await config(codexHome, text => `chatgpt_base_url = ${JSON.stringify(trap)}\n` + text.replace("enabled = false\n[features]", "enabled = true\n[features]") + `\n[otel]\nexporter = { otlp-http = { endpoint = "${trap}/logs", protocol = "json" } }\ntrace_exporter = { otlp-grpc = { endpoint = "${trap}/traces" } }\nmetrics_exporter = { otlp-http = { endpoint = "${trap}/metrics", protocol = "json" } }\n`)
      Object.assign(environment, { HTTP_PROXY: trap, HTTPS_PROXY: trap, ALL_PROXY: trap, http_proxy: trap, https_proxy: trap, all_proxy: trap, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", OPENAI_API_KEY: "IGNORED_NATIVE_KEY", CODEX_API_KEY: "IGNORED_NATIVE_KEY" })
      await writeFile(join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"IGNORED_NATIVE_FILE"}')
    },
  })
  const server = await f.connect()
  await server.call("model/list", {})
  const { thread } = await server.call("thread/start", { cwd: f.cwd })
  assert.equal(await server.turn(thread.id, "VERIFY_NO_UPLOAD"), "NO_UPLOAD_OK")
  await server.call("config/mcpServer/reload", {})
  await server.close()
  assert.deepEqual(outbound, [])
  assert.equal(f.mock.getRequests().length, 1)
  assert.ok(server.events.some(event => event.method === "thread/tokenUsage/updated"), "Token usage notifications must survive telemetry removal")
})

scenario("provider-model-catalog", "model metadata can be loaded from an explicit provider catalog", async t => {
  const requests = []
  const catalog = await listen(t, (req, res) => {
    requests.push(req.url)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ models: [{ slug: "provider-catalog-model", display_name: "Provider catalog model", description: "Fixture model", base_instructions: "Use the configured tools", supported_reasoning_levels: [], shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: 0, support_verbosity: false, truncation_policy: { mode: "tokens", limit: 10000 }, experimental_supported_tools: [], context_window: 65536 }] }))
  })
  const f = await fixture(t, [], { configure: async ({ codexHome }) => {
    await config(codexHome, text => text.replace('name = "AIMock"', `name = "AIMock"\nmodel_catalog_url = "${catalog}/catalog"`))
  } })
  const server = await f.connect()
  const response = await server.call("model/list", {})
  assert.ok(response.data.some(model => model.model === "provider-catalog-model"), `${JSON.stringify({ response, requests })}\n${server.stderr}`)
  assert.ok(requests.length > 0)
  assert.ok(requests.every(url => url.startsWith("/catalog")))
})

scenario("runtime-e2e", "background terminal processes can be listed and terminated across turns", async t => {
  const f = await fixture(t, [
    { match: { hasToolResult: true }, response: { content: "BACKGROUND_RUNNING" } },
    { match: { hasToolResult: false }, response: { toolCalls: [{ name: "exec_command", arguments: JSON.stringify({ cmd: 'node -e "setInterval(()=>{},1000)"', yield_time_ms: 1000 }) }] } },
  ])
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd })
  assert.equal(await server.turn(thread.id, "START_BACKGROUND_PROCESS"), "BACKGROUND_RUNNING")
  const terminals = await server.call("thread/backgroundTerminals/list", { threadId: thread.id })
  assert.equal(terminals.data.length, 1, JSON.stringify(terminals))
  const result = await server.call("thread/backgroundTerminals/terminate", { threadId: thread.id, processId: terminals.data[0].processId })
  assert.equal(result.terminated, true)
  await server.call("thread/backgroundTerminals/clean", { threadId: thread.id })
  assert.deepEqual((await server.call("thread/backgroundTerminals/list", { threadId: thread.id })).data, [])
})

scenario("runtime-e2e", "child agents inherit the configured model provider", async t => {
  let childRequested
  const childSeen = new Promise(resolve => { childRequested = resolve })
  const f = await fixture(t, [
    { match: { userMessage: "CHILD_PROVIDER_TASK" }, response: request => { childRequested(request); return { content: "CHILD_PROVIDER_DONE" } } },
    { match: { hasToolResult: true }, response: { content: "PARENT_PROVIDER_DONE" } },
    { match: { hasToolResult: false }, response: request => {
      const tool = request.tools.find(tool => tool.function?.name === "spawn_agent")
      assert.ok(tool, JSON.stringify(request.tools))
      return { toolCalls: [{ name: tool.function.name, namespace: tool.namespace, arguments: '{"message":"CHILD_PROVIDER_TASK","agent_type":"default","fork_context":false}' }] }
    } },
  ], { overrides: ["-c", "agents.enabled=true"] })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd })
  // A child that finishes before the parent's turn ends reports back, so the parent may answer again.
  assert.match(await server.turn(thread.id, "START_DELEGATION"), /^(?:PARENT_PROVIDER_DONE)+$/)
  const child = await Promise.race([childSeen, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Child agent did not call the configured provider")), 15000); timer.unref() })])
  assert.equal(child.model, "gpt-5.4")
})

scenario("provider-auth-only", "generic MCP OAuth completes without a native Codex account", async t => {
  let origin
  const tokens = []
  origin = await listen(t, async (req, res) => {
    const url = new URL(req.url, origin)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)) }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] })
    } else if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] })
    } else if (url.pathname === "/register") {
      json(201, { ...JSON.parse(body), client_id: "mcp-fixture-client", token_endpoint_auth_method: "none" })
    } else if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256")
      const redirect = new URL(url.searchParams.get("redirect_uri"))
      redirect.searchParams.set("state", url.searchParams.get("state"))
      redirect.searchParams.set("code", "mcp-fixture-code")
      res.writeHead(302, { location: redirect.href }); res.end()
    } else if (url.pathname === "/token") {
      tokens.push(new URLSearchParams(body))
      json(200, { access_token: "MCP_OAUTH_FIXTURE_TOKEN", token_type: "Bearer", expires_in: 3600 })
    } else {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }); res.end()
    }
  })
  const f = await fixture(t, [], { configure: async ({ codexHome }) => {
    await writeFile(join(codexHome, "auth.json"), "INVALID_NATIVE_ACCOUNT_DATA")
    await config(codexHome, text => 'mcp_oauth_credentials_store = "file"\n' + text + `\n[mcp_servers.oauth_fixture]\nurl = "${origin}/mcp"\n`)
  } })
  const server = await f.connect()
  const login = await server.call("mcpServer/oauth/login", { name: "oauth_fixture", clientRegistration: "dcr", scopes: [], timeoutSecs: 15 })
  const callback = await fetch(login.authorizationUrl)
  assert.ok(callback.ok)
  const completed = await server.waitFor(event => event.method === "mcpServer/oauthLogin/completed" && event.params.loginId === login.loginId)
  assert.equal(completed.params.success, true, JSON.stringify(completed.params))
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].get("code"), "mcp-fixture-code")
  assert.ok(tokens[0].get("code_verifier"))
  assert.equal(await readFile(join(f.codexHome, "auth.json"), "utf8"), "INVALID_NATIVE_ACCOUNT_DATA")
})
