import fs from "node:fs";

// The logs folder of the server that the tests run against
const logsPath =
  process.env.TEST_LOGS_DIR || new URL("../../logs", import.meta.url).pathname;

// The path of a log file of today (the logs are in a folder for every day, in UTC)
const logFile = (name: string): string =>
  `${logsPath}/${new Date().toISOString().slice(0, 10)}/${name}`;

// How long a log file is right now, so we can tell later what was added to it
export const logSize = (name: string): number => {
  try {
    return fs.statSync(logFile(name)).size;
  } catch {
    return 0;
  }
};

// Waits until some text shows up in a log file (after the given position), and returns
// everything that was added to the file by then. The server writes its logs in the background.
export const waitForLog = async (
  name: string,
  text: string,
  from = 0
): Promise<string> => {
  let added = "";

  for (let i = 0; i < 100; i++) {
    try {
      added = fs.readFileSync(logFile(name), "utf8").slice(from);
    } catch {}

    if (added.includes(text)) return added;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`"${text}" never showed up in ${logFile(name)}`);
};
