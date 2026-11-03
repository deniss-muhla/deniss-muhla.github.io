import assert from "node:assert/strict";
import test from "node:test";
import { hasBooleanEchoCancellation } from "../src/chat/stt/whistle/echo-cancellation.ts";

function track(granted: boolean | string | undefined, modes: (boolean | string)[] = ["all"]) {
  const requests: MediaTrackConstraints[] = [];
  return {
    requests,
    getCapabilities: () => ({ echoCancellation: modes }),
    getSettings: () => ({ echoCancellation: granted }),
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      requests.push(constraints);
    },
  };
}

test("observes boolean echo cancellation without upgrading advertised modes", async () => {
  const all = track(true, [true, false, "all"]);
  assert.equal(await hasBooleanEchoCancellation(all), true);
  assert.deepEqual(all.requests, []);

  assert.equal(await hasBooleanEchoCancellation(track(false)), false);
});

test("does not claim echo cancellation from missing, unknown, or string settings", async () => {
  for (const setting of [undefined, "unknown", "all", "remote-only"]) {
    assert.equal(await hasBooleanEchoCancellation(track(setting)), false);
  }
});
