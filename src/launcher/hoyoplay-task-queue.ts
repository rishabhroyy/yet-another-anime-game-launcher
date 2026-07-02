import { CommonUpdateProgram } from "@common-update-ui";
import { Locale } from "@locale";
import { alert, humanDuration } from "@utils";
import { createSignal } from "solid-js";

// fork-exclusive: hoyoplay launcher's own copy of launcher/task-queue.ts.
// Kept separate (instead of editing the shared upstream file) so automatic
// upstream merges never conflict here. Differences from upstream:
//   - errors are shown via a dismissible alert instead of fatal()+app exit
//   - tracks an ETA string derived from setProgress deltas over time
//   - remembers the last observed download speed so the size/ETA can be
//     shown on the update button before the user presses it
export function createHoyoplayTaskQueueState({ locale }: { locale: Locale }) {
  const [statusText, setStatusText] = createSignal("");
  const [progress, setProgress] = createSignal(0);
  const [eta, setEta] = createSignal("");
  const [programBusy, setBusy] = createSignal(false);
  const [estimatedSpeedBps, setEstimatedSpeedBps] = createSignal(0);

  let etaTrackingSince: number | null = null;
  let etaTrackingFromProgress = 0;
  let runStartedAt = 0;
  let pendingSizeBytes = 0;

  // Call right before queuing a task whose total download size is known, so
  // that once it finishes we can derive bytes/sec for future pre-press ETAs.
  function setPendingSizeBytes(bytes: number) {
    pendingSizeBytes = bytes;
  }

  function resetEtaTracking() {
    etaTrackingSince = null;
    setEta("");
  }

  function trackProgress(percent: number) {
    if (percent <= 0) {
      resetEtaTracking();
      setProgress(percent);
      return;
    }
    const now = Date.now();
    if (etaTrackingSince === null) {
      etaTrackingSince = now;
      etaTrackingFromProgress = percent;
    } else {
      const elapsedSeconds = (now - etaTrackingSince) / 1000;
      const progressDelta = percent - etaTrackingFromProgress;
      if (elapsedSeconds > 1 && progressDelta > 0.5) {
        const remainingSeconds =
          ((100 - percent) / progressDelta) * elapsedSeconds;
        setEta(humanDuration(remainingSeconds));
      }
    }
    setProgress(percent);
  }

  const taskQueue: AsyncGenerator<unknown, void, () => CommonUpdateProgram> =
    (async function* () {
      while (true) {
        const task = yield 0;
        setBusy(true);
        resetEtaTracking();
        const sizeBytes = pendingSizeBytes;
        pendingSizeBytes = 0;
        runStartedAt = Date.now();
        try {
          for await (const text of task()) {
            switch (text[0]) {
              case "setProgress":
                trackProgress(text[1]);
                break;
              case "setUndeterminedProgress":
                resetEtaTracking();
                setProgress(0);
                break;
              case "setStateText":
                setStatusText(locale.format(text[1], text.slice(2)));
                break;
            }
          }
          const elapsedSeconds = (Date.now() - runStartedAt) / 1000;
          if (sizeBytes > 0 && elapsedSeconds > 2) {
            setEstimatedSpeedBps(sizeBytes / elapsedSeconds);
          }
        } catch (e) {
          await alert(
            "Error",
            e instanceof Error ? e.message : JSON.stringify(e)
          );
        }
        setBusy(false);
        resetEtaTracking();
      }
    })();
  taskQueue.next(); // ignored anyway

  return [
    statusText,
    progress,
    programBusy,
    taskQueue,
    eta,
    estimatedSpeedBps,
    setPendingSizeBytes,
  ] as const;
}
