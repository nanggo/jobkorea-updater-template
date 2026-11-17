const assert = require("node:assert/strict");
const { BrowserService } = require("../dist/services/browser");
const { JobKoreaService } = require("../dist/services/jobkorea");
const { authenticateViaTelegram } = require("../dist/services/twoFactorTelegram");

exports.verifyBrowserTelegramAuthFlow = async () => {
  const browser = new BrowserService();
  const originalFetch = global.fetch;
  let smsSends = 0, codeSubmits = 0, promptId = 0, updateId = 0;
  const deletes = [];
  const buttonChanges = [];
  const pending = [];
  let promptDate;
  global.fetch = async (url, options) => {
    assert.match(url, /^https:\/\/api\.telegram\.org\/bot90001:synthetic-token\//);
    const method = url.split("/").at(-1), body = JSON.parse(options.body);
    let result;
    if (method === "getWebhookInfo") result = { url: "" };
    else if (method === "getChat") result = { id: 10001, type: "private" };
    else if (method === "getMe") result = { id: 90001, is_bot: true };
    else if (method === "deleteMessage") { deletes.push(body.message_id); result = true; }
    else if (method === "editMessageReplyMarkup") { buttonChanges.push(body); result = true; }
    else if (method === "answerCallbackQuery" || method === "editMessageText") result = true;
    else if (method === "sendMessage") {
      assert.equal(body.text.includes("654321"), false, "Never echo an OTP to Telegram");
      promptId++;
      promptDate = Math.floor(Date.now() / 1000);
      result = { message_id: promptId, date: promptDate, chat: { id: 10001 } };
      if (body.reply_markup) {
        if (promptId === 1) assert.equal(smsSends, 0, "Wait for the user before sending SMS");
        else assert.equal(smsSends, 1);
        if (body.reply_markup.inline_keyboard) {
          assert.equal(body.entities[0].type, "date_time");
          assert.equal(body.entities[0].date_time_format, "r");
          pending.push({ update_id: ++updateId, callback_query: {
            id: `callback-${promptId}`, from: { id: 10001, is_bot: false },
            message: { message_id: promptId, date: promptDate, chat: { id: 10001, type: "private" }, from: { id: 90001, is_bot: true } },
            data: body.reply_markup.inline_keyboard[0][0].callback_data,
          } });
        } else {
          pending.push({ update_id: ++updateId, message: {
            message_id: 100 + promptId, date: promptDate, chat: { id: 10001, type: "private" },
            from: { id: 10001, is_bot: false }, text: "654321",
            reply_to_message: { message_id: promptId, from: { id: 90001, is_bot: true } },
          } });
        }
      }
    } else if (method === "getUpdates") result = pending.splice(0);
    else assert.fail(`Unexpected Telegram method ${method}`);
    return new Response(JSON.stringify({ ok: true, result }));
  };
  try {
    await browser.initialize();
    const page = browser.getPage(), context = page.context();
    await context.exposeBinding("recordSms", () => { smsSends++; });
    await context.exposeBinding("recordCode", (_, code) => { assert.equal(code, "654321"); codeSubmits++; });
    await context.route("**/*", route => {
      const pathname = new URL(route.request().url()).pathname;
      const headers = { "content-type": "text/html; charset=utf-8" };
      if (pathname === "/user/TwoFactorAuth/Index") return route.fulfill({ headers, body: `
        <label><input name="method" type="radio" value="1" onchange="document.querySelector('button').disabled=false"><span class="dot"></span>휴대폰 010-****-1234</label>
        <button disabled onclick="window.recordSms();location.href='/user/TwoFactorAuth/Code'">인증번호 발송</button>` });
      if (pathname === "/user/TwoFactorAuth/Code") return route.fulfill({ headers, body: `
        <span role="timer" aria-label="남은 시간">02:59</span>
        <label>인증번호<input oninput="document.getElementById('verify').disabled=this.value.length!==6"></label>
        <button id="verify" disabled onclick="window.recordCode(document.querySelector('input').value);document.getElementById('done').hidden=false">인증하기</button>
        <div role="dialog" aria-label="인증번호 발송 완료"><button onclick="this.parentElement.remove()">확인</button></div>
        <div role="dialog" aria-label="2단계 인증 완료" id="done" hidden><button onclick="location.href='/User/Mypage'">확인</button></div>` });
      if (pathname === "/User/Mypage") return route.fulfill({ headers, body: '<div class="status"><a href="/User/Resume/View">Resume</a></div>' });
      return route.abort();
    });
    await page.goto("https://www.jobkorea.co.kr/user/TwoFactorAuth/Index");
    await authenticateViaTelegram(new JobKoreaService(page), { token: "90001:synthetic-token", chatId: "10001" });
    assert.equal(smsSends, 1);
    assert.equal(codeSubmits, 1);
    assert.match(page.url(), /\/User\/Mypage$/);
    assert.deepEqual(deletes, [1, 103, 2, 3]);
    assert.deepEqual(buttonChanges[0].reply_markup.inline_keyboard, [], "Remove the start button before continuing");
    assert.deepEqual(buttonChanges[1].reply_markup.inline_keyboard.flat().map(button => button.text), ["취소"], "Remove the input button as soon as its prompt opens");
    console.log("Browser Telegram buttons, SMS deadline, code input and completion flow passed");
  } finally {
    global.fetch = originalFetch;
    await browser.close();
  }
};
