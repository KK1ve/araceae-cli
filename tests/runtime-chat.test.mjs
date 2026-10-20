import assert from "node:assert/strict"
import { access, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { credentialHelper, fixture, listen, proxy } from "./runtime-test-support.mjs"

const checks = JSON.parse(process.env.ARACEAE_RUNTIME_CHECKS ?? "{}")
const options = { timeout: 120000 }
function scenario(name, run) {
  test(name, { ...options, skip: !("chat-wire-api" in checks) }, run)
}
const BASE_INSTRUCTIONS = "CHAT_BASE_INSTRUCTIONS: answer briefly."
const threadOptions = f => ({ cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
const echoTool = { name: "echo_marker", description: "Return a marker", inputSchema: {
  type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false,
} }

async function rewrite(home, update) {
  const path = join(home, "config.toml")
  await writeFile(path, update(await readFile(path, "utf8")))
}
/** Switches the fixture provider to Chat Completions with a model id aimock treats as a reasoning model. */
function chatConfig(text, { endpoint, mockUrl, chat = "", top = "" } = {}) {
  const switched = text
    .replace('wire_api = "responses"', 'wire_api = "chat"')
    .replace('model = "gpt-5.4"', `model = "1001"\n${top}`)
  return (endpoint ? switched.replace(mockUrl, endpoint) : switched) + (chat ? `\n[model_providers.aimock.chat]\n${chat}\n` : "")
}
async function chatFixture(t, fixtures, settings = {}) {
  return fixture(t, fixtures, { ...settings, configure: async context => {
    const instructions = join(context.codexHome, "base-instructions.md")
    await writeFile(instructions, BASE_INSTRUCTIONS)
    await rewrite(context.codexHome, text => chatConfig(text, {
      chat: settings.chat,
      top: `model_instructions_file = ${JSON.stringify(instructions)}\n${settings.top ?? ""}`,
    }))
    if (settings.configure) await settings.configure(context)
  } })
}
/** Asserts the invariants every Chat Completions request must satisfy. */
function assertChatRequest(record) {
  assert.equal(record.path, "/v1/chat/completions")
  const body = JSON.stringify(record.body)
  assert.ok(!body.includes('"type":"namespace"'), body)
  assert.ok(record.body.messages.every(message => message.role !== "developer"), body)
}
async function failedTurn(server, threadId, text) {
  const { turn } = await server.call("turn/start", { threadId, input: [{ type: "text", text }] })
  const completed = await server.waitFor(event => event.method === "turn/completed" && event.params.turn.id === turn.id)
  assert.equal(completed.params.turn.status, "failed", JSON.stringify(completed.params.turn))
  return completed.params.turn
}

scenario("plain chat turns stream reasoning before text and report exact usage", async t => {
  const f = await chatFixture(t, [{ match: { userMessage: "CHAT_TEXT" }, response: { content: "CHAT_TEXT_OK", reasoning: "CHAT_REASONING" } }])
  const server = await f.connect()
  const { thread } = await server.call("thread/start", threadOptions(f))
  assert.equal(await server.turn(thread.id, "CHAT_TEXT"), "CHAT_TEXT_OK")

  const [record] = f.mock.getRequests()
  assertChatRequest(record)
  assert.equal(record.body.messages[0].role, "system")
  assert.ok(record.body.messages[0].content.startsWith(BASE_INSTRUCTIONS), record.body.messages[0].content)
  assert.equal(record.body.messages.at(-1).content, "CHAT_TEXT")
  assert.deepEqual(record.body.stream_options, { include_usage: true })

  const completed = server.events.filter(event => event.method === "item/completed").map(event => event.params.item)
  const reasoning = completed.findIndex(item => item.type === "reasoning")
  assert.ok(reasoning >= 0 && reasoning < completed.findIndex(item => item.type === "agentMessage"), JSON.stringify(completed))
  assert.match(JSON.stringify(completed[reasoning]), /CHAT_REASONING/)

  const raw = server.events.find(event => event.method === "rawResponse/completed")
  const usage = server.events.filter(event => event.method === "thread/tokenUsage/updated").at(-1)
  assert.ok(raw.params.usage.inputTokens > 0, JSON.stringify(raw))
  assert.equal(raw.params.usage.inputTokens, usage.params.tokenUsage.last.inputTokens)
  assert.equal(raw.params.usage.outputTokens, usage.params.tokenUsage.last.outputTokens)
})

scenario("reasoning is replayed within a tool loop and dropped on the next turn", async t => {
  const fixtures = [
    { match: { userMessage: "REPLAY_SECOND_TURN" }, response: { content: "SECOND_DONE" } },
    { match: { hasToolResult: true, toolResultContains: "DYNAMIC_RESULT" }, response: { content: "FIRST_DONE", reasoning: "AFTER_TOOL_REASONING" } },
    { match: { userMessage: "REPLAY_FIRST_TURN" }, response: {
      reasoning: "TOOL_LOOP_REASONING", toolCalls: [{ name: "echo_marker", arguments: '{"value":"DYNAMIC_INPUT"}' }],
    } },
  ]
  for (const [replay, expected] of [["current_turn", "TOOL_LOOP_REASONING"], ["none", undefined]]) {
    const f = await chatFixture(t, fixtures, { chat: `reasoning_replay = "${replay}"` })
    const server = await f.connect()
    const { thread } = await server.call("thread/start", { ...threadOptions(f), dynamicTools: [echoTool] })
    assert.equal(await server.turn(thread.id, "REPLAY_FIRST_TURN"), "FIRST_DONE")
    assert.equal(await server.turn(thread.id, "REPLAY_SECOND_TURN"), "SECOND_DONE")
    const requests = f.mock.getRequests()
    requests.forEach(assertChatRequest)
    const loop = requests[1].body.messages.find(message => message.tool_calls)
    assert.equal(loop.tool_calls[0].function.name, "echo_marker")
    assert.equal(loop.reasoning_content, expected, replay)
    assert.ok(!JSON.stringify(requests[2].body).includes("REASONING"), JSON.stringify(requests[2].body))
  }
})

scenario("namespaced tools are flattened under aliases and restored for parallel dispatch", async t => {
  const namespace = "acme_connector_with_an_unusually_long_namespace_name"
  const tool = (name, description) => ({ type: "function", name, description, inputSchema: echoTool.inputSchema })
  const f = await chatFixture(t, [
    { match: { hasToolResult: true }, response: { content: "ALIASES_DONE" } },
    { match: { userMessage: "CALL_ALIASED_TOOLS" }, response: request => {
      const long = request.tools.map(tool => tool.function.name).find(name => name.startsWith(`${namespace}_`))
      return {
        content: "Calling tools.",
        toolCalls: [
          { name: long, arguments: JSON.stringify({ value: "LONG" }) },
          { name: "docs__lookup", arguments: JSON.stringify({ value: "SHORT" }) },
        ],
        finishReason: "stop",
      }
    } },
  ])
  const server = await f.connect()
  const calls = []
  server.reverseHandler = message => {
    assert.equal(message.method, "item/tool/call")
    calls.push(message.params)
    server.send({ id: message.id, result: { success: true, contentItems: [{ type: "inputText", text: `RESULT_${message.params.arguments.value}` }] } })
  }
  const { thread } = await server.call("thread/start", { ...threadOptions(f), dynamicTools: [
    { type: "namespace", name: namespace, description: "Long connector", tools: [tool("create_document", "Create a document")] },
    { type: "namespace", name: "docs", description: "Docs", tools: [tool("lookup", "Look up docs")] },
  ] })
  assert.equal(await server.turn(thread.id, "CALL_ALIASED_TOOLS"), "Calling tools.ALIASES_DONE")

  const [first, second] = f.mock.getRequests()
  assertChatRequest(first)
  assertChatRequest(second)
  const names = first.body.tools.map(tool => tool.function.name)
  const long = names.find(name => name.startsWith(`${namespace}_`))
  assert.equal(long?.length, 64, JSON.stringify(names))
  assert.ok(names.includes("docs__lookup"), JSON.stringify(names))
  assert.deepEqual(calls.map(call => [call.namespace, call.tool, call.arguments.value]).sort(), [
    [namespace, "create_document", "LONG"],
    ["docs", "lookup", "SHORT"],
  ].sort())
  const assistant = second.body.messages.find(message => message.tool_calls)
  assert.equal(assistant.content, "Calling tools.")
  assert.deepEqual(assistant.tool_calls.map(call => call.function.name), [long, "docs__lookup"])
  const results = second.body.messages.filter(message => message.role === "tool").map(message => message.content)
  assert.deepEqual(results, ["RESULT_LONG", "RESULT_SHORT"])
})

scenario("structured output uses json_schema and falls back to json_object", async t => {
  const outputSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }
  for (const mode of ["json_schema", "json_object"]) {
    const f = await chatFixture(t, [{ match: {}, response: { content: '{"answer":"STRUCTURED_OK"}' } }], { chat: `structured_output = "${mode}"` })
    const server = await f.connect()
    const { thread } = await server.call("thread/start", threadOptions(f))
    const { turn } = await server.call("turn/start", { threadId: thread.id, input: [{ type: "text", text: "STRUCTURED" }], outputSchema })
    const completed = await server.waitFor(event => event.method === "turn/completed" && event.params.turn.id === turn.id)
    assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed.params.turn))
    const [record] = f.mock.getRequests()
    assertChatRequest(record)
    if (mode === "json_schema") {
      assert.equal(record.body.response_format.type, "json_schema")
      assert.ok(record.body.response_format.json_schema.schema.properties.answer, JSON.stringify(record.body.response_format))
    } else {
      assert.deepEqual(record.body.response_format, { type: "json_object" })
      assert.match(record.body.messages[0].content, /"answer"/)
    }
  }
})

scenario("context overflow fails the turn and compacts before the next one, while length does not", async t => {
  let overflow = true
  let upstream
  const endpoint = await listen(t, (req, res) => {
    if (overflow && req.url.endsWith("/chat/completions")) {
      overflow = false
      req.resume()
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens.", type: "invalid_request_error", code: "context_length_exceeded" } }))
      return
    }
    proxy(upstream, req, res)
  })
  const f = await chatFixture(t, [
    { match: { userMessage: "TRUNCATED_TURN" }, response: { content: "partial", finishReason: "length" } },
    { match: {}, response: { content: "RECOVERED" } },
  ], { configure: async ({ codexHome, mock }) => {
    upstream = mock.url
    await rewrite(codexHome, text => text.replace(mock.url, endpoint))
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", threadOptions(f))
  const overflowed = await failedTurn(server, thread.id, "OVERFLOW_TURN")
  assert.match(JSON.stringify(overflowed.error), /contextWindowExceeded/i)

  assert.equal(await server.turn(thread.id, "AFTER_OVERFLOW"), "RECOVERED")
  assert.ok(server.events.some(event => event.method === "item/completed" && event.params.item.type === "contextCompaction"))
  const truncated = await failedTurn(server, thread.id, "TRUNCATED_TURN")
  assert.doesNotMatch(JSON.stringify(truncated.error), /contextWindowExceeded/i)
  f.mock.getRequests().forEach(assertChatRequest)
})

scenario("the function form of apply_patch edits files over chat", async t => {
  const patch = "*** Begin Patch\n*** Add File: chat-notes.txt\n+CHAT_PATCH_OK\n*** End Patch\n"
  const f = await chatFixture(t, [
    { match: { hasToolResult: true }, response: { content: "CHAT_PATCH_DONE" } },
    { match: { userMessage: "CHAT_PATCH" }, response: { toolCalls: [{ name: "apply_patch", arguments: JSON.stringify({ input: patch }) }] } },
  ], { top: 'apply_patch_tool_type = "function"' })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", threadOptions(f))
  assert.equal(await server.turn(thread.id, "CHAT_PATCH"), "CHAT_PATCH_DONE")
  const [record] = f.mock.getRequests()
  assertChatRequest(record)
  const tool = record.body.tools.find(tool => tool.function.name === "apply_patch")
  assert.deepEqual(tool?.function.parameters.required, ["input"])
  assert.equal(await readFile(join(f.cwd, "chat-notes.txt"), "utf8"), "CHAT_PATCH_OK\n")
  assert.ok(server.events.some(event => event.method === "item/completed"
    && event.params.item.type === "fileChange" && event.params.item.status === "completed"))
})

scenario("instructions that change after the prefix are wrapped in user messages", async t => {
  const f = await chatFixture(t, [{ match: {}, response: { content: "CONTEXT_OK" } }])
  const server = await f.connect()
  const { thread } = await server.call("thread/start", threadOptions(f))
  const turn = async (text, value) => {
    const { turn } = await server.call("turn/start", { threadId: thread.id, input: [{ type: "text", text }],
      additionalContext: { application_policy: { kind: "application", value } } })
    const completed = await server.waitFor(event => event.method === "turn/completed" && event.params.turn.id === turn.id)
    assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed.params.turn))
  }
  await turn("FIRST_CONTEXT", "POLICY_ONE")
  await turn("SECOND_CONTEXT", "POLICY_TWO")
  const [first, second] = f.mock.getRequests()
  assertChatRequest(first)
  assertChatRequest(second)
  assert.match(first.body.messages[0].content, /<application_policy>\nPOLICY_ONE/)
  assert.equal(second.body.messages[0].content, first.body.messages[0].content)
  const wrapped = second.body.messages.filter(message => message.role === "user"
    && typeof message.content === "string" && message.content.startsWith("<system_instructions>"))
  assert.equal(wrapped.length, 1, JSON.stringify(second.body.messages))
  assert.match(wrapped[0].content, /replaces all previously provided application context[\s\S]*POLICY_TWO/)
})

scenario("a thread started over Responses resumes over chat", async t => {
  const f = await fixture(t, [
    { match: { userMessage: "RESPONSES_TURN" }, response: { content: "RESPONSES_DONE" } },
    { match: { userMessage: "CHAT_TURN" }, response: { content: "CHAT_DONE" } },
  ])
  let server = await f.connect()
  const { thread } = await server.call("thread/start", threadOptions(f))
  assert.equal(await server.turn(thread.id, "RESPONSES_TURN"), "RESPONSES_DONE")
  await server.close()
  await rewrite(f.codexHome, text => chatConfig(text))
  server = await f.connect()
  await server.call("thread/resume", { threadId: thread.id, ...threadOptions(f) })
  assert.equal(await server.turn(thread.id, "CHAT_TURN"), "CHAT_DONE")
  const requests = f.mock.getRequests()
  assert.equal(requests[0].path, "/v1/responses")
  const chat = requests.at(-1)
  assertChatRequest(chat)
  const contents = chat.body.messages.map(message => message.content)
  assert.ok(contents.includes("RESPONSES_TURN") && contents.includes("RESPONSES_DONE"), JSON.stringify(contents))
})

scenario("error chunks inside the stream fail the turn", async t => {
  const endpoint = await listen(t, (req, res) => {
    req.resume()
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-err", choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ error: { message: "UPSTREAM_RESET_BY_PEER", type: "server_error" } })}\n\n`)
  })
  const f = await chatFixture(t, [], { configure: async ({ codexHome, mock }) => {
    await rewrite(codexHome, text => text.replace(mock.url, endpoint))
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", threadOptions(f))
  const failed = await failedTurn(server, thread.id, "STREAM_ERROR")
  assert.match(JSON.stringify(failed.error), /UPSTREAM_RESET_BY_PEER/)
})

scenario("a stream cut off before finish_reason is retried without running its tool call", async t => {
  const observed = []
  const upstream = { url: undefined, marker: "" }
  const endpoint = await listen(t, (req, res) => {
    observed.push(req.url)
    if (observed.length > 1) { proxy(upstream.url, req, res); return }
    req.resume()
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(`data: ${JSON.stringify({ id: "chatcmpl-cut", choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: "call_cut", type: "function",
      function: { name: "exec_command", arguments: JSON.stringify({ cmd: `touch ${upstream.marker}` }) },
    }] }, finish_reason: null }] })}\n\n`)
  })
  const f = await chatFixture(t, [{ match: {}, response: { content: "RETRIED_OK" } }], { configure: async ({ cwd, codexHome, mock }) => {
    upstream.url = mock.url
    upstream.marker = join(cwd, "CUT_OFF_TOOL_RAN")
    await rewrite(codexHome, text => text.replace(mock.url, endpoint).replace("stream_max_retries = 0", "stream_max_retries = 1"))
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", threadOptions(f))
  assert.equal(await server.turn(thread.id, "CUT_OFF_STREAM"), "RETRIED_OK")
  assert.deepEqual(observed, ["/v1/chat/completions", "/v1/chat/completions"])
  const [retried] = f.mock.getRequests()
  assertChatRequest(retried)
  assert.ok(!JSON.stringify(retried.body).includes("call_cut"), JSON.stringify(retried.body))
  assert.ok(retried.body.tools.some(tool => tool.function.name === "exec_command"))
  await assert.rejects(access(upstream.marker), { code: "ENOENT" })
})

/** An upstream that refuses the expired token with `refusal` and forwards fresh tokens to aimock. */
async function refusingUpstream(t, refusal) {
  const observed = []
  const upstream = { url: undefined }
  const endpoint = await listen(t, (req, res) => {
    if (!req.url.endsWith("/chat/completions")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); return }
    observed.push(req.headers.authorization)
    if (req.headers.authorization === "Bearer EXPIRED_PROVIDER_TOKEN") {
      req.resume()
      refusal(res)
      return
    }
    proxy(upstream.url, req, res)
  })
  return { endpoint, observed, upstream }
}
const envelopeConfig = '\n[model_providers.aimock.error_envelope]\nauth_failure_reasons = ["ERROR_LOGIN_EXPIRED"]\nauth_failure_message_pattern = "登录已(?:失效|过期)"\n'

for (const [name, refusal] of [
  ["HTTP 401", res => { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"Expired provider token"}}') }],
  ["an HTTP 200 credential-refusal envelope", res => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify({ code: 16, reason: "user.v1.ERROR_LOGIN_EXPIRED", message: "登录已失效" }))
  }],
]) {
  scenario(`${name} rotates the refused credential before the chat request is retried`, async t => {
    const upstream = await refusingUpstream(t, refusal)
    let helper
    const f = await chatFixture(t, [{ match: {}, response: { content: "ROTATED_OK" } }], { configure: async ({ root, codexHome, mock }) => {
      upstream.upstream.url = mock.url
      helper = await credentialHelper(root, "chat-credential")
      await rewrite(codexHome, text => text.replace(mock.url, upstream.endpoint).replace('env_key = "ARACEAE_TEST_API_KEY"\n', "") + envelopeConfig + helper.config)
    } })
    const server = await f.connect()
    const { thread } = await server.call("thread/start", threadOptions(f))
    assert.equal(await server.turn(thread.id, "ROTATE_CREDENTIAL"), "ROTATED_OK")
    assert.deepEqual(upstream.observed.slice(0, 2), ["Bearer EXPIRED_PROVIDER_TOKEN", "Bearer FRESH_PROVIDER_TOKEN"])
    const calls = (await readFile(helper.invocations, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))
    assert.deepEqual(calls.map(call => call.rejected), [null, "EXPIRED_PROVIDER_TOKEN"])
  })
}

scenario("ordinary HTTP 200 error envelopes fail the chat turn after one request", async t => {
  const observed = []
  const endpoint = await listen(t, (req, res) => {
    observed.push(req.url)
    req.resume()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ code: 7, reason: "system.v1.MODEL_DISABLED", message: "模型已停用" }))
  })
  const f = await chatFixture(t, [], { configure: async ({ codexHome, mock }) => {
    await rewrite(codexHome, text => text.replace(mock.url, endpoint) + envelopeConfig)
  } })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", threadOptions(f))
  const failed = await failedTurn(server, thread.id, "DISABLED_MODEL")
  assert.match(JSON.stringify(failed.error), /MODEL_DISABLED/)
  assert.deepEqual(observed, ["/v1/chat/completions"])
})

scenario("responses without usage fall back to an estimated context size", async t => {
  const f = await chatFixture(t, [{ match: {}, response: { content: "NO_USAGE_OK" } }], { chat: "include_usage = false" })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", threadOptions(f))
  assert.equal(await server.turn(thread.id, "NO_USAGE"), "NO_USAGE_OK")
  const [record] = f.mock.getRequests()
  assertChatRequest(record)
  assert.equal(record.body.stream_options, undefined)
  const raw = server.events.find(event => event.method === "rawResponse/completed")
  assert.equal(raw.params.usage, null)
  const last = server.events.filter(event => event.method === "thread/tokenUsage/updated").at(-1)?.params.tokenUsage.last
  assert.ok(last?.totalTokens > 0, JSON.stringify(last))
  assert.equal(last.inputTokens, 0)
  assert.equal(last.outputTokens, 0)
})

scenario("subagents spawned over chat use the chat provider and report their usage", async t => {
  const f = await chatFixture(t, [
    { match: { userMessage: "CHAT_CHILD_TASK" }, response: { content: "CHAT_CHILD_DONE" } },
    { match: { hasToolResult: true }, response: { content: "CHAT_PARENT_DONE" } },
    { match: { userMessage: "<subagent_notification>" }, response: { content: "CHAT_PARENT_DONE" } },
    { match: { userMessage: "SPAWN_CHAT_CHILD" }, response: { toolCalls: [{
      name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({ message: "CHAT_CHILD_TASK" }),
    }] } },
  ], { overrides: ["-c", "agents.enabled=true"] })
  const server = await f.connect()
  const { thread } = await server.call("thread/start", threadOptions(f))
  // A child that finishes before the parent's turn ends reports back, so the parent may answer again.
  assert.match(await server.turn(thread.id, "SPAWN_CHAT_CHILD"), /^(?:CHAT_PARENT_DONE)+$/)
  const child = await server.waitFor(event => event.method === "rawResponse/completed" && event.params.threadId !== thread.id)
  assert.ok(child.params.usage?.inputTokens > 0, JSON.stringify(child.params))

  const requests = f.mock.getRequests()
  requests.forEach(assertChatRequest)
  assert.ok(requests[0].body.tools.some(tool => tool.function.name === "multi_agent_v1__spawn_agent"))
  const childRequest = requests.find(record => {
    const messages = JSON.stringify(record.body.messages)
    return messages.includes("CHAT_CHILD_TASK") && !messages.includes("SPAWN_CHAT_CHILD")
  })
  assert.equal(childRequest?.body.model, "1001")
})
