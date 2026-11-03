/** Reports whether the browser granted boolean echo cancellation in track settings. */
export async function hasBooleanEchoCancellation(
  track: Pick<MediaStreamTrack, "getSettings">,
): Promise<boolean> {
  return track.getSettings().echoCancellation === true;
}
