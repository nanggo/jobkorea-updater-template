import { JobKoreaService } from "./jobkorea";
import { TelegramAuthChannel, TelegramAuthConfig } from "./telegramAuth";
import { AuthenticationError } from "../types";

export async function authenticateViaTelegram(service: JobKoreaService, config: TelegramAuthConfig): Promise<void> {
  const channel = new TelegramAuthChannel(config);
  await channel.validate();
  let success = false;
  try {
    const readyDeadline = Date.now() + 420000;
    const ready = await channel.buttonPrompt(
      "🔐 잡코리아 재인증이 필요합니다.\n휴대폰을 준비한 뒤 아래 버튼을 눌러주세요. 버튼은 7분 동안 사용할 수 있습니다.\n문자는 버튼을 누른 뒤 한 번만 발송합니다.",
      "인증번호 받기", readyDeadline
    );
    await channel.waitForButton(ready, readyDeadline);
    // The website timer and the actual SMS request time determine the deadline.
    const deadline = await service.requestSmsTwoFactor();
    if (Date.now() >= deadline) throw new AuthenticationError("문자 인증 시간이 만료되었습니다.");
    const codePrompt = await channel.prompt(
      "휴대폰으로 인증번호를 보냈습니다.\n문자로 받은 6자리 번호를 입력해주세요.\n입력한 번호는 한 번만 제출하고 메시지에서 삭제합니다.",
      "6자리 인증번호", deadline
    );
    const code = await channel.waitForReply(codePrompt, deadline, text => /^\d{6}$/.test(text));
    await service.submitTwoFactorCode(code, deadline);
    success = true;
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("Telegram을 통한 2단계 인증을 완료하지 못했습니다. 문자나 인증번호를 자동 재전송하지 않습니다.");
  } finally {
    await channel.finish(success);
  }
}
