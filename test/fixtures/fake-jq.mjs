#!/usr/bin/env node

import fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "-n") {
  const values = {};
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "--arg") continue;
    values[args[index + 1]] = args[index + 2];
    index += 2;
  }
  process.stdout.write(
    `${JSON.stringify({
      lastBackupAt: values.promotedAt,
      backupAt: values.backupAt,
      promotedAt: values.promotedAt,
      key: values.key,
      runId: values.runId,
    })}\n`,
  );
  process.exit(0);
}

if (args[0] === "-r") {
  const input = fs.readFileSync(0, "utf8");
  const value = JSON.parse(input);
  process.stdout.write(`${typeof value.key === "string" ? value.key : ""}\n`);
  process.exit(0);
}

if (args[0] === "-e") {
  const filter = args[1] ?? "";
  const value = JSON.parse(fs.readFileSync(args[2], "utf8"));
  let matches = true;
  if (filter.includes('run-astraeos-12345678')) {
    matches &&= value.runId === "run-astraeos-12345678";
    matches &&= typeof value.key === "string" && value.key.startsWith("fixture/maps/astraeos/backups/");
    matches &&= /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.backupAt);
    matches &&= value.promotedAt === value.lastBackupAt;
  }
  if (filter.includes('newer-run')) matches &&= value.runId === "newer-run";
  process.exit(matches ? 0 : 1);
}

process.stderr.write(`Unsupported fake jq invocation: ${args.join(" ")}\n`);
process.exit(2);
