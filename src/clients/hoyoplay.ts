// fork: HoYoPlay channel. Genshin OS constants (UPDATE_UI_IMAGE, wine
// defaults), with createClient replaced; see src/launcher/hoyoplay-entry.ts.
export * from "./hk4eos";
export { createHoyoplayCarrier as createClient } from "../launcher/hoyoplay-entry";
