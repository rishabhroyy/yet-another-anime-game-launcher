// Fork entry point for the HoYoPlay multi-game launcher.
//
// Kept out of upstream files so upstream merges don't conflict: app.tsx only
// swaps its `createLauncher` import to this module, and the hoyoplay channel
// modules (src/clients/hoyoplay*.ts) export `createHoyoplayCarrier` as their
// `createClient`. Upstream channels fall through to the upstream launcher.
import type { Aria2 } from "@aria2";
import type { CreateClientOptions } from "../clients/shared";
import type { ChannelClient } from "../channel-client";
import { createLauncher as createUpstreamLauncher } from ".";
import { createHoyoplayLauncher } from "./hoyoplay";

const HOYOPLAY = Symbol("hoyoplay");

type Carrier = ChannelClient & { [HOYOPLAY]?: { aria2: Aria2 } };

// Not a real channel client: it only carries aria2 to createLauncher below,
// which builds one client per game itself.
export async function createHoyoplayCarrier({
  aria2,
}: CreateClientOptions): Promise<ChannelClient> {
  return { [HOYOPLAY]: { aria2 } } as Carrier;
}

export async function createLauncher(
  options: Parameters<typeof createUpstreamLauncher>[0]
) {
  const carrier = (options.channelClient as Carrier)[HOYOPLAY];
  if (!carrier) return createUpstreamLauncher(options);
  const cn = import.meta.env.YAAGL_CHANNEL_CLIENT === "hoyoplaycn";
  return createHoyoplayLauncher({
    wine: options.wine,
    locale: options.locale,
    github: options.github,
    onCheckUpdate: options.onCheckUpdate,
    aria2: carrier.aria2,
    appSupportName: cn ? "Yaagl CN" : undefined,
    specs: cn
      ? (await import("./hoyoplay-cn")).HOYOPLAY_CN_GAME_SPECS
      : undefined,
  });
}
