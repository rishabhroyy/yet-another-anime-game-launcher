import { describe, expect, it, vi } from "vitest";
import type { SophonGame } from "../sophon/game";

const call = vi.fn();
vi.mock("../sophon/client", () => ({
  getSophonClient: async () => ({ call }),
}));
vi.mock("@utils", () => ({ exec: vi.fn(), log: vi.fn() }));
vi.mock("../clients/secret", () => ({ CN_ADV_URL: "", OS_ADV_URL: "" }));

const { getUpdateSizeBytes } = await import("./hoyoplay-hyp");

function game(action: object | undefined) {
  return {
    action: () => action,
    settings: () => ({ debugLogging: false }),
  } as unknown as SophonGame;
}

const update = {
  action: "update",
  sourceVersion: "7.0.0",
  targetVersion: "7.1.0",
  predownload: false,
  cacheOnly: false,
  voicePacks: ["en-us"],
};

describe("getUpdateSizeBytes", () => {
  it("sums game and installed voice packs for the source version", async () => {
    call.mockResolvedValueOnce({
      manifests: [
        {
          matching_field: "game",
          stats: {
            "7.0.0": { compressed_size: "100" },
            "6.7.0": { compressed_size: 900 },
          },
        },
        {
          matching_field: "en-us",
          stats: { "7.0.0": { compressed_size: 20 } },
        },
        {
          matching_field: "ja-jp",
          stats: { "7.0.0": { compressed_size: 30 } },
        },
      ],
    });
    expect(await getUpdateSizeBytes("hk4e_global", game(update))).toBe(120);
    expect(call).toHaveBeenLastCalledWith("api.sophonPatchBuild", {
      game: "hk4e_global",
      cn: false,
      predownload: false,
    });
  });

  it("is 0 when nothing to patch or the API fails", async () => {
    expect(await getUpdateSizeBytes("hk4e_global", game(undefined))).toBe(0);
    expect(
      await getUpdateSizeBytes(
        "hk4e_global",
        game({ ...update, action: "none" })
      )
    ).toBe(0);
    call.mockRejectedValueOnce(new Error("offline"));
    expect(await getUpdateSizeBytes("hk4e_cn", game(update))).toBe(0);
  });
});
