import { execFile } from "node:child_process";

function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Logs the notification and shows it on the desktop where the system has a way to: macOS and Linux. */
export function desktopNotifier(log: (line: string) => void): (title: string, message: string) => void {
  return (title, message) => {
    log(`${title}: ${message}`);
    const ignore = () => {};
    if (process.platform === "darwin") {
      execFile(
        "osascript",
        ["-e", `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`],
        ignore,
      );
    } else if (process.platform === "linux") {
      execFile("notify-send", [title, message], ignore);
    }
  };
}
