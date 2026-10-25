// fork: HoYoPlay data the upstream Sophon clients don't provide: the per-game
// launcher icon and the download size of a pending update.
import { exec, log } from "@utils";
import { CN_ADV_URL, OS_ADV_URL } from "../clients/secret";
import { getSophonClient } from "../sophon/client";
import type { SophonGame } from "../sophon/game";

// game biz (e.g. "hk4e_global") -> icon URL; empty when the API is unreachable.
export async function getGameIcons(cn: boolean) {
  const url = (cn ? CN_ADV_URL : OS_ADV_URL).replace(
    "getAllGameBasicInfo",
    "getGames"
  );
  try {
    const { stdOut } = await exec([
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      url,
    ]);
    const response: {
      data: { games: { biz: string; display: { icon: { url: string } } }[] };
    } = JSON.parse(stdOut);
    return Object.fromEntries(
      response.data.games.map(game => [game.biz, game.display.icon.url])
    );
  } catch (error) {
    await log("Could not load game icons: " + String(error));
    return {} as Record<string, string>;
  }
}

// Compressed download size of the update Sophon would run next (game data plus
// installed voice packs), taken from the patch build's precomputed per-version
// stats. 0 when no patch update is pending or the size is unknown.
export async function getUpdateSizeBytes(biz: string, sophon: SophonGame) {
  const next = sophon.action();
  const from = next?.sourceVersion;
  if (!from || (next.action !== "update" && next.action !== "resumeUpdate"))
    return 0;
  try {
    const client = await getSophonClient(sophon.settings().debugLogging);
    const build = await client.call<{
      manifests: {
        matching_field: string;
        stats: Record<string, { compressed_size: number | string }>;
      }[];
    }>("api.sophonPatchBuild", {
      game: biz,
      cn: biz.endsWith("_cn"),
      predownload: next.predownload,
    });
    const fields = new Set(["game", ...next.voicePacks]);
    return build.manifests
      .filter(manifest => fields.has(manifest.matching_field))
      .reduce(
        (total, manifest) =>
          total + (Number(manifest.stats[from]?.compressed_size) || 0),
        0
      );
  } catch (error) {
    await log("Could not estimate update size: " + String(error));
    return 0;
  }
}
