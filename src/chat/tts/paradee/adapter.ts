import type { AnswerAudioPlayer } from "../../answer-audio.ts";
import { ParadeePlayer } from "./player.ts";

export function createParadeeAdapter(): AnswerAudioPlayer {
  const player = new ParadeePlayer();
  return {
    prepare: () => player.prepare(),
    async playReferences(sequence, context, isCurrent = () => true) {
      if (isCurrent()) await player.speak(sequence.map((item) => item.text).join(" "), context);
    },
    stop: () => player.stop(),
    pausePlaying: () => player.pausePlaying(),
    settleOutput: () => player.settleOutput(),
  };
}
