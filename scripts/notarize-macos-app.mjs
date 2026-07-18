#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { env, stderr, stdout } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_PROCESSING_TIMEOUT_MS = 35 * 60_000;
const DEFAULT_STAPLE_ATTEMPTS = 4;
const DEFAULT_STAPLE_RETRY_DELAY_MS = 5_000;

export async function notarizeMacosApp({
  appPath,
  environment = env,
  execute = run,
  wait = delay,
  now = Date.now,
  exists = existsSync,
  makeTemporaryDirectory = () => mkdtempSync(join(tmpdir(), "clui-notarize-")),
  removeTemporaryDirectory = (path) => rmSync(path, { force: true, recursive: true }),
  output = stdout,
  errorOutput = stderr,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  processingTimeoutMs = DEFAULT_PROCESSING_TIMEOUT_MS,
  stapleAttempts = DEFAULT_STAPLE_ATTEMPTS,
  stapleRetryDelayMs = DEFAULT_STAPLE_RETRY_DELAY_MS,
} = {}) {
  const resolvedAppPath = appPath?.trim();
  if (!resolvedAppPath) {
    throw new Error("A macOS application bundle path is required for notarization.");
  }

  const appleApiKey = requiredEnvironmentVariable(environment, "APPLE_API_KEY_PATH");
  const appleApiKeyId = requiredEnvironmentVariable(environment, "APPLE_API_KEY_ID");
  const appleApiIssuer = requiredEnvironmentVariable(environment, "APPLE_API_ISSUER");

  if (!exists(resolvedAppPath)) {
    throw new Error(`Application bundle not found at ${resolvedAppPath}.`);
  }
  if (!exists(appleApiKey)) {
    throw new Error(`App Store Connect API key not found at ${appleApiKey}.`);
  }

  const authorizationArgs = [
    "--key",
    appleApiKey,
    "--key-id",
    appleApiKeyId,
    "--issuer",
    appleApiIssuer,
  ];
  const temporaryDirectory = makeTemporaryDirectory();
  const archivePath = join(
    temporaryDirectory,
    `${basename(resolvedAppPath, ".app") || "Clui"}.zip`,
  );

  const runNotaryToolJson = (args) => {
    const rawOutput = execute("xcrun", ["notarytool", ...args, "--output-format", "json"], true);

    try {
      return JSON.parse(rawOutput);
    } catch {
      throw new Error(`notarytool returned invalid JSON:\n${rawOutput}`);
    }
  };

  const printSubmissionLog = (submissionId) => {
    output.write(`Apple notarization log for ${submissionId}:\n`);
    try {
      execute("xcrun", ["notarytool", "log", submissionId, ...authorizationArgs]);
    } catch (error) {
      errorOutput.write(`Unable to retrieve the notarization log: ${errorMessage(error)}\n`);
    }
  };

  try {
    output.write(`Verifying signature for ${resolvedAppPath}\n`);
    execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", resolvedAppPath]);

    output.write(`Creating notarization archive at ${archivePath}\n`);
    execute("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", resolvedAppPath, archivePath]);

    output.write("Uploading application to Apple Notary Service...\n");
    const submission = runNotaryToolJson([
      "submit",
      archivePath,
      ...authorizationArgs,
      "--no-wait",
    ]);
    if (typeof submission.id !== "string" || !submission.id) {
      throw new Error(
        `Notary Service did not return a submission ID: ${JSON.stringify(submission)}`,
      );
    }

    output.write(`Notarization submission ID: ${submission.id}\n`);
    const deadline = now() + processingTimeoutMs;
    const timeoutDescription = formatDuration(processingTimeoutMs);
    while (true) {
      let response;
      try {
        response = runNotaryToolJson(["info", submission.id, ...authorizationArgs]);
      } catch (error) {
        if (now() >= deadline) {
          throw new Error(
            `Unable to retrieve notarization status for ${submission.id} within ${timeoutDescription}.`,
            { cause: error },
          );
        }
        errorOutput.write(
          `Unable to retrieve notarization status; retrying in ${pollIntervalMs / 1_000} seconds.\n`,
        );
        await wait(pollIntervalMs);
        continue;
      }

      const status = typeof response.status === "string" ? response.status : "Unknown";
      output.write(`Notarization status: ${status}\n`);

      if (status === "Accepted") {
        break;
      }
      if (status === "Invalid" || status === "Rejected") {
        printSubmissionLog(submission.id);
        throw new Error(`Apple rejected notarization submission ${submission.id}.`);
      }
      if (now() >= deadline) {
        throw new Error(
          `Notarization submission ${submission.id} is still ${status} after ${timeoutDescription}. ` +
            "Apple continues processing it; use notarytool info with this submission ID to check it later.",
        );
      }

      await wait(pollIntervalMs);
    }

    for (let attempt = 1; attempt <= stapleAttempts; attempt += 1) {
      try {
        execute("xcrun", ["stapler", "staple", "--verbose", resolvedAppPath]);
        output.write(`Notarized and stapled ${resolvedAppPath}\n`);
        return;
      } catch (error) {
        if (attempt === stapleAttempts) {
          throw error;
        }
        errorOutput.write(
          `Stapling attempt ${attempt} failed; retrying in ${stapleRetryDelayMs / 1_000} seconds.\n`,
        );
        await wait(stapleRetryDelayMs);
      }
    }
  } finally {
    removeTemporaryDirectory(temporaryDirectory);
  }
}

function formatDuration(milliseconds) {
  if (milliseconds % 60_000 === 0) {
    const minutes = milliseconds / 60_000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${milliseconds} milliseconds`;
}

function requiredEnvironmentVariable(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for macOS notarization.`);
  }
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function run(command, args, captureOutput = false) {
  try {
    return execFileSync(command, args, {
      encoding: captureOutput ? "utf8" : undefined,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });
  } catch (error) {
    if (captureOutput && typeof error === "object" && error !== null) {
      if ("stdout" in error && error.stdout) {
        stderr.write(String(error.stdout));
      }
      if ("stderr" in error && error.stderr) {
        stderr.write(String(error.stderr));
      }
    }
    const status =
      typeof error === "object" && error !== null && "status" in error ? error.status : "unknown";
    throw new Error(`${command} failed with exit code ${status ?? "unknown"}.`, { cause: error });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await notarizeMacosApp({ appPath: process.argv[2] });
}
