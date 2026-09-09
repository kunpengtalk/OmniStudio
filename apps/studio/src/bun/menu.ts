import Electrobun from "electrobun/bun";
import { ApplicationMenu, Updater } from "electrobun/bun";
import { APP_NAME } from "./config";
import { updateState, checkForUpdate } from "./updates";

function getUpdateMenuItem() {
  switch (updateState.status) {
    case "checking":
      return { label: "Checking for Updates…", action: "check-for-updates", enabled: false };
    case "downloading":
      return {
        label: `Downloading v${updateState.newVersion}…`,
        action: "check-for-updates",
        enabled: false,
      };
    case "update-ready":
      return { label: "Restart & Update", action: "apply-update" };
    default:
      return { label: "Check for Updates…", action: "check-for-updates" };
  }
}

export const refreshMenu = () => {
  ApplicationMenu.setApplicationMenu([
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        getUpdateMenuItem(),
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
  ]);
};

export const createMenu = () => {
  refreshMenu();

  Electrobun.events.on("application-menu-clicked", (e) => {
    if (e.data.action === "check-for-updates") {
      checkForUpdate();
    } else if (e.data.action === "apply-update") {
      Updater.applyUpdate();
    }
  });
};
