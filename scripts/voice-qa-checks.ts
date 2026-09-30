export type VoiceQaMessage = {
  text: string;
  pending: boolean;
  assistant: boolean;
  user: boolean;
};

export function qaOfflineReloadSucceeded(state: {
  online: boolean;
  isolated: boolean;
  hasBadge: boolean;
}): boolean {
  return !state.online && state.isolated && state.hasBadge;
}

export function qaModelsReady(status: string): boolean {
  return status.startsWith("Ready");
}

export function qaCompletedVoiceTurnSince(
  messages: readonly VoiceQaMessage[],
  baselineCount: number,
): { heard: string; answered: string } | undefined {
  for (let userIndex = baselineCount; userIndex < messages.length; userIndex += 1) {
    const userMessage = messages[userIndex];
    if (!userMessage?.user || userMessage.text.length <= 8) continue;

    const answer = messages.slice(userIndex + 1).find(
      (message) =>
        message.assistant &&
        !message.pending &&
        message.text.length > 20 &&
        !message.text.includes("voice assistant"),
    );
    if (answer) return { heard: userMessage.text, answered: answer.text };
  }
}
