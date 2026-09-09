import { Updater } from "electrobun";
import { getWindowRef } from "./window";
import { refreshMenu } from "./menu";
import { getSetting } from "./db/settings";

type UpdateStatus =
  | "checking"
  | "update-available"
  | "downloading"
  | "update-ready"
  | "no-update"
  | "error";

export interface UpdateInfo {
  status: UpdateStatus;
  currentVersion: string;
  newVersion?: string;
  error?: string;
}

// Update state
export const updateState: UpdateInfo = {
  status: "checking",
  currentVersion: "0.0.0",
};

export const broadcastUpdateStatus = () => {
  getWindowRef().webview.rpc!.send.updateStatus(updateState);
  refreshMenu();
};

// Check for updates
export const checkForUpdate = async () => {
  try {
    const localInfo = await Updater.getLocallocalInfo();
    updateState.currentVersion = localInfo.version;
    updateState.status = "checking";
    broadcastUpdateStatus();

    // Honor the UI-selected update channel when the platform supports it.
    const channel = getSetting("UPDATE_CHANNEL") || "stable";
    const updaterAny = Updater as unknown as Record<string, unknown>;
    if (typeof updaterAny.setChannel === "function") {
      try {
        (updaterAny.setChannel as (c: string) => void).call(Updater, channel);
      } catch {
        // fall through to default channel
      }
    }

    console.log(`Current version: ${localInfo.version} (${localInfo.channel})`);

    const updateInfo = await Updater.checkForUpdate();

    if (updateInfo.error) {
      console.log(`Update check error: ${updateInfo.error}`);
      updateState.status = "error";
      updateState.error = updateInfo.error;
      broadcastUpdateStatus();
      return;
    }

    if (updateInfo.updateAvailable) {
      console.log(`Update available: ${updateInfo.version}`);
      updateState.status = "update-available";
      updateState.newVersion = updateInfo.version;
      broadcastUpdateStatus();

      // Start downloading
      updateState.status = "downloading";
      broadcastUpdateStatus();

      await Updater.downloadUpdate();

      if (Updater.updateInfo().updateReady) {
        console.log("Update downloaded and ready to install");
        updateState.status = "update-ready";
        broadcastUpdateStatus();
      } else {
        console.log("Update download failed");
        updateState.status = "error";
        updateState.error = "Download failed";
        broadcastUpdateStatus();
      }
    } else {
      console.log("No update available");
      updateState.status = "no-update";
      broadcastUpdateStatus();
    }
  } catch (err: any) {
    console.log(`Update check failed: ${err.message}`);
    updateState.status = "error";
    updateState.error = err.message;
    broadcastUpdateStatus();
  }
};
