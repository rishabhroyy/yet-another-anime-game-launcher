import type { Aria2 } from "@aria2";
import type { CommonUpdateProgram } from "@common-update-ui";
import {
  exec,
  fileOrDirExists,
  getKeyOrDefault,
  humanFileSize,
  mkdirp,
  readBinary,
  resolve,
  setKey,
  spawn,
  wait,
  writeFile,
} from "@utils";
import type { Wine } from "@wine";
import { join } from "path-browserify";

const FPS_UNLOCKER_URL =
  "https://github.com/rishabhroyy/genshin-fps-unlock-universal/releases/download/v3.0.7/unlockfps.exe";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function* ensureGenshinFpsUnlocker(
  aria2: Aria2,
  wine: Wine
): CommonUpdateProgram {
  const dir = join(wine.prefix, "drive_c", "fps-unlocker");
  const exe = join(dir, "unlockfps.exe");
  if (await fileOrDirExists(exe)) return;

  await mkdirp(dir);
  yield ["setStateText", "DOWNLOADING_ENVIRONMENT"];
  for await (const progress of aria2.doStreamingDownload({
    uri: FPS_UNLOCKER_URL,
    absDst: exe,
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

export async function startGenshinFpsUnlockScript(
  wine: Wine,
  fps: number,
  wineBin = resolve("./wine/bin/wine")
) {
  const scriptPath = resolve("./hoyoplay_genshin_fps_unlocker.sh");

  await writeFile(
    scriptPath,
    [
      "#!/bin/bash",
      `export WINEPREFIX=${shellQuote(wine.prefix)}`,
      `WINE=${shellQuote(wineBin)}`,
      "",
      `"$WINE" "C:\\\\fps-unlocker\\\\unlockfps.exe" ${fps} &`,
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
        // Fall back to killing the shell process below.
      }
      try {
        await exec(["kill", process.pid + ""]);
      } catch {
        // Already exited.
      }
    },
  };
}

export async function runWithDelayedCompanion<T>({
  delayMs,
  run,
  start,
}: {
  delayMs: number;
  run: () => Promise<T>;
  start: () => Promise<{ stop(): Promise<void> }>;
}) {
  let done = false;
  let companion: { stop(): Promise<void> } | undefined;
  const main = run()
    .then(
      value => ({ value }),
      error => ({ error })
    )
    .finally(() => {
      done = true;
    });

  try {
    await wait(delayMs);
    if (!done) {
      companion = await start();
    }
    const result = await main;
    if ("error" in result) throw result.error;
    return result.value;
  } finally {
    if (companion) await companion.stop();
  }
}

export async function getFpsConfig(gameId: string) {
  return {
    enabled:
      (await getKeyOrDefault(`hoyoplay_${gameId}_fps_enabled`, "false")) ==
      "true",
    target: Math.max(
      1,
      Math.trunc(Number(await getKeyOrDefault(`hoyoplay_${gameId}_fps`, "120")))
    ),
  };
}

export function setFpsConfig(gameId: string, enabled: boolean, target: string) {
  return Promise.all([
    setKey(`hoyoplay_${gameId}_fps_enabled`, enabled ? "true" : "false"),
    setKey(`hoyoplay_${gameId}_fps`, target),
  ]);
}

export function withDxmtPreferredMaxFrameRate(
  env: Record<string, string>,
  fps: number
) {
  const current = env.DXMT_CONFIG ?? "";
  const next = current.includes("d3d11.preferredMaxFrameRate=")
    ? current.replace(/d3d11\.preferredMaxFrameRate=\d+;?/g, "")
    : current;

  return {
    ...env,
    DXMT_CONFIG: `d3d11.preferredMaxFrameRate=${fps};${next}`,
  };
}

export async function* withWineExec2Transform(
  wine: Wine,
  transformEnv: (env: Record<string, string>) => Record<string, string>,
  program: () => CommonUpdateProgram,
  companion?: () => Promise<{ stop(): Promise<void> }>
): CommonUpdateProgram {
  const originalExec2 = wine.exec2.bind(wine);

  wine.exec2 = async (command, args, env, logPath) => {
    const run = () =>
      originalExec2(command, args, transformEnv(env ?? {}), logPath);
    if (!companion) return run();
    return runWithDelayedCompanion({
      delayMs: 10000,
      run,
      start: companion,
    });
  };

  try {
    yield* program();
  } finally {
    wine.exec2 = originalExec2;
  }
}

export async function applyHsrFpsRegistry(wine: Wine, fps: number) {
  const key = "HKEY_CURRENT_USER\\Software\\Cognosphere\\Star Rail";
  const queryLog = resolve("./hoyoplay_hsr_fps_query.log");

  await wine.exec("reg", ["query", key], {}, queryLog);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const output = decoder.decode(await readBinary(queryLog));
  const line = output
    .split("\n")
    .map(x => x.trim())
    .find(x => x.startsWith("GraphicsSettings_Model_h"));
  if (!line) return;

  const [valueName] = line.split(/\s+/, 1);
  const hexStart = line.indexOf("REG_BINARY");
  if (hexStart < 0) return;

  const bytes = line
    .slice(hexStart + "REG_BINARY".length)
    .replace(/[^0-9a-fA-F]/g, "")
    .match(/.{1,2}/g)
    ?.map(x => parseInt(x, 16));
  if (!bytes) return;

  const fpsBytes = new TextEncoder().encode(String(fps));
  const marker = Array.from(new TextEncoder().encode("FPS"));
  const markerIndex = bytes.findIndex((_, i) =>
    marker.every((value, j) => bytes[i + j] === value)
  );
  if (markerIndex < 0) return;

  const searchStart = markerIndex + marker.length;
  const valueIndex = bytes.findIndex(
    (value, i) =>
      i >= searchStart &&
      value >= "0".charCodeAt(0) &&
      value <= "9".charCodeAt(0)
  );
  if (valueIndex < 0) return;

  const valueEnd = (() => {
    let i = valueIndex;
    while (i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
    return i;
  })();
  bytes.splice(valueIndex, valueEnd - valueIndex, ...Array.from(fpsBytes));

  await wine.exec(
    "reg",
    [
      "add",
      key,
      "/v",
      valueName,
      "/t",
      "REG_BINARY",
      "/d",
      bytes.map(x => x.toString(16).padStart(2, "0")).join(""),
      "/f",
    ],
    {},
    "/dev/null"
  );
}
