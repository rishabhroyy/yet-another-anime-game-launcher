import { Aria2 } from "@aria2";
import { CommonUpdateProgram } from "@common-update-ui";
import { createConfiguration } from "@config";
import { Locale } from "@locale";
import {
  activateStorageNamespace,
  fatal,
  humanDuration,
  humanFileSize,
  open,
  openDir,
  withStorageNamespace,
} from "@utils";
import { Wine } from "@wine";
import {
  Button,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Progress,
  ProgressIndicator,
} from "@hope-ui/solid";
import { Accessor, For, JSXElement, Show, createSignal } from "solid-js";
import { createGameInstallationDirectorySanitizer } from "../accidental-complexity";
import { ChannelClient } from "../channel-client";
import { Config } from "../config/config-def";
import type { Github } from "../github";
import { createClient as createGenshinClient } from "../clients/hk4eos";
import { createClient as createHsrClient } from "../clients/hkrpgos";
import { createClient as createZzzClient } from "../clients/napos";
import genshinFallbackIcon from "../assets/Nahida.cr.png";
import hsrFallbackIcon from "../icons/March7th.cr.png";
import zzzFallbackIcon from "../icons/ZZZ_Bang.cr.png";
import { createHoyoplayTaskQueueState } from "./hoyoplay-task-queue";
import {
  applyHsrFpsRegistry,
  createDelayedCompanion,
  ensureGenshinFpsUnlocker,
  getFpsConfig,
  setFpsConfig,
  startGenshinFpsUnlockScript,
  withD3DMetalPerformanceEnv,
  withDxmtPreferredMaxFrameRate,
  withWineExec2Transform,
} from "./hoyoplay-injections";
import {
  createHoyoplayWineProxy,
  ensureHoyoplayGameWine,
  ensureHoyoplayD3DMetalRuntime,
  getHoyoplayD3DMetalPath,
  getHoyoplayGameWineTag,
  getHoyoplayGameRenderer,
  getHoyoplayWineBin,
  getHoyoplayWineOptions,
  HOYOPLAY_RENDERER_D3DMETAL,
  HOYOPLAY_RENDERER_DXMT,
  setHoyoplayGameRenderer,
  setHoyoplayGameWineTag,
  SHARED_WINE_TAG,
  type HoyoplayWineRef,
  type HoyoplayRenderer,
} from "./hoyoplay-wine";

type HoyoplayGameId = "genshin" | "hsr" | "zzz";

type GameState = {
  id: HoyoplayGameId;
  namespace: string;
  title: string;
  client: ChannelClient;
  config: Config;
  ConfigurationUI: (props: {
    onClose: (action: "check-integrity" | "close") => void;
  }) => JSXElement;
  fallbackIcon: string;
  fpsSupported: boolean;
  fpsEnabled: Accessor<boolean>;
  setFpsEnabled: (value: boolean) => void;
  fpsTarget: Accessor<string>;
  setFpsTarget: (value: string) => void;
  wineRef: HoyoplayWineRef;
  wineTag: Accessor<string>;
  setWineTag: (value: string) => void;
  renderer: Accessor<HoyoplayRenderer>;
  setRenderer: (value: HoyoplayRenderer) => void;
  wineOptions: {
    tag: string;
    displayName: string;
    url: string;
  }[];
};

function sanitizeFps(value: string) {
  const fps = Math.trunc(Number(value));
  return Number.isFinite(fps) && fps > 0 ? fps : 120;
}

function namespacedProgram(
  aria2: Aria2,
  baseWine: Wine,
  game: GameState,
  d3dmetalPath: Accessor<string>,
  program: () => CommonUpdateProgram
): () => CommonUpdateProgram {
  return async function* () {
    game.wineRef.current = yield* ensureHoyoplayGameWine({
      aria2,
      baseWine,
      gameId: game.id,
      wineTag: game.wineTag(),
      renderer: game.renderer(),
      d3dmetalPath: d3dmetalPath(),
    });
    const iterator = await withStorageNamespace(game.namespace, async () =>
      program()
    );
    while (true) {
      const result = await withStorageNamespace(game.namespace, async () =>
        iterator.next()
      );
      if (result.done) return;
      yield result.value;
    }
  };
}

export async function createHoyoplayLauncher({
  wine,
  locale,
  aria2,
  github,
  onCheckUpdate,
}: {
  wine: Wine;
  locale: Locale;
  aria2: Aria2;
  github: Github;
  onCheckUpdate: () => void;
}) {
  const baseWine = wine;
  const initialD3DMetalPath = await getHoyoplayD3DMetalPath();
  const [d3dmetalPath, setD3DMetalPath] = createSignal(initialD3DMetalPath);
  const specs = [
    {
      id: "genshin" as const,
      namespace: "hpgenshin",
      title: "Genshin Impact",
      fallbackIcon: genshinFallbackIcon,
      fpsSupported: true,
      createClient: createGenshinClient,
    },
    {
      id: "hsr" as const,
      namespace: "hphsr",
      title: "Honkai: Star Rail",
      fallbackIcon: hsrFallbackIcon,
      fpsSupported: true,
      createClient: createHsrClient,
    },
    {
      id: "zzz" as const,
      namespace: "hpzzz",
      title: "Zenless Zone Zero",
      fallbackIcon: zzzFallbackIcon,
      fpsSupported: false,
      createClient: createZzzClient,
    },
  ];

  const games: GameState[] = [];

  for (const spec of specs) {
    const wineRef: HoyoplayWineRef = { current: baseWine };
    const gameWine = createHoyoplayWineProxy(wineRef);
    const client = await withStorageNamespace(spec.namespace, async () =>
      spec.createClient({ wine: gameWine, aria2, locale })
    );
    const { UI: ConfigurationUI, config } = await withStorageNamespace(
      spec.namespace,
      async () =>
        createConfiguration({
          wine: gameWine,
          locale,
          gameInstallDir: client.installDir,
          configForChannelClient: client.createConfig,
          onCheckUpdate,
        })
    );
    const fps = await getFpsConfig(spec.id);
    const [fpsEnabled, setFpsEnabled] = createSignal(fps.enabled);
    const [fpsTarget, setFpsTarget] = createSignal(String(fps.target));
    const initialWineTag = await getHoyoplayGameWineTag(spec.id);
    const [wineTag, setWineTag] = createSignal(initialWineTag);
    const initialRenderer = await getHoyoplayGameRenderer(spec.id);
    const [renderer, setRenderer] =
      createSignal<HoyoplayRenderer>(initialRenderer);
    const wineOptions = await getHoyoplayWineOptions(initialWineTag);

    games.push({
      ...spec,
      client,
      config: config as Config,
      ConfigurationUI,
      fpsEnabled,
      setFpsEnabled,
      fpsTarget,
      setFpsTarget,
      wineRef,
      wineTag,
      setWineTag,
      renderer,
      setRenderer,
      wineOptions,
    });
  }

  const { selectPath } = await createGameInstallationDirectorySanitizer({
    openFolderDialog: async () =>
      await openDir(locale.get("SELECT_INSTALLATION_DIR")),
    locale,
  });

  function launchProgram(game: GameState): CommonUpdateProgram {
    return (async function* () {
      const fpsEnabled = game.fpsSupported && game.fpsEnabled();
      const fpsTarget = sanitizeFps(game.fpsTarget());
      const activeWine = game.wineRef.current;
      const renderer = game.renderer();

      if (
        renderer === HOYOPLAY_RENDERER_D3DMETAL &&
        game.wineTag() === SHARED_WINE_TAG
      ) {
        throw new Error(
          "D3DMetal requires a per-game Wine selection. Choose a Wine version instead of Shared launcher Wine so the shared YAAGL runtime stays untouched."
        );
      }
      if (renderer === HOYOPLAY_RENDERER_D3DMETAL) {
        const runtimePath = yield* ensureHoyoplayD3DMetalRuntime({
          aria2,
          github,
        });
        setD3DMetalPath(runtimePath);
      }

      if (game.id === "genshin" && fpsEnabled) {
        yield* ensureGenshinFpsUnlocker(aria2, activeWine);
      }
      if (game.id === "hsr" && fpsEnabled) {
        yield ["setStateText", "PATCHING"];
        await applyHsrFpsRegistry(activeWine, fpsTarget);
      }

      const shouldTransformEnv =
        renderer === HOYOPLAY_RENDERER_D3DMETAL ||
        (fpsEnabled && (game.id === "genshin" || game.id === "hsr"));
      let fpsUnlockerEnv: Record<string, string> = {};
      const fpsUnlockerCompanion =
        game.id === "genshin" && fpsEnabled
          ? createDelayedCompanion(async () => {
              const launchEnv = fpsUnlockerEnv;
              const unlockerWineBin = await getHoyoplayWineBin(
                game.id,
                game.wineTag()
              );
              return startGenshinFpsUnlockScript(
                activeWine,
                fpsTarget,
                unlockerWineBin,
                launchEnv
              );
            })
          : undefined;
      const launchWithEnv = () =>
        shouldTransformEnv
          ? withWineExec2Transform(
              activeWine,
              env => {
                const d3dmetalEnv =
                  renderer === HOYOPLAY_RENDERER_D3DMETAL
                    ? withD3DMetalPerformanceEnv(env)
                    : env;
                return fpsEnabled && renderer === HOYOPLAY_RENDERER_DXMT
                  ? withDxmtPreferredMaxFrameRate(d3dmetalEnv, fpsTarget)
                  : d3dmetalEnv;
              },
              () => game.client.launch(game.config),
              fpsUnlockerCompanion && {
                start(env) {
                  fpsUnlockerEnv = env;
                  fpsUnlockerCompanion.schedule();
                },
                stop() {
                  return fpsUnlockerCompanion.stop();
                },
              }
            )
          : game.client.launch(game.config);

      try {
        yield* launchWithEnv();
      } finally {
        await fpsUnlockerCompanion?.stop();
      }
    })();
  }

  return function HoyoplayLauncher() {
    const [selectedGameIndex, setSelectedGameIndex] = createSignal(0);
    const selectedGame = () => games[selectedGameIndex()];
    const [settingsOpen, setSettingsOpen] = createSignal(false);
    const [nativeSettingsGame, setNativeSettingsGame] =
      createSignal<GameState>();
    const [videoLoaded, setVideoLoaded] = createSignal(false);
    let restoreNativeSettingsNamespace: (() => void) | undefined;
    const [
      statusText,
      progress,
      programBusy,
      taskQueue,
      downloadEta,
      estimatedSpeedBps,
      setPendingSizeBytes,
    ] = createHoyoplayTaskQueueState({ locale });

    games.forEach(game => {
      // Skip the startup patch-revert/integrity-check pass for a game that's
      // already known to need an update: repairing a stale install against
      // the latest manifest aborts instead of prompting to update.
      if (game.client.updateRequired()) return;
      taskQueue.next(
        namespacedProgram(aria2, baseWine, game, d3dmetalPath, () =>
          game.client.init(game.config)
        )
      );
    });

    async function saveWineSettings(game: GameState) {
      await setHoyoplayGameWineTag(game.id, game.wineTag());
    }

    async function saveRendererSettings(game: GameState) {
      await setHoyoplayGameRenderer(game.id, game.renderer());
    }

    async function saveFpsSettings(game: GameState) {
      const fps = sanitizeFps(game.fpsTarget());
      game.setFpsTarget(String(fps));
      await setFpsConfig(game.id, game.fpsEnabled(), String(fps));
    }

    async function onPrimaryAction() {
      if (programBusy()) return;
      const game = selectedGame();
      await saveWineSettings(game);
      await saveRendererSettings(game);
      await saveFpsSettings(game);

      if (game.client.installState() === "INSTALLED") {
        if (game.client.updateRequired()) {
          setPendingSizeBytes(game.client.updateSizeBytes?.() ?? 0);
          taskQueue.next(
            namespacedProgram(aria2, baseWine, game, d3dmetalPath, () =>
              game.client.update()
            )
          );
        } else {
          taskQueue.next(
            namespacedProgram(aria2, baseWine, game, d3dmetalPath, () =>
              launchProgram(game)
            )
          );
        }
      } else {
        const selection = await selectPath();
        if (!selection) return;
        taskQueue.next(
          namespacedProgram(aria2, baseWine, game, d3dmetalPath, () =>
            game.client.install(selection)
          )
        );
      }
    }

    function actionLabel(game: GameState) {
      if (game.client.installState() !== "INSTALLED") return "Get Game";
      if (!game.client.updateRequired()) return "Start Game";
      const sizeBytes = game.client.updateSizeBytes?.() ?? 0;
      if (sizeBytes <= 0) return locale.get("UPDATE");
      const speedBps = estimatedSpeedBps();
      const etaSuffix =
        speedBps > 0 ? `, ~${humanDuration(sizeBytes / speedBps)}` : "";
      return `${locale.get("UPDATE")} (${humanFileSize(sizeBytes)}${etaSuffix})`;
    }

    function selectedInstallLabel() {
      const game = selectedGame();
      if (game.client.installState() !== "INSTALLED") return "Not installed";
      return game.client.updateRequired() ? "Update available" : "Ready";
    }

    function selectGame(index: number) {
      setSelectedGameIndex(index);
      setVideoLoaded(false);
    }

    function onPredownload() {
      const game = selectedGame();
      taskQueue.next(
        namespacedProgram(aria2, baseWine, game, d3dmetalPath, () =>
          game.client.predownload()
        )
      );
    }

    function openNativeSettings(game: GameState) {
      restoreNativeSettingsNamespace?.();
      restoreNativeSettingsNamespace = activateStorageNamespace(game.namespace);
      setNativeSettingsGame(game);
    }

    function closeNativeSettings() {
      restoreNativeSettingsNamespace?.();
      restoreNativeSettingsNamespace = undefined;
      setNativeSettingsGame(undefined);
    }

    return (
      <div
        class="hoyoplay-shell"
        style={{
          "background-image": selectedGame().client.uiContent.background
            ? `url(${selectedGame().client.uiContent.background})`
            : undefined,
        }}
      >
        <Show when={selectedGame().client.uiContent.background_video}>
          <video
            class="hoyoplay-video"
            src={selectedGame().client.uiContent.background_video}
            autoplay
            loop
            muted
            playsinline
            onLoadedData={() => setVideoLoaded(true)}
            style={{ opacity: videoLoaded() ? 1 : 0 }}
          />
        </Show>
        <Show when={selectedGame().client.uiContent.background_theme}>
          <div
            class="hoyoplay-theme"
            style={{
              "background-image": `url(${
                selectedGame().client.uiContent.background_theme
              })`,
            }}
          />
        </Show>

        <aside class="hoyoplay-game-rail">
          <button class="hoyoplay-orbit-button" aria-label="HoYoPlay">
            <span />
          </button>
          <div class="hoyoplay-game-icons">
            <For each={games}>
              {(game, index) => (
                <button
                  classList={{
                    "hoyoplay-game-icon": true,
                    active: selectedGameIndex() === index(),
                  }}
                  aria-label={game.title}
                  onClick={() => selectGame(index())}
                >
                  <img
                    src={game.client.uiContent.iconImage ?? game.fallbackIcon}
                    alt=""
                  />
                  <span
                    classList={{
                      "hoyoplay-installed-dot": true,
                      installed: game.client.installState() === "INSTALLED",
                    }}
                  />
                </button>
              )}
            </For>
          </div>
        </aside>

        <main class="hoyoplay-stage" aria-label={selectedGame().title}>
          <div class="hoyoplay-top-actions">
            <button
              class="hoyoplay-icon-button"
              aria-label="Open official page"
              onClick={() => open(selectedGame().client.uiContent.url)}
            >
              <span class="hoyoplay-link-icon" />
            </button>
            <button
              class="hoyoplay-icon-button"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <span class="hoyoplay-settings-icon" />
            </button>
          </div>
        </main>

        <section class="hoyoplay-action-area">
          <Show when={programBusy()}>
            <div class="hoyoplay-progress">
              <strong>
                {statusText()}
                {downloadEta() ? ` — ETA ${downloadEta()}` : ""}
              </strong>
              <Progress
                value={progress()}
                indeterminate={progress() === 0}
                size="sm"
                borderRadius={8}
              >
                <ProgressIndicator
                  style={"transition: none;"}
                  borderRadius={8}
                />
              </Progress>
            </div>
          </Show>
          <Show
            when={
              selectedGame().client.showPredownloadPrompt() && !programBusy()
            }
          >
            <button class="hoyoplay-secondary-button" onClick={onPredownload}>
              Pre-download {selectedGame().client.predownloadVersion()}
            </button>
          </Show>
          <button
            class="hoyoplay-primary-button"
            disabled={programBusy()}
            onClick={() => onPrimaryAction().catch(fatal)}
          >
            <span
              classList={{
                "hoyoplay-action-icon": true,
                download: selectedGame().client.installState() !== "INSTALLED",
              }}
            />
            <span class="hoyoplay-action-copy">
              <span>{actionLabel(selectedGame())}</span>
              <small>{selectedInstallLabel()}</small>
            </span>
          </button>
          <button
            class="hoyoplay-menu-button"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <span class="hoyoplay-menu-icon" />
          </button>
        </section>

        <Modal opened={settingsOpen()} onClose={() => setSettingsOpen(false)}>
          <ModalOverlay />
          <ModalContent width={620} maxWidth={620}>
            <ModalCloseButton />
            <ModalHeader>{selectedGame().title}</ModalHeader>
            <ModalBody>
              <label class="hoyoplay-setting-row">
                <span>Wine</span>
                <select
                  value={selectedGame().wineTag()}
                  onInput={event =>
                    selectedGame().setWineTag(event.currentTarget.value)
                  }
                >
                  <For each={selectedGame().wineOptions}>
                    {item => (
                      <option value={item.tag}>{item.displayName}</option>
                    )}
                  </For>
                </select>
              </label>
              <p class="hoyoplay-settings-muted">
                Shared uses the launcher Wine. Per-game selections are cached
                under <code>Application Support/Yaagl OS/hoyoplay-wines</code>{" "}
                and still use the shared <code>wineprefix</code>.
              </p>
              <label class="hoyoplay-setting-row">
                <span>Renderer</span>
                <select
                  value={selectedGame().renderer()}
                  onInput={event =>
                    selectedGame().setRenderer(
                      event.currentTarget.value as HoyoplayRenderer
                    )
                  }
                >
                  <option value={HOYOPLAY_RENDERER_DXMT}>DXMT</option>
                  <option value={HOYOPLAY_RENDERER_D3DMETAL}>
                    D3DMetal (experimental)
                  </option>
                </select>
              </label>
              <Show
                when={selectedGame().renderer() === HOYOPLAY_RENDERER_D3DMETAL}
              >
                <p class="hoyoplay-settings-muted">
                  D3DMetal is downloaded automatically on first launch and
                  applied only to per-game Wine, so the shared YAAGL Wine stays
                  compatible with older launchers. Cached under{" "}
                  <code>Application Support/Yaagl OS/hoyoplay-renderers</code>.
                </p>
              </Show>
              <Show
                when={selectedGame().fpsSupported}
                fallback={
                  <p class="hoyoplay-settings-muted">
                    FPS unlock is not wired for this game yet.
                  </p>
                }
              >
                <label class="hoyoplay-setting-row">
                  <span>FPS unlock</span>
                  <input
                    type="checkbox"
                    checked={selectedGame().fpsEnabled()}
                    onInput={event =>
                      selectedGame().setFpsEnabled(event.currentTarget.checked)
                    }
                  />
                </label>
                <label class="hoyoplay-setting-row">
                  <span>Target FPS</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={selectedGame().fpsTarget()}
                    onInput={event =>
                      selectedGame().setFpsTarget(event.currentTarget.value)
                    }
                  />
                </label>
                <p class="hoyoplay-settings-muted">
                  Off keeps DXMT at upstream 60 FPS. On sets DXMT when the DXMT
                  renderer is active, and always applies the game unlock method.
                </p>
              </Show>
            </ModalBody>
            <ModalFooter gap="$3">
              <Button
                variant="ghost"
                onClick={() => {
                  setSettingsOpen(false);
                  openNativeSettings(selectedGame());
                }}
              >
                Advanced YAAGL Settings
              </Button>
              <Button
                onClick={() =>
                  Promise.all([
                    saveWineSettings(selectedGame()),
                    saveRendererSettings(selectedGame()),
                    saveFpsSettings(selectedGame()),
                  ]).then(() => setSettingsOpen(false))
                }
              >
                Save
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>

        <Modal
          opened={!!nativeSettingsGame()}
          onClose={closeNativeSettings}
          scrollBehavior="inside"
        >
          <ModalOverlay />
          <Show when={nativeSettingsGame()}>
            {game => {
              const UI = game().ConfigurationUI;
              return (
                <UI
                  onClose={action => {
                    const savedGame = game();
                    closeNativeSettings();
                    if (action === "check-integrity") {
                      taskQueue.next(
                        namespacedProgram(
                          aria2,
                          baseWine,
                          savedGame,
                          d3dmetalPath,
                          () => savedGame.client.checkIntegrity()
                        )
                      );
                    }
                  }}
                />
              );
            }}
          </Show>
        </Modal>
      </div>
    );
  };
}
