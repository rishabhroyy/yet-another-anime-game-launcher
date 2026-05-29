import type { CommonUpdateProgram } from "@common-update-ui";
import {
  build,
  cp,
  doStreamUnzip,
  exec,
  exec2,
  generateRandomString,
  getKey,
  getKeyOrDefault,
  humanFileSize,
  mkdirp,
  removeFileIfExists,
  resolve,
  rmrf_dangerously,
  setKey,
  stats,
  tar_extract,
  tar_extract_directory,
  writeFile,
  xattrRemove,
} from "@utils";
import type { Aria2 } from "@aria2";
import type { Github, GithubReleaseInfo } from "../github";
import { getWineDistributions, type Wine, type WineDistribution } from "@wine";
import { addCertsToWine } from "../wine/cert";
import { DXMT_FILES } from "../downloadable-resource";
import { dirname, join } from "path-browserify";

export const SHARED_WINE_TAG = "__shared__";
export const HOYOPLAY_RENDERER_DXMT = "dxmt";
export const HOYOPLAY_RENDERER_D3DMETAL = "d3dmetal";
// Resolved through Neutralino's app path. In packaged builds this is
// ~/Library/Application Support/Yaagl OS/hoyoplay-wines.
const HOYOPLAY_WINES_DIR = "./hoyoplay-wines";
const HOYOPLAY_D3DMETAL_DIR = "./hoyoplay-renderers/d3dmetal";
const HOYOPLAY_D3DMETAL_RUNTIME_DIR = join(HOYOPLAY_D3DMETAL_DIR, "runtime");
const FALLBACK_D3DMETAL_RELEASE = {
  tagName: "Game-Porting-Toolkit-3.0-3",
  assetName: "game-porting-toolkit-3.0-3.tar.xz",
  downloadUrl:
    "https://github.com/Gcenx/game-porting-toolkit/releases/download/Game-Porting-Toolkit-3.0-3/game-porting-toolkit-3.0-3.tar.xz",
};

export type HoyoplayRenderer =
  | typeof HOYOPLAY_RENDERER_DXMT
  | typeof HOYOPLAY_RENDERER_D3DMETAL;

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

function gameRendererKey(gameId: string) {
  return `hoyoplay_${gameId}_renderer`;
}

function gameWineRoot(gameId: string, distro: WineDistribution) {
  return resolve(join(HOYOPLAY_WINES_DIR, gameId, distro.id, "wine"));
}

export async function getHoyoplayWineBin(gameId: string, wineTag: string) {
  if (wineTag === SHARED_WINE_TAG) return resolve("./wine/bin/wine");

  const distro = (await getWineDistributions()).find(x => x.id === wineTag);
  if (!distro) throw new Error(`Unknown Wine distribution: ${wineTag}`);

  return getCorrectWineBinary(gameWineRoot(gameId, distro));
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

async function replaceWithSymlink(source: string, destination: string) {
  await rmrf_dangerously(resolve(destination));
  await mkdirp(dirname(destination));
  await exec(["ln", "-sfn", resolve(source), resolve(destination)]);
}

async function copyOrSymlink(source: string, destination: string) {
  await removeFileIfExists(destination);
  try {
    const target = (await exec(["readlink", resolve(source)])).stdOut.trim();
    if (target) {
      await exec(["ln", "-sfn", target, resolve(destination)]);
      return;
    }
  } catch {
    // Source is a regular file, copy it below.
  }
  await cp(source, destination);
}

function rendererBackupPath(wineRoot: string, relativePath: string) {
  return join(wineRoot, ".hoyoplay-renderer-backup", relativePath);
}

async function backupWineFile(wineRoot: string, relativePath: string) {
  const source = join(wineRoot, relativePath);
  const backup = rendererBackupPath(wineRoot, relativePath);
  try {
    await stats(backup);
    return;
  } catch {
    // Back up below.
  }

  try {
    await stats(source);
  } catch {
    return;
  }

  await mkdirp(dirname(backup));
  await cp(source, backup);
}

async function restoreWineFile(wineRoot: string, relativePath: string) {
  const backup = rendererBackupPath(wineRoot, relativePath);
  try {
    await stats(backup);
  } catch {
    return;
  }
  await cp(backup, join(wineRoot, relativePath));
}

const DXMT_WINDOWS_RELATIVE_FILES = DXMT_FILES.map(f =>
  join("lib", "wine", "x86_64-windows", f)
);

async function syncDxmtFilesToGameWine(wineRoot: string) {
  for (const relativePath of DXMT_WINDOWS_RELATIVE_FILES) {
    await backupWineFile(wineRoot, relativePath);
  }

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

async function findD3DMetalExternalDir(sourceDir: string) {
  const candidates = [
    sourceDir,
    join(sourceDir, "external"),
    join(sourceDir, "lib", "external"),
    join(sourceDir, "redist", "lib", "external"),
  ];

  for (const candidate of candidates) {
    try {
      await stats(join(candidate, "D3DMetal.framework"));
      await stats(join(candidate, "libd3dshared.dylib"));
      return candidate;
    } catch {
      // Try the next common layout.
    }
  }

  try {
    const found = (
      await exec([
        "find",
        resolve(sourceDir),
        "-name",
        "D3DMetal.framework",
        "-type",
        "d",
        "-print",
        "-quit",
      ])
    ).stdOut.trim();
    if (found) {
      const candidate = dirname(found);
      await stats(join(candidate, "libd3dshared.dylib"));
      return candidate;
    }
  } catch {
    // Fall through to the error below.
  }

  throw new Error(
    "D3DMetal libraries not found. Select a folder containing D3DMetal.framework and libd3dshared.dylib, or a GPTK/CrossOver folder with lib/external."
  );
}

async function findRendererDllDir(sourceDir: string, dirName: string) {
  const candidates = [
    join(sourceDir, "lib", "wine", dirName),
    join(sourceDir, "wine", "lib", "wine", dirName),
  ];

  for (const candidate of candidates) {
    try {
      await stats(candidate);
      return candidate;
    } catch {
      // Try the next common layout.
    }
  }

  try {
    const found = (
      await exec([
        "find",
        resolve(sourceDir),
        "-path",
        `*/lib/wine/${dirName}`,
        "-type",
        "d",
        "-print",
        "-quit",
      ])
    ).stdOut.trim();
    return found || undefined;
  } catch {
    return undefined;
  }
}

async function copyOptionalRendererFiles({
  sourceDir,
  wineRoot,
  relativeDir,
  files,
}: {
  sourceDir: string;
  wineRoot: string;
  relativeDir: string;
  files: string[];
}) {
  const sourceDllDir = await findRendererDllDir(sourceDir, relativeDir);
  if (!sourceDllDir) return;

  await mkdirp(join(wineRoot, "lib", "wine", relativeDir));
  for (const file of files) {
    const source = join(sourceDllDir, file);
    try {
      await stats(source);
    } catch {
      continue;
    }

    const relativePath = join("lib", "wine", relativeDir, file);
    await backupWineFile(wineRoot, relativePath);
    await copyOrSymlink(source, join(wineRoot, relativePath));
  }
}

async function syncD3DMetalFilesToGameWine(
  wineRoot: string,
  sourceDir: string
) {
  for (const relativePath of DXMT_WINDOWS_RELATIVE_FILES) {
    await restoreWineFile(wineRoot, relativePath);
  }

  await removeFileIfExists(
    join(wineRoot, "lib", "wine", "x86_64-windows", "winemetal.dll")
  );
  await removeFileIfExists(
    join(wineRoot, "lib", "wine", "x86_64-unix", "winemetal.so")
  );
  await removeFileIfExists(
    join(wineRoot, "lib", "wine", "x86_64-windows", "nvngx.dll")
  );

  const externalDir = await findD3DMetalExternalDir(sourceDir);
  const destinationExternalDir = join(wineRoot, "lib", "external");
  await mkdirp(destinationExternalDir);
  await replaceWithSymlink(
    join(externalDir, "D3DMetal.framework"),
    join(destinationExternalDir, "D3DMetal.framework")
  );
  await replaceWithSymlink(
    join(externalDir, "libd3dshared.dylib"),
    join(destinationExternalDir, "libd3dshared.dylib")
  );

  await copyOptionalRendererFiles({
    sourceDir,
    wineRoot,
    relativeDir: "x86_64-windows",
    files: ["d3d10core.dll", "d3d11.dll", "dxgi.dll", "d3d12.dll"],
  });
  await copyOptionalRendererFiles({
    sourceDir,
    wineRoot,
    relativeDir: "x86_64-unix",
    files: ["d3d11.so", "dxgi.so", "d3d12.so"],
  });
}

function pickD3DMetalAsset(release: GithubReleaseInfo) {
  const candidates = release.assets.filter(asset =>
    /\.(tar\.xz|tar\.gz|tgz|zip)$/i.test(asset.name)
  );
  return (
    candidates.find(asset =>
      /game[-_. ]?porting[-_. ]?toolkit/i.test(asset.name)
    ) ?? candidates[0]
  );
}

function d3dmetalArchiveExtension(assetName: string) {
  if (assetName.endsWith(".zip")) return "zip";
  if (assetName.endsWith(".tar.gz") || assetName.endsWith(".tgz")) {
    return "tar.gz";
  }
  return "tar.xz";
}

async function getD3DMetalRelease(github: Github) {
  try {
    const release = (await github.api(
      "/repos/Gcenx/game-porting-toolkit/releases/latest"
    )) as GithubReleaseInfo;
    const asset = pickD3DMetalAsset(release);
    if (!asset) throw new Error("No downloadable GPTK archive asset found.");
    return {
      tagName: release.tag_name,
      assetName: asset.name,
      downloadUrl: asset.browser_download_url,
    };
  } catch {
    return FALLBACK_D3DMETAL_RELEASE;
  }
}

export async function* ensureHoyoplayD3DMetalRuntime({
  aria2,
  github,
}: {
  aria2: Aria2;
  github: Github;
}): CommonUpdateProgram<string> {
  const runtimeDir = resolve(HOYOPLAY_D3DMETAL_RUNTIME_DIR);
  const installedVersion = await getKeyOrDefault(
    "hoyoplay_d3dmetal_version",
    ""
  );

  const release = await getD3DMetalRelease(github);

  if (installedVersion === release.tagName) {
    try {
      await findD3DMetalExternalDir(runtimeDir);
      return runtimeDir;
    } catch {
      // Reinstall below.
    }
  }

  await rmrf_dangerously(runtimeDir);
  await mkdirp(runtimeDir);
  await mkdirp(HOYOPLAY_D3DMETAL_DIR);

  const archivePath = resolve(
    join(
      HOYOPLAY_D3DMETAL_DIR,
      `gptk-runtime-${release.tagName}-${Date.now()}.${d3dmetalArchiveExtension(
        release.assetName
      )}`
    )
  );

  yield ["setStateText", "DOWNLOADING_ENVIRONMENT"];
  const downloadUrls = Array.from(
    new Set([github.acceleratedPath(release.downloadUrl), release.downloadUrl])
  );
  let downloadError: unknown;
  let downloaded = false;
  for (const uri of downloadUrls) {
    try {
      for await (const progress of aria2.doStreamingDownload({
        uri,
        absDst: archivePath,
      })) {
        yield [
          "setProgress",
          Number(
            (progress.completedLength * BigInt(100)) / progress.totalLength
          ),
        ];
        yield [
          "setStateText",
          "DOWNLOADING_ENVIRONMENT_SPEED",
          `${humanFileSize(Number(progress.downloadSpeed))}`,
        ];
      }
      downloaded = true;
      break;
    } catch (error) {
      downloadError = error;
      await removeFileIfExists(archivePath);
    }
  }
  if (!downloaded) {
    throw new Error(
      `Failed to download D3DMetal runtime: ${
        downloadError instanceof Error ? downloadError.message : downloadError
      }`
    );
  }

  yield ["setStateText", "EXTRACT_ENVIRONMENT"];
  yield ["setUndeterminedProgress"];
  if (release.assetName.endsWith(".zip")) {
    for await (const [completed, total] of doStreamUnzip(
      archivePath,
      runtimeDir
    )) {
      yield ["setProgress", (completed / total) * 100];
    }
  } else {
    await exec(["tar", "-xf", archivePath, "-C", runtimeDir]);
  }

  await removeFileIfExists(archivePath);
  await findD3DMetalExternalDir(runtimeDir);
  await setKey("hoyoplay_d3dmetal_version", release.tagName);
  return runtimeDir;
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

export async function getHoyoplayGameRenderer(
  gameId: string
): Promise<HoyoplayRenderer> {
  const value = await getKeyOrDefault(
    gameRendererKey(gameId),
    HOYOPLAY_RENDERER_DXMT
  );
  return value === HOYOPLAY_RENDERER_D3DMETAL
    ? HOYOPLAY_RENDERER_D3DMETAL
    : HOYOPLAY_RENDERER_DXMT;
}

export function setHoyoplayGameRenderer(
  gameId: string,
  renderer: HoyoplayRenderer
) {
  return setKey(
    gameRendererKey(gameId),
    renderer === HOYOPLAY_RENDERER_DXMT ? null : renderer
  );
}

export async function getHoyoplayD3DMetalPath() {
  return resolve(HOYOPLAY_D3DMETAL_RUNTIME_DIR);
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
  renderer = HOYOPLAY_RENDERER_DXMT,
  d3dmetalPath,
}: {
  prefix: string;
  distro: WineDistribution;
  wineRoot: string;
  renderer?: HoyoplayRenderer;
  d3dmetalPath?: string;
}): Promise<Awaited<Wine>> {
  const loaderBin = await getCorrectWineBinary(wineRoot);

  function getEnvironmentVariables() {
    return {
      WINEDEBUG: "fixme-all,err-unwind,+timestamp",
      WINEPREFIX: prefix,
    };
  }

  function withD3DMetalTaskPolicy(command: string[]) {
    return renderer === HOYOPLAY_RENDERER_D3DMETAL
      ? ["taskpolicy", "-a", "-t", "0", "-l", "0", ...command]
      : command;
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
    if (
      renderer === HOYOPLAY_RENDERER_DXMT &&
      distro.attributes.renderBackend === "dxmt"
    ) {
      await syncDxmtFilesToGameWine(wineRoot);
    } else if (renderer === HOYOPLAY_RENDERER_D3DMETAL) {
      if (!d3dmetalPath) {
        throw new Error("D3DMetal renderer selected without a library folder.");
      }
      await syncD3DMetalFilesToGameWine(wineRoot, d3dmetalPath);
    }
    const command =
      program == "copy"
        ? [loaderBin, "cmd", "/c", program, ...args]
        : [loaderBin, program, ...args];
    return await exec2(
      withD3DMetalTaskPolicy(command),
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
      renderBackend:
        renderer === HOYOPLAY_RENDERER_DXMT
          ? distro.attributes.renderBackend
          : undefined,
    },
  };
}

export async function* ensureHoyoplayGameWine({
  aria2,
  baseWine,
  gameId,
  wineTag,
  renderer = HOYOPLAY_RENDERER_DXMT,
  d3dmetalPath,
}: {
  aria2: Aria2;
  baseWine: Awaited<Wine>;
  gameId: string;
  wineTag: string;
  renderer?: HoyoplayRenderer;
  d3dmetalPath?: string;
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
      renderer,
      d3dmetalPath,
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
    renderer,
    d3dmetalPath,
  });
}
