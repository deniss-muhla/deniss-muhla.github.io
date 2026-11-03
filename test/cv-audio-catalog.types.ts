import { AudioCatalogError as HelperAudioCatalogError } from "../scripts/cv-audio/catalog.mjs";
import { AudioCatalogError as RuntimeAudioCatalogError } from "../src/chat/audio-catalog.ts";

const helperConstructor: typeof HelperAudioCatalogError = RuntimeAudioCatalogError;
const runtimeConstructor: typeof RuntimeAudioCatalogError = HelperAudioCatalogError;
void helperConstructor;
void runtimeConstructor;

new HelperAudioCatalogError("manifest/clip-invalid");
// @ts-expect-error A catalog error code is required.
new HelperAudioCatalogError();
// @ts-expect-error Only codes exported by the source class may be constructed.
new HelperAudioCatalogError("not-a-catalog-error");
