import { Locale } from "@locale";
import { Server } from "@constants";
import {
  HoyoConnectGameBackground,
  HoyoConnectGameBackgroundType,
  HoyoConnectGamePackageMainfest,
  HoyoConnectGetAllGameBasicInfoResponse,
  HoyoConnectGetGamesResponse,
  HoyoConnectGetGamePackagesResponse,
} from "./launcher-info";
import { exec } from "@utils";
import { sort } from "semver";

async function fetch(url: string) {
  const { stdOut } = await exec(["curl", url]);
  return {
    async json() {
      return JSON.parse(stdOut);
    },
  };
}

function withLanguage(url: string, locale: Locale, server: Server) {
  return (
    url +
    (server.id == "CN"
      ? `&language=zh-cn`
      : `&language=${locale.get("CONTENT_LANG_ID")}`)
  );
}

function apiUrlFromAdvUrl(server: Server, endpoint: string) {
  return server.adv_url.replace("getAllGameBasicInfo", endpoint);
}

export async function getGameDisplayInfo(locale: Locale, server: Server) {
  const ret: HoyoConnectGetGamesResponse = await (
    await fetch(
      withLanguage(apiUrlFromAdvUrl(server, "getGames"), locale, server)
    )
  ).json();
  const game = ret.data.games.find(x => x.biz == server.id);
  if (!game) throw new Error(`failed to fetch game display: ${server.id}`);
  return game.display;
}

export async function getLatestAdvInfo(
  locale: Locale,
  server: Server
): Promise<HoyoConnectGameBackground> {
  const ret: HoyoConnectGetAllGameBasicInfoResponse = await (
    await fetch(withLanguage(server.adv_url, locale, server))
  ).json();
  const game = ret.data.game_info_list.find(x => x.game.biz == server.id);
  if (!game || game.backgrounds.length < 1)
    throw new Error(`failed to fetch game information: ${server.id}`);

  const sortedBackgrounds = game.backgrounds.sort((a, b) => {
    const isAVideo =
      a.type === HoyoConnectGameBackgroundType.BACKGROUND_TYPE_VIDEO;
    const isBVideo =
      b.type === HoyoConnectGameBackgroundType.BACKGROUND_TYPE_VIDEO;

    if (isAVideo && !isBVideo) return -1;
    if (!isAVideo && isBVideo) return 1;
    return 0;
  });
  return sortedBackgrounds[0];
}

export async function getLatestVersionInfo(
  server: Server
): Promise<HoyoConnectGamePackageMainfest> {
  const ret: HoyoConnectGetGamePackagesResponse = await (
    await fetch(server.update_url)
  ).json();
  const game = ret.data.game_packages.find(x => x.game.biz == server.id);
  if (!game) throw new Error(`failed to fetch game information: ${server.id}`);
  return game;
}
