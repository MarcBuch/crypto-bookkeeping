import process from "node:process";

const commands: Array<{ name: string; cmd: string[] }> = [
  { name: "api", cmd: ["bun", "run", "api:dev"] },
  { name: "web", cmd: ["bun", "run", "web"] },
];

const processes = commands.map(({ name, cmd }) => {
  const child = Bun.spawn(cmd, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  return { name, child };
});

let stopping = false;

function stopAll(signal: NodeJS.Signals = "SIGTERM") {
  if (stopping) return;
  stopping = true;

  for (const { child } of processes) {
    child.kill(signal);
  }
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));

const exits = processes.map(async ({ name, child }) => {
  const exitCode = await child.exited;
  if (!stopping && exitCode !== 0) {
    console.error(`${name} exited with code ${exitCode}`);
    stopAll();
    process.exitCode = exitCode;
  }
});

await Promise.all(exits);
