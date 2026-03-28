const { execSync } = require("child_process");
const fs = require("fs");
const https = require("https");
const path = require("path");
const os = require("os");

const REPO = "dhruvyad/wahooks";
const BIN_DIR = path.join(__dirname, "bin");
const BIN_PATH = path.join(BIN_DIR, process.platform === "win32" ? "wahooks.exe" : "wahooks");

function getPlatform() {
  const platform = process.platform;
  const arch = process.arch;

  const osMap = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archMap = { x64: "amd64", arm64: "arm64" };

  const goos = osMap[platform];
  const goarch = archMap[arch];

  if (!goos || !goarch) {
    throw new Error(`Unsupported platform: ${platform}/${arch}`);
  }

  return { goos, goarch };
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "wahooks-cli-npm" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function install() {
  const { goos, goarch } = getPlatform();
  const ext = goos === "windows" ? ".exe" : "";
  const assetName = `wahooks-${goos}-${goarch}${ext}`;

  // Find latest CLI release (use /releases/latest first, fall back to listing)
  let cliRelease;
  try {
    const latestData = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    const latest = JSON.parse(latestData.toString());
    if (latest.tag_name && latest.tag_name.startsWith("cli-v")) {
      cliRelease = latest;
    }
  } catch {}
  if (!cliRelease) {
    const releasesData = await fetch(`https://api.github.com/repos/${REPO}/releases`);
    const releases = JSON.parse(releasesData.toString());
    const cliReleases = releases.filter((r) => r.tag_name.startsWith("cli-v"));
    cliReleases.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    cliRelease = cliReleases[0];
  }

  if (!cliRelease) {
    throw new Error("No CLI release found. Please install from source: https://github.com/dhruvyad/wahooks/tree/main/cli");
  }

  const asset = cliRelease.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`No binary found for ${goos}/${goarch} in release ${cliRelease.tag_name}`);
  }

  console.log(`Downloading wahooks ${cliRelease.tag_name} for ${goos}/${goarch}...`);
  const binary = await fetch(asset.browser_download_url);

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(BIN_PATH, binary);
  fs.chmodSync(BIN_PATH, 0o755);

  console.log("wahooks CLI installed successfully.");
}

install().catch((err) => {
  console.error("Failed to install wahooks CLI:", err.message);
  console.error("You can install manually: curl -fsSL https://wahooks.com/install | bash");
  process.exit(1);
});
