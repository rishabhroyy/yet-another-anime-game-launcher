import { join } from "path-browserify";
import { build, CommandSegments, rawString } from "./command-builder";

export function resolve(path: string): string {
  if (!path.startsWith("/")) {
    path = join(
      import.meta.env.PROD
        ? window.NL_PATH
        : join(window.NL_CWD, window.NL_PATH),
      path
    );
    // await Neutralino.os.showMessageBox("1", command, "OK");
    if (!path.startsWith("/") || path == "/")
      throw new Error("Assertation failed " + path);
  }
  return path;
}

export async function exec(
  segments: CommandSegments,
  env?: { [key: string]: string },
  sudo = false,
  log_redirect: string | undefined = undefined
): Promise<Neutralino.os.ExecCommandResult> {
  const cmd = build(
    [...segments, ...(log_redirect ? [rawString("&>"), log_redirect] : [])],
    env
  );
  await log(sudo ? runInSudo(cmd) : cmd);
  const ret = await Neutralino.os.execCommand(sudo ? runInSudo(cmd) : cmd, {});
  if (ret.exitCode != 0) {
    throw new Error(
      `Command return non-zero code (${ret.exitCode}) \n${cmd}\nStdOut:\n${ret.stdOut}\nStdErr:\n${ret.stdErr}`
    );
  }
  return ret;
}

export async function exec2(
  segments: CommandSegments,
  env?: { [key: string]: string },
  sudo = false,
  log_redirect: string | undefined = undefined
): Promise<Neutralino.os.ExecCommandResult> {
  const cmd = build(
    [...segments, ...(log_redirect ? [rawString("&>"), log_redirect] : [])],
    env
  );
  await log(cmd);
  const { id, pid } = await Neutralino.os.spawnProcess(cmd);

  return await new Promise((res, rej) => {
    let stdErr = "";
    let stdOut = "";

    const handler: Neutralino.events.Handler<
      Neutralino.os.SpawnProcessResult
    > = event => {
      if (!event || event.detail.id !== id) return;

      switch (event.detail.action) {
        case "stdOut": {
          stdOut += event.detail.data;
          break;
        }
        case "stdErr": {
          stdErr += event.detail.data;
          break;
        }
        case "exit": {
          const exit = Number(event.detail.data);
          if (exit == 0) {
            res({
              pid,
              exitCode: exit,
              stdErr,
              stdOut,
            });
          } else {
            rej(
              new Error(
                `Command return non-zero code (${exit}) \n${cmd}\nStdOut:\n${stdOut}\nStdErr:\n${stdErr}`
              )
            );
          }

          Neutralino.events.off("spawnedProcess", handler);
        }
      }
    };

    Neutralino.events.on("spawnedProcess", handler);
  });
}

export function runInSudo(cmd: string) {
  return build([
    "osascript",
    "-e",
    [
      "do",
      "shell",
      "script",
      `"${`${cmd}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
      "with",
      "administrator",
      "privileges",
    ].join(" "),
  ]);
}

export function tar_extract(src: string, dst: string) {
  return exec(["tar", "-zxvf", src, "-C", dst]);
}

export function tar_extract_directory(
  src: string,
  dst: string,
  dir: string,
  isXZ: boolean
) {
  const stripCount = dir.split("/").length;
  return exec([
    "tar",
    `--strip-components=${stripCount}`,
    "-C",
    dst,
    isXZ ? "-Jxvf" : "-zxvf",
    src,
    dir,
  ]);
}

export async function spawn(
  segments: CommandSegments,
  env?: { [key: string]: string }
) {
  const cmd = build(segments, env);
  await log(cmd);
  const { pid, id } = await Neutralino.os.spawnProcess(cmd);
  // await Neutralino.os.
  await log(pid + "");
  await log(cmd);
  return { pid, id };
}

let storageNamespace: string | undefined;

function storageKeyHash(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function shouldNamespaceStorageKey(key: string) {
  return (
    key == "game_install_dir" ||
    key == "patched" ||
    key == "predownloaded_all" ||
    key.startsWith("predownloaded_") ||
    key == "config_advanced" ||
    key == "config_fps_unlock" ||
    key == "config_metalHud" ||
    key == "config_proxyEnabled" ||
    key == "config_proxyHost" ||
    key == "config_retina" ||
    key == "config_block_net" ||
    key == "config_patch_off" ||
    key == "config_steam_patch" ||
    key == "config_timeout_fix" ||
    key == "config_resolution_custom" ||
    key == "config_resolution_width" ||
    key == "config_resolution_height" ||
    key == "config_hk4e_enable_hdr" ||
    key == "config_workaround3" ||
    key == "config_reshade" ||
    key == "left_cmd"
  );
}

function oldYaaglStorageAppsForNamespace(namespace: string | undefined) {
  switch (namespace) {
    case "hpgenshin":
      return ["Yaagl OS", "Yaagl"];
    case "hphsr":
      return ["Yaagl HSR OS", "Yaagl HSR"];
    case "hpzzz":
      return ["Yaagl ZZZ OS", "Yaagl ZZZ"];
    default:
      return undefined;
  }
}

function getNeutralinoStorageKey(key: string) {
  const namespacedKey =
    storageNamespace && shouldNamespaceStorageKey(key)
      ? `${storageNamespace}_${key}`
      : key;
  const validKey = namespacedKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (validKey.length <= 50) return validKey;
  const namespace = storageNamespace
    ? storageNamespace.replace(/[^a-zA-Z0-9_-]/g, "_")
    : "k";
  return `${namespace}_${storageKeyHash(validKey)}`.slice(0, 50);
}

function assertStorageKeyFormat(key: string) {
  if (!/^[a-zA-Z-_0-9]{1,50}$/.test(key)) {
    throw new Error(
      `Invalid storage key format. The key should match regex: ^[a-zA-Z-_0-9]{1,50}$ (${key})`
    );
  }
}

async function getOldYaaglStorageFile(appName: string, key: string) {
  assertStorageKeyFormat(key);
  const home = await env("HOME");
  return join(
    home,
    "Library",
    "Application Support",
    appName,
    ".storage",
    `${key}.neustorage`
  );
}

async function getOldYaaglStorageValue(appNames: string[], key: string) {
  for (const appName of appNames) {
    const path = await getOldYaaglStorageFile(appName, key);
    try {
      return await Neutralino.filesystem.readFile(path);
    } catch {
      // Try the next compatible old app storage location.
    }
  }
  throw new Error(`Unable to find storage key: ${key}`);
}

async function setOldYaaglStorageValue(
  appName: string,
  key: string,
  value: string | null
) {
  const path = await getOldYaaglStorageFile(appName, key);
  const storageDir = join(
    await env("HOME"),
    "Library",
    "Application Support",
    appName,
    ".storage"
  );
  await exec(["mkdir", "-p", storageDir]);
  if (value === null) {
    try {
      await Neutralino.filesystem.removeFile(path);
    } catch {
      // Already unset.
    }
    return;
  }
  await Neutralino.filesystem.writeFile(path, value);
}

function getOldYaaglStorageRoute(key: string) {
  if (!storageNamespace || !shouldNamespaceStorageKey(key)) return undefined;
  return oldYaaglStorageAppsForNamespace(storageNamespace);
}

export async function withStorageNamespace<T>(
  namespace: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = storageNamespace;
  storageNamespace = namespace;
  try {
    return await fn();
  } finally {
    storageNamespace = previous;
  }
}

export function activateStorageNamespace(namespace: string) {
  const previous = storageNamespace;
  storageNamespace = namespace;
  return () => {
    storageNamespace = previous;
  };
}

export async function getKey(key: string): Promise<string> {
  const oldYaaglStorageApps = getOldYaaglStorageRoute(key);
  if (oldYaaglStorageApps) {
    return await getOldYaaglStorageValue(oldYaaglStorageApps, key);
  }
  return await Neutralino.storage.getData(getNeutralinoStorageKey(key));
}

export async function getKeyOrDefault(
  key: string,
  defaultValue: string
): Promise<string> {
  try {
    return await getKey(key);
  } catch {
    return defaultValue;
  }
}

export async function setKey(key: string, value: string | null) {
  const oldYaaglStorageApps = getOldYaaglStorageRoute(key);
  if (oldYaaglStorageApps) {
    return await setOldYaaglStorageValue(oldYaaglStorageApps[0], key, value);
  }
  return await Neutralino.storage.setData(getNeutralinoStorageKey(key), value);
}

export function log(message: string) {
  return Neutralino.debug.log(message, "INFO");
}

export function warn(message: string) {
  return Neutralino.debug.log(message, "WARNING");
}

export function logerror(message: string) {
  return Neutralino.debug.log(message, "ERROR");
}

export function restart() {
  return Neutralino.app.restartProcess();
}

export async function fatal(error: unknown) {
  await Neutralino.os.showMessageBox(
    "Fatal error",
    `${error instanceof Error ? String(error) : JSON.stringify(error)}`,
    "OK"
  );
  await shutdown();
  Neutralino.app.exit(-1);
}

export async function appendFile(path: string, content: string) {
  await Neutralino.filesystem.appendFile(resolve(path), content);
}

export async function forceMove(source: string, destination: string) {
  return await exec([
    "mv",
    "-f",
    `${resolve(source)}`,
    `${resolve(destination)}`,
  ]);
}

export async function cp(source: string, destination: string) {
  return await exec([
    "cp",
    "-p",
    `${resolve(source)}`,
    `${resolve(destination)}`,
  ]);
}

export async function rmrf_dangerously(target: string) {
  return await exec(["rm", "-rf", target]);
}

export async function prompt(title: string, message: string) {
  const out = await Neutralino.os.showMessageBox(title, message, "YES_NO");
  return out == "YES";
}

export async function promptUpdate(
  title: string,
  message: string,
  cancelText: string,
  ignoreText: string,
  updateText: string
) {
  try {
    const script = `button returned of (display dialog "${message.replaceAll(
      '"',
      '\\"'
    )}" with title "${title.replaceAll(
      '"',
      '\\"'
    )}" buttons {"${ignoreText}", "${cancelText}", "${updateText}"} default button "${updateText}")`;
    const ret = await Neutralino.os.execCommand(`osascript -e '${script}'`, {});
    const val = ret.stdOut.trim();
    if (val === updateText) return "UPDATE";
    if (val === ignoreText) return "IGNORE";
    return "CANCEL";
  } catch (e) {
    const out = await Neutralino.os.showMessageBox(
      title,
      message,
      "YES_NO_CANCEL"
    );
    if (out == "YES") return "UPDATE";
    if (out == "NO") return "IGNORE";
    return "CANCEL";
  }
}

export async function alert(title: string, message: string) {
  return await Neutralino.os.showMessageBox(title, message, "OK");
}

export async function openDir(title: string) {
  const out = await Neutralino.os.showFolderDialog(title, {});
  return out;
}

export async function readFile(path: string) {
  return await Neutralino.filesystem.readFile(resolve(path));
}

export async function readBinary(path: string) {
  return await Neutralino.filesystem.readBinaryFile(resolve(path));
}

export async function readAllLines(path: string) {
  const content = await Neutralino.filesystem.readFile(resolve(path));
  if (content.indexOf("\r\n") >= 0) {
    return content.split("\r\n");
  }
  return content.split("\n");
}

export async function readAllLinesIfExists(path: string) {
  try {
    await stats(resolve(path));
  } catch {
    return [];
  }
  const content = await Neutralino.filesystem.readFile(resolve(path));
  if (content.indexOf("\r\n") >= 0) {
    return content.split("\r\n");
  }
  return content.split("\n");
}

export async function writeBinary(path: string, data: ArrayBuffer) {
  return await Neutralino.filesystem.writeBinaryFile(resolve(path), data);
}

export async function writeFile(path: string, data: string) {
  return await Neutralino.filesystem.writeFile(resolve(path), data);
}

export async function removeFile(path: string) {
  return await Neutralino.filesystem.removeFile(resolve(path));
}

export async function removeFileIfExists(path: string) {
  try {
    await stats(resolve(path));
  } catch {
    return;
  }
  return await Neutralino.filesystem.removeFile(resolve(path));
}

export async function stats(path: string) {
  return await Neutralino.filesystem.getStats(resolve(path));
}

export async function fileOrDirExists(path: string) {
  try {
    await stats(path);
    return true;
  } catch {
    return false;
  }
}

export async function env(key: string) {
  return Neutralino.os.getEnv(key);
}

export function exit(exitCode: number) {
  return Neutralino.app.exit(exitCode);
}

export function getMemoryInfo() {
  return Neutralino.computer.getMemoryInfo();
}

export function getCPUInfo() {
  return Neutralino.computer.getCPUInfo();
}

export function open(url: string) {
  return Neutralino.os.open(url);
}

export const sha1sum = async (message: string) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join(""); // convert bytes to hex string
  return hashHex;
};

const hooks: Array<(forced: boolean) => Promise<boolean>> = [];

export function addTerminationHook(fn: (forced: boolean) => Promise<boolean>) {
  hooks.push(fn);
  const len = hooks.length;
  return () => {
    if (hooks.length !== len) {
      throw new Error("Unexpected behavior!");
    }
    hooks.pop();
  };
}

// ??
export async function GLOBAL_onClose(forced: boolean) {
  for (const hook of hooks.reverse()) {
    if (!(await hook(forced)) && !forced) {
      return false; // aborted
    }
  }
  return true;
}

export async function shutdown() {
  for (const hook of hooks.reverse()) {
    await hook(true);
  }
}

export async function _safeRelaunch() {
  await shutdown();
  // await wait(1000);
  // HACK
  if (import.meta.env.PROD) {
    const app = await Neutralino.os.getEnv("PATH_LAUNCH");
    await Neutralino.os.execCommand(`open "${app}"`, {
      background: true,
    });
    Neutralino.app.exit(0);
  } else {
    Neutralino.app.restartProcess();
  }
}
