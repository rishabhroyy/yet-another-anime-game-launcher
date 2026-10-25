// fork: per-game storage namespaces for the HoYoPlay launcher, which hosts
// several games in one app. Upstream clients call getKey/setKey with shared
// key names ("game_install_dir", "patched", config_*); while a game's namespace
// is active those keys are prefixed, or routed to the matching standalone
// Yaagl app's storage so existing installs carry over.
// Kept out of neu.ts so upstream merges don't conflict; neu.ts only delegates
// getKey/setKey here.
import { join } from "path-browserify";
import { env, exec } from "./neu";

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

export async function namespacedGetKey(key: string): Promise<string> {
  const oldYaaglStorageApps = getOldYaaglStorageRoute(key);
  if (oldYaaglStorageApps) {
    return await getOldYaaglStorageValue(oldYaaglStorageApps, key);
  }
  return await Neutralino.storage.getData(getNeutralinoStorageKey(key));
}

export async function namespacedSetKey(key: string, value: string | null) {
  const oldYaaglStorageApps = getOldYaaglStorageRoute(key);
  if (oldYaaglStorageApps) {
    return await setOldYaaglStorageValue(oldYaaglStorageApps[0], key, value);
  }
  return await Neutralino.storage.setData(getNeutralinoStorageKey(key), value);
}
