import type { Aria2 } from "@aria2";
import type { CommonUpdateProgram } from "@common-update-ui";
import type { Config } from "@config";
import {
  exec,
  fileOrDirExists,
  humanFileSize,
  mkdirp,
  resolve,
  spawn,
  writeFile,
} from "@utils";
import type { Wine } from "@wine";
import { join } from "path-browserify";

const FPS_UNLOCKER_URL =
  "https://github.com/rishabhroyy/genshin-fps-unlock-universal/releases/download/v3.0.7/unlockfps.exe";
const FPS_UNLOCKER_WINE_PATH = "C:\\fps-unlocker\\unlockfps.exe";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function getHK4EFpsUnlockerTarget(config: Config) {
  const parsed = Number(config.hk4eFpsUnlockerTarget);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 120;
  }
  return parsed;
}

function getHK4EFpsUnlockerDir(wine: Wine) {
  return join(wine.prefix, "drive_c", "fps-unlocker");
}

function getHK4EFpsUnlockerPath(wine: Wine) {
  return join(getHK4EFpsUnlockerDir(wine), "unlockfps.exe");
}

export async function* checkAndDownloadHK4EFpsUnlocker(
  aria2: Aria2,
  wine: Wine
): CommonUpdateProgram {
  const unlockerPath = getHK4EFpsUnlockerPath(wine);
  if (await fileOrDirExists(unlockerPath)) {
    return;
  }

  await mkdirp(getHK4EFpsUnlockerDir(wine));
  yield ["setStateText", "DOWNLOADING_ENVIRONMENT"];
  for await (const progress of aria2.doStreamingDownload({
    uri: FPS_UNLOCKER_URL,
    absDst: unlockerPath,
  })) {
    yield [
      "setProgress",
      Number((progress.completedLength * BigInt(100)) / progress.totalLength),
    ];
    yield [
      "setStateText",
      "DOWNLOADING_ENVIRONMENT_SPEED",
      `${humanFileSize(Number(progress.downloadSpeed))}`,
    ];
  }
}

export async function startHK4EFpsUnlocker({
  wine,
  fps,
}: {
  wine: Wine;
  fps: number;
}) {
  const wineBin = resolve("./wine/bin/wine");
  const scriptPath = resolve("./hk4e_fps_unlocker.sh");

  await writeFile(
    scriptPath,
    [
      "#!/bin/bash",
      `export WINEPREFIX=${shellQuote(wine.prefix)}`,
      `WINE=${shellQuote(wineBin)}`,
      "",
      `"$WINE" "${FPS_UNLOCKER_WINE_PATH}" ${fps} &`,
      "UNLOCKER_PID=$!",
      `trap 'kill "$UNLOCKER_PID" 2>/dev/null; wait "$UNLOCKER_PID" 2>/dev/null; exit' INT TERM EXIT`,
      `wait "$UNLOCKER_PID"`,
      "",
    ].join("\n")
  );

  const process = await spawn(["bash", scriptPath]);

  return {
    async stop() {
      try {
        await Neutralino.os.updateSpawnedProcess(process.id, "exit");
      } catch {
        // Fall back to killing the script process below.
      }
      try {
        await exec(["kill", process.pid + ""]);
      } catch {
        // Process may have already exited.
      }
    },
  };
}
