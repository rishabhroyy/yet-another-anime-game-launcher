import type { CommonUpdateProgram } from "@common-update-ui";
import {
  build,
  cp,
  exec,
  exec2,
  generateRandomString,
  getKey,
  humanFileSize,
  mkdirp,
  resolve,
  setKey,
  stats,
  tar_extract,
  tar_extract_directory,
  writeFile,
  xattrRemove,
} from "@utils";
import type { Aria2 } from "@aria2";
import { getWineDistributions, type Wine, type WineDistribution } from "@wine";
import { addCertsToWine } from "../wine/cert";
import { DXMT_FILES } from "../downloadable-resource";
import { dirname, join } from "path-browserify";

export const SHARED_WINE_TAG = "__shared__";
// Resolved through Neutralino's app path. In packaged builds this is
// ~/Library/Application Support/Yaagl OS/hoyoplay-wines.
const HOYOPLAY_WINES_DIR = "./hoyoplay-wines";

export type HoyoplayWineRef = {
  current: Awaited<Wine>;
};

export function createHoyoplayWineProxy(ref: HoyoplayWineRef): Awaited<Wine> {
  return {
    exec: (...args) => ref.current.exec(...args),
    exec2: (...args) => ref.current.exec2(...args),
    waitUntilServerOff: () => ref.current.waitUntilServerOff(),
    cmd: (...args) => ref.current.cmd(...args),
    toWinePath: path => ref.current.toWinePath(path),
    prefix: ref.current.prefix,
    openCmdWindow: (...args) => ref.current.openCmdWindow(...args),
    setProps: (...args) => ref.current.setProps(...args),
    setNVExtension: () => ref.current.setNVExtension(),
    get attributes() {
      return ref.current.attributes;
    },
  };
}

function gameWineKey(gameId: string) {
  return `hoyoplay_${gameId}_wine_tag`;
}

function gameWineRoot(gameId: string, distro: WineDistribution) {
  return resolve(join(HOYOPLAY_WINES_DIR, gameId, distro.id, "wine"));
}

export async function getHoyoplayWineBin(gameId: string, wineTag: string) {
  if (wineTag === SHARED_WINE_TAG) return resolve("./wine/bin/wine");

  const distro = (await getWineDistributions()).find(x => x.id === wineTag);
  if (!distro) throw new Error(`Unknown Wine distribution: ${wineTag}`);

  return join(gameWineRoot(gameId, distro), "bin", "wine");
}

async function getCorrectWineBinary(wineRoot: string) {
  try {
    await stats(join(wineRoot, "bin", "wine64"));
    return join(wineRoot, "bin", "wine64");
  } catch {
    return join(wineRoot, "bin", "wine");
  }
}

async function tryCopy(source: string, destination: string) {
  try {
    await cp(source, destination);
  } catch {
    // Optional DXMT files may be absent for some archived versions.
  }
}

async function syncDxmtFilesToGameWine(wineRoot: string) {
  for (const f of DXMT_FILES) {
    await tryCopy(
      `./dxmt/${f}`,
      join(wineRoot, "lib", "wine", "x86_64-windows", f)
    );
  }

  await tryCopy(
    "./dxmt/winemetal.dll",
    join(wineRoot, "lib", "wine", "x86_64-windows", "winemetal.dll")
  );
  await tryCopy(
    "./dxmt/winemetal.so",
    join(wineRoot, "lib", "wine", "x86_64-unix", "winemetal.so")
  );
  await tryCopy(
    "./dxmt/nvngx.dll",
    join(wineRoot, "lib", "wine", "x86_64-windows", "nvngx.dll")
  );
}

export async function getHoyoplayGameWineTag(gameId: string) {
  try {
    return await getKey(gameWineKey(gameId));
  } catch {
    return SHARED_WINE_TAG;
  }
}

export function setHoyoplayGameWineTag(gameId: string, wineTag: string) {
  return setKey(
    gameWineKey(gameId),
    wineTag === SHARED_WINE_TAG ? null : wineTag
  );
}

export async function getHoyoplayWineOptions(currentTag: string) {
  const versions = await getWineDistributions();
  return [
    {
      tag: SHARED_WINE_TAG,
      displayName: "Shared launcher Wine",
      url: "",
    },
    ...versions.map(x => ({
      tag: x.id,
      displayName: x.displayName,
      url: x.remoteUrl,
    })),
    ...(currentTag !== SHARED_WINE_TAG &&
    !versions.some(x => x.id === currentTag)
      ? [
          {
            tag: currentTag,
            displayName: currentTag,
            url: "",
          },
        ]
      : []),
  ];
}

export async function createWineFromRoot({
  prefix,
  distro,
  wineRoot,
}: {
  prefix: string;
  distro: WineDistribution;
  wineRoot: string;
}): Promise<Awaited<Wine>> {
  const loaderBin = await getCorrectWineBinary(wineRoot);

  function getEnvironmentVariables() {
    return {
      WINEDEBUG: "fixme-all,err-unwind,+timestamp",
      WINEPREFIX: prefix,
    };
  }

  async function wineExec(
    program: string,
    args: string[],
    env?: { [key: string]: string },
    log_file: string | undefined = undefined
  ) {
    return await exec(
      program == "copy"
        ? [loaderBin, "cmd", "/c", program, ...args]
        : [loaderBin, program, ...args],
      {
        ...getEnvironmentVariables(),
        ...(env ?? {}),
      },
      false,
      log_file
    );
  }

  async function wineExec2(
    program: string,
    args: string[],
    env?: { [key: string]: string },
    log_file: string | undefined = undefined
  ) {
    if (distro.attributes.renderBackend === "dxmt") {
      await syncDxmtFilesToGameWine(wineRoot);
    }
    return await exec2(
      program == "copy"
        ? [loaderBin, "cmd", "/c", program, ...args]
        : [loaderBin, program, ...args],
      {
        ...getEnvironmentVariables(),
        ...(env ?? {}),
      },
      false,
      log_file
    );
  }

  async function waitUntilServerOff() {
    return await exec2([join(dirname(loaderBin), "wineserver"), "-w"], {
      ...getEnvironmentVariables(),
    });
  }

  function toWinePath(absPath: string) {
    return "Z:" + `${absPath}`.replaceAll("/", "\\");
  }

  async function openCmdWindow({ gameDir }: { gameDir: string }) {
    return await exec2(
      [
        `osascript`,
        "-e",
        [
          "tell",
          "app",
          '"Terminal"',
          "to",
          "do",
          "script",
          `"${build([loaderBin, "cmd"], {
            ...getEnvironmentVariables(),
            WINEPATH: toWinePath(gameDir),
          })
            .replaceAll("\\", "\\\\")
            .replaceAll('"', '\\"')}"`,
        ].join(" "),
        "-e",
        ["tell", "app", '"Terminal"', "to", "activate"].join(" "),
      ],
      {},
      false,
      "/dev/null"
    );
  }

  let netbiosname: string;
  try {
    netbiosname = await getKey("wine_netbiosname");
  } catch {
    netbiosname = `DESKTOP-${generateRandomString(7)}`;
    await setKey("wine_netbiosname", netbiosname);
  }

  async function setProps(props: { retina: boolean; leftCmd: boolean }) {
    const cmd = `@echo off
cd "%~dp0"
reg add "HKEY_CURRENT_USER\\Software\\Wine\\Mac Driver" /v RetinaMode /t REG_SZ /d ${
      props.retina ? "y" : "n"
    } /f
reg add "HKEY_CURRENT_USER\\Software\\Wine\\Mac Driver" /v LeftCommandIsCtrl /t REG_SZ /d ${
      props.leftCmd ? "y" : "n"
    } /f
`;
    await writeFile(resolve("winedrv_config.bat"), cmd);
    await wineExec(
      "cmd",
      ["/c", `${toWinePath(resolve("./winedrv_config.bat"))}`],
      {},
      "/dev/null"
    );
    await waitUntilServerOff();
  }

  async function setNVExtension() {
    const cmd = `@echo off
cd "%~dp0"
reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\NVIDIA Corporation\\Global" /v "{41FCC608-8496-4DEF-B43E-7D9BD675A6FF}" /t REG_BINARY /d 1 /f
reg add "HKEY_LOCAL_MACHINE\\SYSTEM\\ControlSet001\\Services\\nvlddmkm" /v "{41FCC608-8496-4DEF-B43E-7D9BD675A6FF}" /t REG_BINARY /d 1 /f
reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\NVIDIA Corporation\\Global\\NGXCore" /v FullPath /t REG_SZ /d "C:\\Windows\\System32" /f
`;
    await writeFile(resolve("winedrv_config.bat"), cmd);
    await wineExec(
      "cmd",
      ["/c", `${toWinePath(resolve("./winedrv_config.bat"))}`],
      {},
      "/dev/null"
    );
    await waitUntilServerOff();
  }

  return {
    exec: wineExec,
    exec2: wineExec2,
    waitUntilServerOff,
    cmd: (command: string, args: string[]) =>
      wineExec("cmd", [command, ...args]),
    toWinePath,
    prefix,
    openCmdWindow,
    setProps,
    setNVExtension,
    attributes: {
      ...distro.attributes,
    },
  };
}

export async function* ensureHoyoplayGameWine({
  aria2,
  baseWine,
  gameId,
  wineTag,
}: {
  aria2: Aria2;
  baseWine: Awaited<Wine>;
  gameId: string;
  wineTag: string;
}): CommonUpdateProgram<Awaited<Wine>> {
  if (wineTag === SHARED_WINE_TAG) return baseWine;

  const distro = (await getWineDistributions()).find(x => x.id === wineTag);
  if (!distro) throw new Error(`Unknown Wine distribution: ${wineTag}`);

  const wineRoot = gameWineRoot(gameId, distro);
  try {
    await stats(join(wineRoot, "bin", "wine"));
    return await createWineFromRoot({
      prefix: baseWine.prefix,
      distro,
      wineRoot,
    });
  } catch {
    // Download below.
  }

  yield ["setStateText", "DOWNLOADING_ENVIRONMENT"];
  await mkdirp(wineRoot);
  const isXZ = distro.remoteUrl.endsWith(".xz");
  const wineTarPath = resolve(
    join(
      HOYOPLAY_WINES_DIR,
      gameId,
      distro.id,
      `wine.tar.${isXZ ? "xz" : "gz"}`
    )
  );
  for await (const progress of aria2.doStreamingDownload({
    uri: distro.remoteUrl,
    absDst: wineTarPath,
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

  yield ["setStateText", "EXTRACT_ENVIRONMENT"];
  yield ["setUndeterminedProgress"];
  if (distro.attributes.winePath) {
    await tar_extract_directory(
      wineTarPath,
      wineRoot,
      distro.attributes.winePath,
      isXZ
    );
  } else {
    await tar_extract(wineTarPath, wineRoot);
  }

  yield ["setStateText", "CONFIGURING_ENVIRONMENT"];
  await addCertsToWine(wineRoot);
  await xattrRemove("com.apple.quarantine", wineRoot);

  return await createWineFromRoot({
    prefix: baseWine.prefix,
    distro,
    wineRoot,
  });
}
