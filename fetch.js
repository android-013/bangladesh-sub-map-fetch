// fetch.js
// Node 18+ recommended

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const BASE_URL = "https://oldweb.lged.gov.bd/ViewMap.aspx";

const OUTPUT_ROOT = path.join(__dirname, "lged_maps");
const UPAZILA_DIR = path.join(OUTPUT_ROOT, "upazila");
const ROAD_DIR = path.join(OUTPUT_ROOT, "road");

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/['’`]/g, "")           // drop quotes
    .replace(/[^a-z0-9]+/gi, "_")    // non alnum -> _
    .replace(/^_+|_+$/g, "");        // trim _
}

async function ensureDirs() {
  for (const dir of [OUTPUT_ROOT, UPAZILA_DIR, ROAD_DIR]) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadWithPage(browser, url, destPath) {
  if (!url) return;

  const page = await browser.newPage();
  try {
    const res = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 120000
    });

    if (!res) {
      console.warn("No response for", url);
      await page.close();
      return;
    }

    const status = res.status();
    if (status < 200 || status >= 300) {
      console.warn(`Non-200 for ${url}: ${status}`);
      await page.close();
      return;
    }

    const buffer = await res.buffer();
    await fs.promises.writeFile(destPath, buffer);
    console.log("    Saved:", destPath);
  } catch (err) {
    console.error("    Download failed for", url, err.message);
  } finally {
    await page.close();
  }
}

// --------------------------------------------------
// Main
// --------------------------------------------------

(async () => {
  await ensureDirs();

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1366, height: 768 }
  });

  const page = await browser.newPage();
  await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 120000 });

  // Get all districts (value + text), skip "Select (-1)" and value "0"
  const districts = await page.evaluate(() => {
    const select = document.querySelector("#ctl00_ContentPlaceHolder1_ddlDistrict");
    if (!select) return [];
    return Array.from(select.options)
      .filter(opt => {
        const val = (opt.value || "").trim();
        if (!val) return false;
        if (val === "0" || val === "-1") return false; // skip 'Select'
        return true;
      })
      .map(opt => ({
        value: opt.value,
        text: opt.textContent.trim()
      }));
  });

  if (!districts.length) {
    console.error("No districts found. Check if selectors changed.");
    await browser.close();
    process.exit(1);
  }

  console.log(`Found ${districts.length} districts (after filtering dummy ones).`);

  for (const district of districts) {
    const districtSlug = slugify(district.text);
    console.log(`\n=== District: ${district.text} (${district.value}) ===`);

    // Select district
    await page.select("#ctl00_ContentPlaceHolder1_ddlDistrict", district.value);

    // Wait for Upazila dropdown to refresh (ASP.NET postback)
    await sleep(2000);

    // Get upazila list for this district
    const upazilas = await page.evaluate(() => {
      const select = document.querySelector('select[name="ctl00$ContentPlaceHolder1$ddlUpazilla"]');
      if (!select) return [];
      return Array.from(select.options)
        .filter(opt => {
          const val = (opt.value || "").trim();
          if (!val) return false;
          if (val === "0" || val === "-1") return false; // skip 'Select'
          return true;
        })
        .map(opt => ({
          value: opt.value,
          text: opt.textContent.trim()
        }));
    });

    if (!upazilas.length) {
      console.warn("  No upazilas found for district:", district.text);
      continue;
    }

    console.log(`  Upazilas in ${district.text}: ${upazilas.length}`);

    for (const up of upazilas) {
      const upSlug = slugify(up.text);
      console.log(`  -> Upazila: ${up.text} (${up.value})`);

      // Select upazila (triggers __doPostBack on change)
      await page.select('select[name="ctl00$ContentPlaceHolder1$ddlUpazilla"]', up.value);

      // Give the postback some time
      await sleep(2500);

      // Read the two JPEG download URLs
      const urls = await page.evaluate(() => {
        function safeHref(id) {
          const a = document.getElementById(id);
          if (!a) return null;
          const rawHref = a.getAttribute("href");
          if (!rawHref) return null;
          const lower = rawHref.toLowerCase();
          if (lower.startsWith("javascript")) return null;
          return rawHref;
        }

        return {
          upazilaUrl: safeHref("ctl00_ContentPlaceHolder1_lnkImg"),
          roadUrl: safeHref("ctl00_ContentPlaceHolder1_lnkImgRoad")
        };
      });

      const upazilaUrl = urls.upazilaUrl
        ? new URL(urls.upazilaUrl, BASE_URL).toString()
        : null;
      const roadUrl = urls.roadUrl
        ? new URL(urls.roadUrl, BASE_URL).toString()
        : null;

      // Build filenames
      if (upazilaUrl) {
        const upFile = path.join(
          UPAZILA_DIR,
          `${districtSlug}__${upSlug}_upazila.jpg`
        );
        await downloadWithPage(browser, upazilaUrl, upFile);
      } else {
        console.warn("    No upazila JPEG URL for", up.text);
      }

      if (roadUrl) {
        const roadFile = path.join(
          ROAD_DIR,
          `${districtSlug}__${upSlug}_road.jpg`
        );
        await downloadWithPage(browser, roadUrl, roadFile);
      } else {
        console.warn("    No road JPEG URL for", up.text);
      }

      // Be kind to the server
      await sleep(1000);
    }

    // Slight pause between districts
    await sleep(2000);
  }

  await browser.close();
  console.log("\nDone. Check the 'lged_maps' folder.");
})().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
