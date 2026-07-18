import { createClient as createGenshinCnClient } from "../clients/hk4ecn";
import { createClient as createHsrCnClient } from "../clients/hkrpgcn";
import { createClient as createZzzCnClient } from "../clients/napcn";
import genshinFallbackIcon from "../assets/Nahida.cr.png";
import hsrFallbackIcon from "../icons/March7th.cr.png";
import zzzFallbackIcon from "../icons/ZZZ_Bang.cr.png";
import type { HoyoplayGameSpec } from "./hoyoplay";

export const HOYOPLAY_CN_GAME_SPECS: HoyoplayGameSpec[] = [
  {
    id: "genshin",
    namespace: "hpcngenshin",
    title: "Genshin Impact CN",
    fallbackIcon: genshinFallbackIcon,
    fpsSupported: true,
    createClient: createGenshinCnClient,
  },
  {
    id: "hsr",
    namespace: "hpcnhsr",
    title: "Honkai: Star Rail CN",
    fallbackIcon: hsrFallbackIcon,
    fpsSupported: false,
    createClient: createHsrCnClient,
  },
  {
    id: "zzz",
    namespace: "hpcnzzz",
    title: "Zenless Zone Zero CN",
    fallbackIcon: zzzFallbackIcon,
    fpsSupported: false,
    createClient: createZzzCnClient,
  },
];
