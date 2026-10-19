import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { fixture, shellToolCall } from "./runtime-test-support.mjs"

const options = { timeout: 120000 }

test("streaming responses and rollout history survive a process restart", options, async t => {
  const f = await fixture(t, [
    { match: { userMessage: "SEED_REQUEST" }, response: { content: "SEED_ANSWER" } },
    { match: { userMessage: "RESUME_REQUEST" }, response: { content: "RESUMED_ANSWER" } },
  ])
  const first = await f.connect()
  const skills = await first.call("skills/list", { cwds: [f.cwd], forceReload: true })
  assert.equal(skills.data[0].cwd, f.cwd)
  assert.ok(Array.isArray(skills.data[0].skills))
  await first.call("collaborationMode/list", {})
  const { thread } = await first.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert.equal(await first.turn(thread.id, "SEED_REQUEST"), "SEED_ANSWER")
  await first.call("thread/backgroundTerminals/list", { threadId: thread.id })
  await first.close()
  const second = await f.connect()
  await second.call("thread/resume", { threadId: thread.id, cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert.equal(await second.turn(thread.id, "RESUME_REQUEST"), "RESUMED_ANSWER")
  assert.ok(JSON.stringify(f.mock.getRequests().at(-1).body.messages).includes("SEED_ANSWER"))
  assert.ok(second.events.some(event => event.method === "item/agentMessage/delta"))
})

test("dynamic tools complete through app-server reverse requests", options, async t => {
  const f = await fixture(t, [
    { match: { hasToolResult: true, toolResultContains: "DYNAMIC_RESULT" }, response: { content: "DYNAMIC_DONE" } },
    { match: { hasToolResult: false }, response: { toolCalls: [{ name: "echo_marker", arguments: '{"value":"DYNAMIC_INPUT"}' }] } },
  ])
  const server = await f.connect()
  const { thread } = await server.call("thread/start", {
    cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access",
    dynamicTools: [{ name: "echo_marker", description: "Return a marker", inputSchema: {
      type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false,
    } }],
  })
  assert.equal(await server.turn(thread.id, "CALL_DYNAMIC_TOOL"), "DYNAMIC_DONE")
  assert.equal(f.mock.getRequests().length, 2)
})

test("native shell tools dispatch through the packaged runtime", options, async t => {
  const f = await fixture(t, [
    { match: { hasToolResult: true }, response: { content: "SHELL_DONE" } },
    { match: { hasToolResult: false }, response: request => ({
      toolCalls: [shellToolCall(request, "require('node:fs').writeFileSync('shell-marker.txt','SHELL_OK')")],
    }) },
  ])
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert.equal(await server.turn(thread.id, "RUN_SHELL_TOOL"), "SHELL_DONE")
  assert.equal(await readFile(join(f.cwd, "shell-marker.txt"), "utf8"), "SHELL_OK")
  assert.ok(server.events.some(event => event.method === "item/completed" && event.params.item.type === "commandExecution"))
})

test("declining an approval prevents the requested command from writing files", options, async t => {
  const f = await fixture(t, [
    { match: { hasToolResult: true }, response: { content: "DENIAL_HANDLED" } },
    { match: { hasToolResult: false }, response: { toolCalls: [{
      name: "exec_command", arguments: JSON.stringify({ cmd: 'node -e "require(\'node:fs\').writeFileSync(\'denied.txt\',\'SHOULD_NOT_EXIST\')"' }),
    }] } },
  ])
  const server = await f.connect()
  server.declineCommands = true
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write" })
  assert.equal(await server.turn(thread.id, "REQUEST_RESTRICTED_WRITE"), "DENIAL_HANDLED")
  assert.ok(server.approvals.length > 0)
  await assert.rejects(readFile(join(f.cwd, "denied.txt")), { code: "ENOENT" })
})

test("turn interruption completes without waiting for the model response", options, async t => {
  let notifyRequest
  const requestReceived = new Promise(resolve => { notifyRequest = resolve })
  const f = await fixture(t, [{ match: {}, response: async () => {
    notifyRequest()
    await new Promise(resolve => setTimeout(resolve, 3000))
    return { content: "LATE_MODEL_RESPONSE" }
  } }])
  const server = await f.connect()
  const { thread } = await server.call("thread/start", { cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access" })
  const { turn } = await server.call("turn/start", { threadId: thread.id, input: [{ type: "text", text: "INTERRUPT_REQUEST" }] })
  await requestReceived
  await server.call("turn/interrupt", { threadId: thread.id, turnId: turn.id })
  const completed = await server.waitFor(message => message.method === "turn/completed" && message.params.turn.id === turn.id)
  assert.equal(completed.params.turn.status, "interrupted")
  assert.ok(!server.events.some(event => event.method === "item/agentMessage/delta" && event.params.delta.includes("LATE_MODEL_RESPONSE")))
})
