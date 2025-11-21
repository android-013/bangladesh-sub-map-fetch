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
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function fetchHtml(url) {
  const res = await axios.get(url, {
    responseType: "text",
    timeout: 30000,
  });
  return res.data;
}

function parseDirectoryLinks(html) {
  // Directory listing is standard: bunch of <a href="...">name</a>
  const $ = cheerio.load(html);
  const links = [];

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();

    if (!href) return;
    // Skip parent directory link
    if (/parent directory/i.test(text)) return;

    links.push({ href, text });
  });

  // Split into subdirs & files
  const subdirs = [];
  const files = [];

  for (const link of links) {
    // Most IIS-style listings have folders as "NAME/" and files as "file.ext"
    if (link.href.endsWith("/")) {
      subdirs.push(link.href);
    } else {
      files.push(link.href);
    }
  }

  return { subdirs, files };
}

async function downloadFile(relativePath) {
  const url = ROOT_URL + relativePath;
  const localPath = path.join(OUTPUT_ROOT, relativePath);

  // Only upazila-level content: division/district/upazila/file -> 4 segments
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length < 4) {
    // This will skip division-level & district-level maps if you only want upazilas
    return;
  }

  // Only map-ish file types
  if (!/\.(jpe?g|pdf|png)$/i.test(relativePath)) {
    return;
  }

  // Make sure folder exists
  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  // Skip if already downloaded
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
  for (const fileHref of files) {
    const fullRelPath = path.posix.join(relativePath, fileHref);
    try {
      await downloadFile(fullRelPath);
    } catch (err) {
      console.error("Failed to download:", fullRelPath, err.message);
    }
  }

  // Recurse into subdirectories
  for (const dirHref of subdirs) {
    const nextRelPath = path.posix.join(relativePath, dirHref);
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
