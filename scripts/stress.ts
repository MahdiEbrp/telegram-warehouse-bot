import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runStress } from "../src/tests/helpers/stress-runner";

const args = process.argv.slice(2);
function argument(name: string, fallback: string) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? "");
}
const users = Number(argument("--users", "50")),
  updates = Number(argument("--updates", "5000"));
const destination = resolve(
  argument("--output", `docs/verification/stress-${users}x${updates}.json`),
);
try {
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { force: true }); // Never leave an old successful report after a failed rerun.
  console.log(
    `OFFLINE ONLY: ${users} virtual users / ${updates} synthetic updates; no credentials or Telegram requests.`,
  );
  const report = await runStress({
    users,
    updates,
    progress: (done, total) => console.log(`Completed ${done}/${total}`),
  });
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        ...report.result,
        invariants: report.invariants,
        report: destination,
      },
      null,
      2,
    ),
  );
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
