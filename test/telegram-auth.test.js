const test = require("node:test");
const assert = require("node:assert/strict");
process.env.LOG_LEVEL = "error";
const { TelegramAuthChannel, isCurrentAuthReply, isCurrentAuthCallback, formatAuthDeadline } = require("../dist/services/telegramAuth");
const { AuthenticationError } = require("../dist/types");
const { Logger } = require("../dist/utils/logger");
const config = { token: "90001:synthetic-token", chatId: "10001" };
const owner = 10001, bot = 90001, time = 2000000000000;
const prompt = { id: 51, date: time / 1000 };
function message(overrides = {}) {
  return { message_id: 52, date: time / 1000, chat: { id: owner, type: "private" }, from: { id: owner, is_bot: false }, reply_to_message: { message_id: 51, from: { id: bot, is_bot: true } }, text: "654321", ...overrides };
}

test("accepts only a fresh reply from the private chat owner to this bot's current prompt", () => {
  const valid = value => isCurrentAuthReply(value, owner, bot, prompt, time + 10000, time + 1000);
  assert.equal(valid(message()), true);
  assert.equal(valid(message({ reply_to_message: undefined })), true);
  for (const invalid of [
    { from: { id: 123, is_bot: false } }, { from: { id: owner, is_bot: true } },
    { chat: { id: owner, type: "group" } }, { chat: { id: 123, type: "private" } },
    { message_id: 50, reply_to_message: undefined }, { message_id: 51, reply_to_message: undefined },
    { reply_to_message: { message_id: 50, from: { id: bot, is_bot: true } } },
    { reply_to_message: { message_id: 51, from: { id: 1, is_bot: true } } },
    { forward_origin: {} }, { via_bot: {} }, { sender_chat: {} },
    { date: prompt.date - 1 }, { date: prompt.date + 100 },
    { text: { code: "654321" } }, { text: "x".repeat(33) }, { message_id: "52" },
  ]) assert.equal(valid(message(invalid)), false);
  assert.equal(isCurrentAuthReply(message(), owner, bot, prompt, time, time), false);
});

function api(t, settings = {}) {
  const calls = [];
  let ticks = time;
  const request = async (url, options) => {
    const method = url.split("/").at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    assert.equal(options.redirect, "error");
    let result;
    if (method === "getWebhookInfo") result = { url: settings.webhook || "", allowed_updates: settings.allowedUpdates };
    else if (method === "getChat") result = { id: owner, type: settings.chatType || "private" };
    else if (method === "getMe") result = { id: bot, is_bot: true };
    else if (method === "sendMessage") result = { chat: { id: owner }, message_id: prompt.id, date: prompt.date };
    else if (method === "deleteMessage") result = true;
    else if (method === "editMessageText" || method === "editMessageReplyMarkup" || method === "answerCallbackQuery") result = true;
    else if (method === "getUpdates") {
      ticks += settings.tick || 1;
      if (settings.conflict) return new Response(JSON.stringify({ ok: false, error_code: 409 }), { status: 409 });
      const batch = settings.batches?.shift();
      result = typeof batch === "function" ? batch(calls) : batch || [];
    } else assert.fail(`Unexpected method ${method}`);
    return new Response(JSON.stringify({ ok: true, result }));
  };
  return { calls, channel: new TelegramAuthChannel(config, request, () => ticks) };
}

test("webhook and group checks fail before consuming messages or changing settings", async t => {
  for (const settings of [{ webhook: "https://existing.example/hook" }, { chatType: "group" }, { allowedUpdates: ["callback_query"] }, { allowedUpdates: ["message"] }]) {
    const { channel, calls } = api(t, settings);
    await assert.rejects(channel.validate(), AuthenticationError);
    assert.equal(calls.some(call => /Updates|sendMessage|delete/.test(call.method)), false);
  }
});

function callback(data, overrides = {}) {
  return { id: "callback-id", from: { id: owner, is_bot: false },
    message: { message_id: prompt.id, date: prompt.date, chat: { id: owner, type: "private" }, from: { id: bot, is_bot: true } }, data, ...overrides };
}

test("buttons require the owner, original message, fresh deadline and unguessable request data", () => {
  const current = { ...prompt, acceptData: "jk:ready:random", cancelData: "jk:cancel:random" };
  const valid = value => isCurrentAuthCallback(value, owner, bot, current, time + 10000, time);
  assert.equal(valid(callback(current.acceptData)), true);
  for (const value of [
    callback("jk:ready:old"), callback(current.acceptData, { from: { id: 22, is_bot: false } }),
    callback(current.acceptData, { from: { id: owner, is_bot: true } }),
    callback(current.acceptData, { message: { ...callback("").message, message_id: 1 } }),
    callback(current.acceptData, { message: { ...callback("").message, date: 0 } }),
    callback(current.acceptData, { message: { ...callback("").message, chat: { id: owner, type: "group" } } }),
    callback(current.acceptData, { message: undefined, inline_message_id: "foreign" }),
  ]) assert.equal(valid(value), false);
  assert.equal(isCurrentAuthCallback(callback(current.acceptData), owner, bot, current, time, time), false);
});

test("a valid start button is acknowledged once and removed immediately", async t => {
  const { channel, calls } = api(t, { batches: [calls => {
    const data = calls.find(call => call.method === "sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
    assert.ok(Buffer.byteLength(data) <= 64);
    return [{ update_id: 1, callback_query: callback(data) }];
  }, []] });
  await channel.validate();
  const current = await channel.buttonPrompt("ready", "인증번호 받기", time + 30000);
  await channel.waitForButton(current, time + 30000);
  assert.equal(calls.filter(call => call.method === "answerCallbackQuery").length, 1);
  const cleared = calls.find(call => call.method === "editMessageReplyMarkup");
  assert.deepEqual(cleared.body.reply_markup.inline_keyboard, []);
  assert.ok(calls.some(call => call.method === "deleteMessage" && call.body.message_id === current.id));
  assert.equal(current.acceptData, undefined);
});

test("native countdown uses UTF-16 offsets and one deadline without periodic message edits", async t => {
  const display = formatAuthDeadline("🔐 인증 안내", time + 180000);
  const entity = display.entities[0];
  assert.equal(entity.type, "date_time");
  assert.equal(entity.date_time_format, "r");
  assert.equal(entity.unix_time, (time + 180000) / 1000);
  assert.match(display.text.slice(entity.offset, entity.offset + entity.length), /에 마감$/);
  assert.equal(entity.offset, "🔐 인증 안내\n\n⏳ ".length);
  assert.match(display.text, /\(KST\)/);
  const { channel, calls } = api(t, { tick: 15000 });
  await channel.validate();
  const current = await channel.prompt("code prompt", "code", time + 30000);
  await assert.rejects(channel.waitForReply(current, time + 30000, () => true), AuthenticationError);
  const edits = calls.filter(call => call.method === "editMessageText");
  assert.equal(edits.length, 1, "Only update the message when it expires");
  assert.match(edits.at(-1).body.text, /시간 만료/);
  assert.deepEqual(edits.at(-1).body.entities, [], "Stop the native timer at expiry");
  assert.deepEqual(edits.at(-1).body.reply_markup.inline_keyboard, [[{ text: "시간 만료", disabled: {} }]]);
  await channel.finish(false);
  assert.equal(calls.some(call => call.method === "deleteMessage" && call.body.message_id === current.id), false);
});

test("consumes a matching reply once and deletes only its message and own prompts", async t => {
  const { channel, calls } = api(t, { batches: [
    [{ update_id: 1, message: message({ message_id: 60, from: { id: 7, is_bot: false } }) }, { update_id: 2, message: message({ message_id: 61, reply_to_message: { message_id: 44, from: { id: bot, is_bot: true } } }) }],
    [{ update_id: 3, message: message({ reply_to_message: undefined }) }], [],
  ] });
  await channel.validate();
  const sent = await channel.prompt("test prompt", "code");
  assert.equal(calls.find(call => call.method === "sendMessage").body.reply_markup.selective, undefined);
  assert.equal(await channel.waitForReply(sent, time + 10000, text => /^\d{6}$/.test(text)), "654321");
  await channel.finish(true);
  assert.deepEqual(calls.filter(call => call.method === "deleteMessage").map(call => call.body.message_id), [52, 51]);
  assert.equal(calls.filter(call => call.method === "getUpdates").at(-1).body.offset, 4);
  assert.equal(calls.some(call => "allowed_updates" in call.body || call.body.offset < 0), false);
  assert.equal(calls.filter(call => call.method === "sendMessage").some(call => call.body.text.includes("654321")), false);
  assert.equal(Logger.redactForExternalOutput("654321"), "***");
});

test("timeouts, cancellation and another poller stop without retrying submission", async t => {
  for (const settings of [
    { tick: 10001 },
    { conflict: true },
    { batches: [[{ update_id: 1, message: message({ text: "취소" }) }], []] },
  ]) {
    const { channel, calls } = api(t, settings);
    await channel.validate();
    const sent = await channel.prompt("prompt", "reply");
    await assert.rejects(channel.waitForReply(sent, time + 10000, () => true), AuthenticationError);
    assert.equal(calls.some(call => /setWebhook|deleteWebhook/.test(call.method)), false);
  }
});

test("network and malformed-body errors never expose tokens or received content", async () => {
  for (const request of [
    async () => { throw new Error(`https://api.telegram.org/bot${config.token}/getUpdates 123456`); },
    async () => new Response('not-json-123456'),
  ]) {
    const channel = new TelegramAuthChannel(config, request);
    await assert.rejects(channel.validate(), error => error instanceof AuthenticationError && !/synthetic-token|123456|https:/.test(error.message));
  }
});
