/**
 * In-app update flow (desktop build only).
 *
 * The Tauri updater plugin fetches `latest.json` from the endpoints listed in
 * src-tauri/tauri.conf.json, compares the version with the running app, verifies
 * the minisign signature against the embedded public key, downloads the NSIS
 * installer and runs it. We then relaunch.
 *
 * In the browser (`npm run dev`) none of this is available and every function
 * becomes a no-op so the UI can be developed without Tauri.
 */

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

export type UpdateProgress = (downloaded: number, total: number | undefined) => void;

type UpdaterModule = typeof import("@tauri-apps/plugin-updater");
type ProcessModule = typeof import("@tauri-apps/plugin-process");
type AppModule = typeof import("@tauri-apps/api/app");
type Update = Awaited<ReturnType<UpdaterModule["check"]>>;

let pending: Update | undefined;

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getAppVersion(): Promise<string> {
  if (!isDesktop()) return "dev";
  const app: AppModule = await import("@tauri-apps/api/app");
  return app.getVersion();
}

/** Returns update metadata when a newer release exists, otherwise undefined. */
export async function checkForUpdate(): Promise<UpdateInfo | undefined> {
  if (!isDesktop()) return undefined;
  const updater: UpdaterModule = await import("@tauri-apps/plugin-updater");
  const update = await updater.check();
  if (!update) {
    pending = undefined;
    return undefined;
  }
  pending = update;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    date: update.date,
    body: update.body,
  };
}

/** Download + install the update found by checkForUpdate(), then restart. */
export async function installUpdateAndRestart(onProgress?: UpdateProgress): Promise<void> {
  if (!pending) throw new Error("No update pending; call checkForUpdate() first");
  let downloaded = 0;
  let total: number | undefined;
  await pending.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? undefined;
        onProgress?.(0, total);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, total);
        break;
      case "Finished":
        onProgress?.(total ?? downloaded, total);
        break;
    }
  });
  const proc: ProcessModule = await import("@tauri-apps/plugin-process");
  await proc.relaunch();
}
