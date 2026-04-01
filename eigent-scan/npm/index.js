#!/usr/bin/env node

/**
 * npx eigent-scan wrapper
 *
 * Checks if Python 3 and pip are available, installs eigent-scan via pip
 * if needed, then runs it — forwarding all CLI arguments.
 */

const { execSync, spawn } = require("child_process");
const process = require("process");

const PACKAGE_NAME = "eigent-scan";

function commandExists(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findPython() {
  for (const cmd of ["python3", "python"]) {
    if (commandExists(cmd)) {
      // Verify it is Python 3
      try {
        const version = execSync(`${cmd} --version`, { encoding: "utf-8" });
        if (version.includes("Python 3")) {
          return cmd;
        }
      } catch {
        // continue
      }
    }
  }
  return null;
}

function findPip(pythonCmd) {
  // Try pip3, pip, then python -m pip
  for (const cmd of ["pip3", "pip"]) {
    if (commandExists(cmd)) {
      return [cmd];
    }
  }
  // Fallback: python -m pip
  try {
    execSync(`${pythonCmd} -m pip --version`, { stdio: "ignore" });
    return [pythonCmd, "-m", "pip"];
  } catch {
    return null;
  }
}

function isInstalled(pythonCmd) {
  try {
    execSync(`${pythonCmd} -c "import eigent_scan"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const pythonCmd = findPython();
  if (!pythonCmd) {
    process.stderr.write(
      "Error: Python 3 is required but not found.\n" +
        "Install Python 3 from https://python.org and try again.\n"
    );
    process.exit(1);
  }

  if (!isInstalled(pythonCmd)) {
    const pipCmd = findPip(pythonCmd);
    if (!pipCmd) {
      process.stderr.write(
        "Error: pip is required but not found.\n" +
          "Install pip (https://pip.pypa.io/en/stable/installation/) and try again.\n"
      );
      process.exit(1);
    }

    process.stderr.write(`Installing ${PACKAGE_NAME} via pip...\n`);
    try {
      execSync([...pipCmd, "install", PACKAGE_NAME].join(" "), {
        stdio: "inherit",
      });
    } catch {
      process.stderr.write(
        `Failed to install ${PACKAGE_NAME}. You can install manually:\n` +
          `  pip install ${PACKAGE_NAME}\n`
      );
      process.exit(1);
    }
  }

  // Forward all arguments to eigent-scan
  const args = process.argv.slice(2);
  const child = spawn(pythonCmd, ["-m", "eigent_scan.cli", ...args], {
    stdio: "inherit",
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    process.stderr.write(`Failed to run eigent-scan: ${err.message}\n`);
    process.exit(1);
  });
}

main();
