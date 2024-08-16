const os = require("os");
const fs = require("fs");
const path = require("path");
const packageJsonPath = path.join(__dirname, "..", "package.json");

// Determine the correct executable based on the platform
const platform = os.platform();
const arch = os.arch();
let executable = "";

if (platform === "win32") {
  executable = "./bin/smo.exe";
} else if (platform === "linux") {
  executable = "./bin/smo-linux";
} else if (platform === "darwin") {
  executable = "./bin/smo-macos";
} else {
  console.error(`Unsupported platform: ${platform}`);
  process.exit(1);
}

// Update the package.json bin field
const packageJson = require(packageJsonPath);
packageJson.bin["smo"] = executable;

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

console.log(`Set up platform-specific executable: ${executable}`);
