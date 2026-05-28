import { Aria2 } from "@aria2";
import { CommonUpdateProgram } from "@common-update-ui";
import { createConfiguration } from "@config";
import { Locale } from "@locale";
import {
  activateStorageNamespace,
  fatal,
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
import { createClient as createGenshinClient } from "../clients/hk4eos";
import { createClient as createHsrClient } from "../clients/hkrpgos";
import { createClient as createZzzClient } from "../clients/napos";
import genshinFallbackIcon from "../assets/Nahida.cr.png";
import hsrFallbackIcon from "../icons/March7th.cr.png";
import zzzFallbackIcon from "../icons/ZZZ_Bang.cr.png";
import { createTaskQueueState } from "./task-queue";
import {
  applyHsrFpsRegistry,
  ensureGenshinFpsUnlocker,
  getFpsConfig,
  setFpsConfig,
  startGenshinFpsUnlockScript,
  withDxmtPreferredMaxFrameRate,
  withWineExec2Transform,
} from "./hoyoplay-injections";
import {
  createHoyoplayWineProxy,
  ensureHoyoplayGameWine,
  getHoyoplayGameWineTag,
  getHoyoplayWineBin,
  getHoyoplayWineOptions,
  setHoyoplayGameWineTag,
  type HoyoplayWineRef,
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
  program: () => CommonUpdateProgram
): () => CommonUpdateProgram {
  return async function* () {
    game.wineRef.current = yield* ensureHoyoplayGameWine({
      aria2,
      baseWine,
      gameId: game.id,
      wineTag: game.wineTag(),
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
  onCheckUpdate,
}: {
  wine: Wine;
  locale: Locale;
  aria2: Aria2;
  onCheckUpdate: () => void;
}) {
  const baseWine = wine;
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

      if (game.id === "genshin" && fpsEnabled) {
        yield* ensureGenshinFpsUnlocker(aria2, activeWine);
      }
      if (game.id === "hsr" && fpsEnabled) {
        yield ["setStateText", "PATCHING"];
        await applyHsrFpsRegistry(activeWine, fpsTarget);
      }

      if (fpsEnabled && (game.id === "genshin" || game.id === "hsr")) {
        const unlockerWineBin =
          game.id === "genshin"
            ? await getHoyoplayWineBin(game.id, game.wineTag())
            : undefined;

        yield* withWineExec2Transform(
          activeWine,
          env => withDxmtPreferredMaxFrameRate(env, fpsTarget),
          () => game.client.launch(game.config),
          game.id === "genshin"
            ? () =>
                startGenshinFpsUnlockScript(
                  activeWine,
                  fpsTarget,
                  unlockerWineBin
                )
            : undefined
        );
      } else {
        yield* game.client.launch(game.config);
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
    const [statusText, progress, programBusy, taskQueue] = createTaskQueueState(
      { locale }
    );

    games.forEach(game =>
      taskQueue.next(
        namespacedProgram(aria2, baseWine, game, () =>
          game.client.init(game.config)
        )
      )
    );

    async function saveWineSettings(game: GameState) {
      await setHoyoplayGameWineTag(game.id, game.wineTag());
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
      await saveFpsSettings(game);

      if (game.client.installState() === "INSTALLED") {
        if (game.client.updateRequired()) {
          taskQueue.next(
            namespacedProgram(aria2, baseWine, game, () => game.client.update())
          );
        } else {
          taskQueue.next(
            namespacedProgram(aria2, baseWine, game, () => launchProgram(game))
          );
        }
      } else {
        const selection = await selectPath();
        if (!selection) return;
        taskQueue.next(
          namespacedProgram(aria2, baseWine, game, () =>
            game.client.install(selection)
          )
        );
      }
    }

    function actionLabel(game: GameState) {
      if (game.client.installState() !== "INSTALLED") return "Get Game";
      return game.client.updateRequired() ? locale.get("UPDATE") : "Start Game";
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
        namespacedProgram(aria2, baseWine, game, () =>
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
              <strong>{statusText()}</strong>
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
                  Off keeps DXMT at upstream 60 FPS. On sets DXMT and the game
                  unlock method to this integer.
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
                    closeNativeSettings();
                    if (action === "check-integrity") {
                      taskQueue.next(
                        namespacedProgram(aria2, baseWine, game(), () =>
                          game().client.checkIntegrity()
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
