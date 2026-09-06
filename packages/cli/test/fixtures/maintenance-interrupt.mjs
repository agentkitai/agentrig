import { withMaintenanceSignal } from "../../dist/maintenance.js";

process.on("message", () => process.emit("SIGINT"));
try {
  await withMaintenanceSignal(signal => {
    process.send?.("ready");
    return new Promise((_, reject) => {
      if (process.argv[2] === "cooperative") signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
} catch (error) {
  console.error(error.message);
  console.error("remaining SIGINT listeners: " + process.listenerCount("SIGINT"));
  process.exitCode = error.name === "AbortError" ? 130 : 1;
  process.disconnect();
}
