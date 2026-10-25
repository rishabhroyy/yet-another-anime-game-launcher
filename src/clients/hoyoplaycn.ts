// fork: HoYoPlay CN channel. Genshin CN constants (UPDATE_UI_IMAGE, wine
// defaults), with createClient replaced; see src/launcher/hoyoplay-entry.ts.
export * from "./hk4ecn";
export { createHoyoplayCarrier as createClient } from "../launcher/hoyoplay-entry";
