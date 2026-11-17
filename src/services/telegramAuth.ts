import { randomBytes } from "node:crypto";
import { AuthenticationError } from "../types";
import { Logger } from "../utils/logger";

export interface TelegramAuthConfig {
  token: string;
  chatId: string;
}

type AuthButton = { text: string; callback_data?: string; disabled?: Record<string, never> };
interface DateTimeEntity {
  type: "date_time";
  offset: number;
  length: number;
  unix_time: number;
  date_time_format: "r";
}
interface AuthPrompt {
  id: number;
  date: number;
  text?: string;
  deadline?: number;
  keyboard?: AuthButton[][];
  acceptData?: string;
  inputData?: string;
  cancelData?: string;
  inputPrompt?: AuthPrompt;
  placeholder?: string;
  inputInstruction?: string;
  keep?: boolean;
}

// Actions sets both variables; elsewhere there is no workflow to link to.
export function restartHint(environment: NodeJS.ProcessEnv = process.env): string {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository } = environment;
  return server && repository
    ? `다시 시작: ${server}/${repository}/actions/workflows/authenticate.yml`
    : "다시 시작하려면 인증 명령을 다시 실행하세요.";
}

export function formatAuthDeadline(text: string, deadline: number): { text: string; entities: DateTimeEntity[] } {
  const end = new Date(deadline).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
  const prefix = `${text}\n\n⏳ `;
  const fallback = `${end}에 마감`;
  return {
    text: `${prefix}${fallback}\n마감 ${end} (KST)`,
    // Telegram entity offsets use UTF-16 code units, like JavaScript strings.
    entities: [{ type: "date_time", offset: prefix.length, length: fallback.length, unix_time: Math.floor(deadline / 1000), date_time_format: "r" }],
  };
}

export function isCurrentAuthCallback(query: any, ownerId: number, botId: number, prompt: AuthPrompt, deadline: number, now: number): boolean {
  return !!query && typeof query.id === "string" && query.id.length > 0 && query.id.length <= 200 &&
    query.from?.id === ownerId && query.from.is_bot === false &&
    query.message?.chat?.type === "private" && query.message.chat.id === ownerId &&
    query.message.from?.id === botId && query.message.from.is_bot === true &&
    query.message.message_id === prompt.id && query.message.date === prompt.date &&
    typeof query.data === "string" &&
    [prompt.acceptData, prompt.inputData, prompt.cancelData].filter(Boolean).includes(query.data) && now < deadline;
}

function authError(message: string): AuthenticationError {
  return new AuthenticationError(`Telegram 인증: ${message}`);
}

// Accept fresh owner messages while one prompt is active. Explicit replies to
// a different prompt remain invalid, even when their text and time match.
export function isCurrentAuthReply(
  message: any,
  ownerId: number,
  botId: number,
  prompt: AuthPrompt,
  deadline: number,
  now: number
): boolean {
  return !!message && Number.isSafeInteger(message.message_id) && message.message_id > prompt.id &&
    message.chat?.type === "private" && message.chat.id === ownerId &&
    message.from?.id === ownerId && message.from.is_bot === false &&
    !message.forward_origin && !message.via_bot && !message.sender_chat &&
    (!message.reply_to_message || (
      message.reply_to_message.message_id === prompt.id &&
      message.reply_to_message.from?.id === botId &&
      message.reply_to_message.from.is_bot === true
    )) &&
    Number.isSafeInteger(message.date) && message.date >= prompt.date &&
    message.date * 1000 <= now + 5000 && now < deadline &&
    typeof message.text === "string" && message.text.length <= 32;
}

export class TelegramAuthChannel {
  private readonly ownerId: number;
  private botId = 0;
  private offset = 0;
  private readonly prompts = new Map<number, AuthPrompt>();

  constructor(
    private readonly config: TelegramAuthConfig,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {
    this.ownerId = Number(config.chatId);
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.token) || !/^[1-9]\d*$/.test(config.chatId) || !Number.isSafeInteger(this.ownerId)) {
      throw authError("개인 대화의 숫자 chat ID와 올바른 bot token이 필요합니다.");
    }
    Logger.registerSensitiveValues([config.token, config.chatId]);
  }

  private async call(method: string, body: Record<string, unknown>, timeout = 15000): Promise<any> {
    try {
      const response = await this.request(`https://api.telegram.org/bot${this.config.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.floor(timeout))),
      });
      const data = await response.json() as { ok?: boolean; result?: unknown; error_code?: number };
      if (response.status === 409 || data.error_code === 409) {
        throw authError("다른 수신기와 충돌했습니다. 기존 수신기를 변경하지 않고 중단합니다.");
      }
      if (!response.ok || data.ok !== true) throw authError(`${method} 요청 실패. 설정과 API 상태를 확인하세요.`);
      return data.result;
    } catch (error) {
      // Never include a fetch URL, Telegram response body, or received code.
      if (error instanceof AuthenticationError) throw error;
      throw authError(`${method} 응답을 확인하지 못했습니다. 자동 재전송하지 않습니다.`);
    }
  }

  async validate(): Promise<void> {
    const webhook = await this.call("getWebhookInfo", {});
    if (typeof webhook?.url !== "string" || webhook.url !== "") {
      throw authError("기존 webhook이 연결되어 있습니다. 설정을 변경하지 않고 중단합니다. 별도 인증 봇을 사용하세요.");
    }
    if (Array.isArray(webhook.allowed_updates) && webhook.allowed_updates.length &&
      ["message", "callback_query"].some(type => !webhook.allowed_updates.includes(type))) {
      throw authError("기존 업데이트 필터에서 메시지 또는 버튼 입력이 제외되어 있습니다. 설정을 변경하지 않고 중단합니다.");
    }
    const chat = await this.call("getChat", { chat_id: this.ownerId });
    const bot = await this.call("getMe", {});
    if (chat?.type !== "private" || chat.id !== this.ownerId || bot?.is_bot !== true || !Number.isSafeInteger(bot.id)) {
      throw authError("본인의 개인 대화와 봇 정보를 확인하지 못했습니다.");
    }
    this.botId = bot.id;
  }

  private async sendPrompt(text: string, replyMarkup: Record<string, unknown>, entities?: DateTimeEntity[]): Promise<AuthPrompt> {
    if (!this.botId) throw authError("수신 설정을 먼저 확인해야 합니다.");
    const sent = await this.call("sendMessage", {
      chat_id: this.ownerId,
      text,
      entities,
      protect_content: true,
      reply_markup: replyMarkup,
    });
    if (sent?.chat?.id !== this.ownerId || !Number.isSafeInteger(sent.message_id) || !Number.isSafeInteger(sent.date)) {
      throw authError("요청 메시지를 확인하지 못했습니다.");
    }
    const prompt = { id: sent.message_id, date: sent.date, text };
    this.prompts.set(prompt.id, prompt);
    return prompt;
  }

  async buttonPrompt(text: string, label: string, deadline: number): Promise<AuthPrompt> {
    const nonce = randomBytes(16).toString("hex");
    const acceptData = `jk:ready:${nonce}`, cancelData = `jk:cancel:${nonce}`;
    const keyboard = [[{ text: label, callback_data: acceptData }, { text: "취소", callback_data: cancelData }]];
    const display = formatAuthDeadline(text, deadline);
    const prompt = await this.sendPrompt(display.text, { inline_keyboard: keyboard }, display.entities);
    return Object.assign(prompt, { text, deadline, keyboard, acceptData, cancelData });
  }

  async prompt(text: string, placeholder: string, deadline?: number, inputInstruction?: string): Promise<AuthPrompt> {
    if (deadline === undefined) return this.sendPrompt(text, { force_reply: true, input_field_placeholder: placeholder });
    const nonce = randomBytes(16).toString("hex");
    const inputData = `jk:input:${nonce}`, cancelData = `jk:cancel:${nonce}`;
    const keyboard = [[{ text: "인증번호 입력", callback_data: inputData }, { text: "취소", callback_data: cancelData }]];
    const display = formatAuthDeadline(text, deadline);
    const prompt = await this.sendPrompt(display.text, { inline_keyboard: keyboard }, display.entities);
    return Object.assign(prompt, { text, deadline, keyboard, inputData, cancelData, placeholder, inputInstruction });
  }

  private async renderPrompt(prompt: AuthPrompt, status: string): Promise<void> {
    if (prompt.deadline === undefined) return;
    const text = `${status}\n${prompt.text}`;
    const keyboard = [[{ text: status, disabled: {} }]];
    try {
      await this.call("editMessageText", {
        chat_id: this.ownerId, message_id: prompt.id, text, entities: [],
        reply_markup: { inline_keyboard: keyboard },
      }, 3000);
    } catch {
      Logger.warning("Telegram 타이머 또는 버튼 표시를 갱신하지 못했습니다. 입력 마감 시간은 계속 적용됩니다.");
    }
  }

  private async acknowledgeUpdate(): Promise<void> {
    await this.call("getUpdates", { offset: this.offset, timeout: 0, limit: 1 }, 5000);
  }

  private async handleButton(query: any, prompt: AuthPrompt, deadline: number): Promise<"ready" | undefined> {
    if (!isCurrentAuthCallback(query, this.ownerId, this.botId, prompt, deadline, this.now())) {
      if (query?.from?.id === this.ownerId && query.message?.chat?.id === this.ownerId && query.message.from?.id === this.botId &&
        typeof query.id === "string" && typeof query.data === "string" && query.data.startsWith("jk:")) {
        await this.call("answerCallbackQuery", { callback_query_id: query.id, text: "이미 처리되었거나 만료된 요청입니다." }, 1500).catch(() => undefined);
      }
      return;
    }
    const action = query.data;
    await this.call("answerCallbackQuery", { callback_query_id: query.id }, 3000);
    if (this.now() >= deadline) throw authError("버튼 입력 시간이 만료되었습니다.");
    if (action === prompt.cancelData) {
      await this.acknowledgeUpdate();
      throw authError("사용자가 인증을 취소했습니다.");
    }
    if (action === prompt.acceptData) {
      prompt.acceptData = undefined;
      prompt.keyboard = [];
      await this.call("editMessageReplyMarkup", { chat_id: this.ownerId, message_id: prompt.id, reply_markup: { inline_keyboard: [] } }, 3000);
      if (await this.removeMessage(prompt.id)) this.prompts.delete(prompt.id);
      await this.acknowledgeUpdate();
      if (this.now() >= deadline) throw authError("버튼 입력 시간이 만료되었습니다.");
      return "ready";
    }
    if (action === prompt.inputData && !prompt.inputPrompt) {
      prompt.inputData = undefined;
      prompt.keyboard = prompt.keyboard?.map(row => row.filter(button => button.callback_data !== action)).filter(row => row.length);
      await this.call("editMessageReplyMarkup", { chat_id: this.ownerId, message_id: prompt.id, reply_markup: { inline_keyboard: prompt.keyboard } }, 3000);
      await this.acknowledgeUpdate();
      if (this.now() >= deadline) throw authError("버튼 입력 시간이 만료되었습니다.");
      const instruction = prompt.inputInstruction ?? "이 입력창에 받은 6자리 인증번호를 보내주세요.";
      const display = formatAuthDeadline(instruction, deadline);
      prompt.inputPrompt = await this.sendPrompt(
        display.text,
        { force_reply: true, input_field_placeholder: prompt.placeholder ?? "6자리 인증번호" }, display.entities
      );
    }
  }

  private async removeMessage(id: number): Promise<boolean> {
    try {
      await this.call("deleteMessage", { chat_id: this.ownerId, message_id: id }, 5000);
      return true;
    } catch {
      Logger.warning("Telegram 인증 메시지를 삭제하지 못했습니다. 대화에서 직접 삭제해주세요.");
      return false;
    }
  }

  async waitForButton(prompt: AuthPrompt, deadline: number): Promise<void> {
    await this.waitForInput(prompt, deadline);
  }

  async waitForReply(prompt: AuthPrompt, deadline: number, accepts: (text: string) => boolean): Promise<string> {
    return this.waitForInput(prompt, deadline, accepts);
  }

  private async waitForInput(prompt: AuthPrompt, deadline: number, accepts?: (text: string) => boolean): Promise<string> {
    const expired = () => authError("답장 대기 시간이 만료되었습니다. 수동 인증 workflow를 다시 실행하세요.");
    try {
      while (this.now() < deadline) {
        const remaining = deadline - this.now();
        if (remaining <= 0) throw expired();
        const timeout = Math.min(20, Math.max(0, Math.floor(remaining / 1000) - 1));
        let updates;
        try {
          updates = await this.call("getUpdates", { offset: this.offset, timeout, limit: 100 }, Math.min(25000, remaining));
        } catch (error) {
          if (this.now() >= deadline) throw expired();
          throw error;
        }
        if (!Array.isArray(updates)) throw authError("수신 응답 형식이 올바르지 않습니다.");
        for (const update of updates) {
          if (!Number.isSafeInteger(update?.update_id) || update.update_id < this.offset) continue;
          this.offset = update.update_id + 1;
          if (update.callback_query) {
            const action = await this.handleButton(update.callback_query, prompt, deadline);
            if (action === "ready") {
              return "ready";
            }
            continue;
          }
          const message = update.message;
          if (message?.chat?.id === this.ownerId && message.from?.id === this.ownerId) {
            Logger.info("Telegram 본인 메시지 수신 상태", {
              replyPresent: !!message.reply_to_message,
              replyMatchesPrompt: message.reply_to_message?.message_id === prompt.id,
              newerThanPrompt: message.message_id > prompt.id,
              withinWindow: Number.isSafeInteger(message.date) && message.date >= prompt.date && this.now() < deadline,
              expectedFormat: typeof message.text === "string" && message.text.length <= 32 && !!accepts?.(message.text.trim()),
            });
          }
          if (![prompt, prompt.inputPrompt].filter((item): item is AuthPrompt => !!item)
            .some(item => isCurrentAuthReply(message, this.ownerId, this.botId, item, deadline, this.now()))) continue;
          const text = message.text.trim();
          if (/^\d{6}$/.test(text)) Logger.registerSensitiveValues([text]);
          await this.removeMessage(message.message_id);
          if (text === "취소" || accepts?.(text)) {
            // Confirm the consumed update without persisting its payload locally.
            await this.acknowledgeUpdate();
            if (text === "취소") throw authError("사용자가 인증을 취소했습니다.");
            if (this.now() >= deadline) throw authError("입력 시간이 만료되었습니다.");
            await this.renderPrompt(prompt, "입력 수신 완료");
            return text;
          }
        }
      }
      throw expired();
    } catch (error) {
      prompt.keep = prompt.deadline !== undefined;
      await this.renderPrompt(prompt, this.now() >= deadline ? "시간 만료" : "요청 종료");
      throw error;
    }
  }

  async finish(success: boolean, testOnly = false): Promise<void> {
    try {
      await this.call("sendMessage", {
        chat_id: this.ownerId,
        text: success
          ? testOnly ? "✅ 잡코리아 버튼·번호 입력 테스트 완료. 실제 인증번호는 사용하지 않았습니다." : "✅ 잡코리아 인증 확인 완료. 후속 작업을 진행합니다."
          : `⚠️ 잡코리아 인증 요청이 종료되었습니다. 이전 요청에 코드를 보내지 마세요. 인증번호가 담긴 메시지가 남아 있다면 직접 삭제해주세요.\n${restartHint()}`,
      }, 5000);
    } catch {
      Logger.warning("Telegram 인증 종료 알림을 보내지 못했습니다.");
    }
    for (const [id, prompt] of this.prompts) if (!prompt.keep) await this.removeMessage(id);
    this.prompts.clear();
  }
}

export async function testTelegramAuthChannel(config: TelegramAuthConfig): Promise<void> {
  const channel = new TelegramAuthChannel(config);
  await channel.validate();
  let success = false;
  try {
    const readyDeadline = Date.now() + 300000;
    const ready = await channel.buttonPrompt("[잡코리아 버튼 테스트] 아래 버튼을 누르면 입력과 타이머 테스트가 시작됩니다. 실제 문자는 발송하지 않습니다.", "연결 테스트 시작", readyDeadline);
    await channel.waitForButton(ready, readyDeadline);
    const deadline = Date.now() + 180000;
    const prompt = await channel.prompt(
      "[잡코리아 연결 테스트]\n실제 문자는 발송하지 않았습니다.\n테스트용 인증번호: 123456\n이 번호를 입력해주세요. 실제 인증번호는 보내지 마세요.",
      "테스트용 6자리 번호", deadline,
      "테스트용 번호 123456을 입력해주세요. 실제 인증번호는 보내지 마세요."
    );
    await channel.waitForReply(prompt, deadline, text => text === "123456");
    success = true;
    Logger.success("Telegram 버튼과 현재 요청에 대한 번호 입력 수신 확인 완료");
  } finally {
    await channel.finish(success, true);
  }
}
