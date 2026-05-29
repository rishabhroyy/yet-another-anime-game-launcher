import { WebSocket as RPC } from "libaria2-ts";
import { log, sha256_16, wait, timeout } from "./utils";

export async function createAria2({
  host,
  port,
}: {
  host: string;
  port: number;
}) {
  await wait(500); // FIXME:
  const rpc = new RPC.Client({
    host,
    port,
  });
  const version = await Promise.race([rpc.getVersion(), timeout(3000)]);

  function shutdown() {
    return rpc.shutdown();
  }

  async function* doStreaming(gid: string) {
    let unknownLengthStartedAt = Date.now();
    while (true) {
      const status = await rpc.tellStatus(gid);
      if (status.status == "complete") {
        break;
      }
      if (status.status == "error" || status.status == "removed") {
        throw new Error(
          `Download failed (${status.status})${
            status.errorMessage ? `: ${status.errorMessage}` : ""
          }`
        );
      }
      if (status.status == "paused") {
        await rpc.unpause(gid);
        await wait(500);
        continue;
      }
      if (status.totalLength == BigInt(0)) {
        if (Date.now() - unknownLengthStartedAt > 60000) {
          throw new Error(
            `Download did not start within 60 seconds (aria2 status: ${status.status})`
          );
        }
        await wait(500);
        continue;
      }
      unknownLengthStartedAt = Date.now();
      yield status;
      await wait(100);
    }
  }

  async function* doStreamingDownload(options: {
    uri: string;
    absDst: string;
  }) {
    const gid = await sha256_16(`${options.uri}:${options.absDst}`);
    async function addDownload() {
      await rpc.addUri(options.uri, {
        gid,
        "max-connection-per-server": 16,
        pause: false,
        out: options.absDst,
        continue: false,
        "allow-overwrite": true, // in case control file broken
      });
      try {
        await rpc.unpause(gid);
      } catch {
        // It may already be active depending on aria2's global pause state.
      }
    }

    try {
      const status = await rpc.tellStatus(gid);
      if (status.status == "paused") {
        await rpc.unpause(gid);
      } else if (status.status == "complete") {
        return;
      } else if (status.status == "active" || status.status == "waiting") {
        // Continue tracking the existing download below.
      } else if (status.status == "error" || status.status == "removed") {
        try {
          await rpc.removeDownloadResult(gid);
        } catch {
          // It may have disappeared between tellStatus and cleanup.
        }
        await addDownload();
      } else {
        throw new Error(`Download is in unexpected state: ${status.status}`);
      }
    } catch (e: unknown) {
      if (typeof e == "object" && e != null && "code" in e && e["code"] == 1) {
        await addDownload();
      } else {
        throw e;
      }
    }
    return yield* doStreaming(gid);
  }

  return {
    version,
    shutdown,
    doStreamingDownload,
  };
}

export type Aria2 = ReturnType<typeof createAria2> extends Promise<infer T>
  ? T
  : never;

export async function createAria2Retry({
  host,
  port,
}: {
  host: string;
  port: number;
}): Promise<Aria2> {
  for (let i = 0; i < 30; i++) {
    try {
      return await createAria2({ host, port });
    } catch (e) {
      await log("Fail to create aria2 rpc, retrying... " + e);
    }
  }
  throw new Error("Fail to create aria2 rpc");
}
