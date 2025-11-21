// download-upazila-maps.js
// Scrape all upazila maps & road maps from LGED
// Root: https://oldweb.lged.gov.bd/UploadedDocument/Map/

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const ROOT_URL = "https://oldweb.lged.gov.bd/UploadedDocument/Map/";
const OUTPUT_ROOT = path.join(__dirname, "upazila_maps");

// polite-ish delay between requests (ms)
const DELAY_MS = 300;

// helper: sleep
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function fetchHtml(url) {
  const res = await axios.get(url, {
    responseType: "text",
    timeout: 30000,
  });
  return res.data;
}

// Normalize any href into a path *relative* to /UploadedDocument/Map/
function normalizeHref(href) {
  if (!href) return null;

  // Drop query / hash if any
  let clean = href.split("#")[0].split("?")[0].trim();
  if (!clean) return null;

  // If absolute URL, extract pathname
  if (clean.startsWith("http://") || clean.startsWith("https://")) {
    try {
      const u = new URL(clean);
      clean = u.pathname;
    } catch {
      return null;
    }
  }

  // Remove leading slashes
  clean = clean.replace(/^\/+/, "");

  // Strip UploadedDocument/Map/ prefix (case insensitive)
  const prefix = "UploadedDocument/Map/";
  if (clean.toLowerCase().startsWith(prefix.toLowerCase())) {
    clean = clean.slice(prefix.length);
  }

  // Now clean is something like "BARISAL/" or "BARISAL/barisal/file.jpg"
  return clean;
}

function parseDirectoryLinks(html) {
  const $ = cheerio.load(html);
  const subdirs = [];
  const files = [];

  $("a").each((_, el) => {
    const text = $(el).text().trim();
    let href = $(el).attr("href");
    if (!href) return;

    // Skip "To Parent Directory"
    if (/parent directory/i.test(text)) return;

    const rel = normalizeHref(href);
    if (!rel) return;

    // Ignore if somehow points outside the Map tree
    if (rel.length === 0) return;

    if (rel.endsWith("/")) {
      subdirs.push(rel);
    } else {
      files.push(rel);
    }
  });

  return { subdirs, files };
}

async function downloadFile(relativePath) {
  // relativePath is like "DHAKA/dhaka/abhaynagar/abhaynagar_road.jpg"
  const url = ROOT_URL + relativePath;
  const localPath = path.join(OUTPUT_ROOT, relativePath);

  const segments = relativePath.split("/").filter(Boolean);

  // Only upazila-level files: division/district/upazila/file => 4 segments
  if (segments.length < 4) {
    return;
  }

  // Only map-ish file types
  if (!/\.(jpe?g|pdf|png)$/i.test(relativePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  if (fs.existsSync(localPath)) {
    console.log("Exists, skipping:", relativePath);
    return;
  }

  console.log("Downloading:", relativePath);

  const res = await axios.get(url, {
    responseType: "stream",
    timeout: 600000,
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(localPath);
    res.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  await sleep(DELAY_MS);
}

async function crawl(relativePath = "") {
  const url = ROOT_URL + relativePath;
  console.log("Listing:", url);

  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    console.error("Failed to fetch listing:", url, err.message);
    return;
  }

  const { subdirs, files } = parseDirectoryLinks(html);

  // Download files in this directory
  for (const fileRel of files) {
    // If we're inside some folder, join; otherwise use fileRel directly
    const fullRelPath = relativePath
      ? path.posix.join(relativePath, fileRel)
      : fileRel;

    try {
      await downloadFile(fullRelPath);
    } catch (err) {
      console.error("Failed to download:", fullRelPath, err.message);
    }
  }

  // Recurse into subdirectories
  for (const dirRel of subdirs) {
    const nextRelPath = relativePath
      ? path.posix.join(relativePath, dirRel)
      : dirRel;

    await crawl(nextRelPath);
  }
}

(async () => {
  try {
    console.log("Starting LGED upazila map scraper…");
    console.log("Root:", ROOT_URL);
    await crawl(""); // start at /UploadedDocument/Map/
    console.log("Done. Files saved under:", OUTPUT_ROOT);
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
})();
