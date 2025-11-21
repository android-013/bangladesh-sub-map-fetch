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
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
}

async function ensureDirs() {
  for (const dir of [OUTPUT_ROOT, UPAZILA_DIR, ROAD_DIR]) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadImage(browser, url, destPath) {
  const page = await browser.newPage();
  try {
    const res = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 120000
    });

    if (!res) {
      console.warn("    No response for", url);
      await page.close();
      return;
    }

    const status = res.status();
    if (status < 200 || status >= 300) {
      console.warn(`    Non-200 for ${url}: ${status}`);
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

  // Get all districts, skip "Select"
  const districts = await page.evaluate(() => {
    const select = document.querySelector("#ctl00_ContentPlaceHolder1_ddlDistrict");
    if (!select) return [];
    return Array.from(select.options)
      .filter(opt => {
        const val = (opt.value || "").trim();
        if (!val) return false;
        if (val === "0" || val === "-1") return false;
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
    await sleep(2000); // allow UpdatePanel to reload

    // Get upazilas for this district
    const upazilas = await page.evaluate(() => {
      const select = document.querySelector("#ctl00_ContentPlaceHolder1_ddlUpazilla");
      if (!select) return [];
      return Array.from(select.options)
        .filter(opt => {
          const val = (opt.value || "").trim();
          if (!val) return false;
          if (val === "0" || val === "-1") return false; // "Select"
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

      // Select upazila
      await page.select("#ctl00_ContentPlaceHolder1_ddlUpazilla", up.value);
      await sleep(2500); // wait for map info to load

      // Scrape all UploadedDocument JPG paths that contain this upazila name
      const { allPaths, upazilaPaths, roadPaths } = await page.evaluate(upSlug => {
        const html = document.documentElement.innerHTML;
        const regex = /\/UploadedDocument\/[^"']+?\.jpg/gi;
        const allSet = new Set();
        let m;
        while ((m = regex.exec(html)) !== null) {
          allSet.add(m[0]);
        }

        const all = Array.from(allSet);

        const lowerSlug = upSlug.toLowerCase();
        const filtered = all.filter(p =>
          p.toLowerCase().includes(lowerSlug)
        );

        const upazila = [];
        const road = [];

        for (const p of filtered) {
          const lower = p.toLowerCase();
          if (lower.includes("road")) {
            road.push(p);
          } else {
            upazila.push(p);
          }
        }

        return {
          allPaths: filtered,
          upazilaPaths: upazila,
          roadPaths: road
        };
      }, upSlug);

      if (!allPaths.length) {
        console.warn("    No UploadedDocument JPG paths found for", up.text);
        continue;
      }

      // If classification fails, fall back to treating all as upazila maps
      let finalUpazila = upazilaPaths;
      let finalRoad = roadPaths;

      if (!finalUpazila.length && !finalRoad.length && allPaths.length) {
        finalUpazila = allPaths;
      }

      // Download upazila maps
      let idx = 1;
      for (const rel of finalUpazila) {
        const url = new URL(rel, BASE_URL).toString();
        const dest = path.join(
          UPAZILA_DIR,
          `${districtSlug}__${upSlug}_upazila_${idx}.jpg`
        );
        await downloadImage(browser, url, dest);
        idx++;
      }

      // Download road maps
      idx = 1;
      for (const rel of finalRoad) {
        const url = new URL(rel, BASE_URL).toString();
        const dest = path.join(
          ROAD_DIR,
          `${districtSlug}__${upSlug}_road_${idx}.jpg`
        );
        await downloadImage(browser, url, dest);
        idx++;
      }

      await sleep(1000);
    }

    await sleep(2000);
  }

  await browser.close();
  console.log("\nDone. Check the 'lged_maps' folder.");
})().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
