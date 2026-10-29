/*
 * Checks that every Oracle manual page referenced by src/oracle/docs.ts exists
 * for 19c, 21c and 23ai (network access to docs.oracle.com required; not part
 * of `npm test`). Run: npm run check:doc-links
 */
import { allDocPages, docUrl } from "../src/oracle/docs.js";
import type { OracleVersion } from "../src/oracle/keywords.js";

const versions: OracleVersion[] = ["19c", "21c", "23ai"];
const pages = allDocPages();
const jobs = pages.flatMap((page) => versions.map((v) => ({ page, v, url: docUrl(page, v) })));
const broken: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HEAD with retries: docs.oracle.com answers 403 / 429 when throttling. */
async function check(job: (typeof jobs)[number]): Promise<void> {
  let status = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(job.url, { method: "HEAD", redirect: "follow" });
      status = res.status;
      if (res.ok) return;
      if (res.status === 404) break;
    } catch {
      status = -1;
    }
    await sleep(2000 * 2 ** attempt);
  }
  broken.push(`${job.v} ${job.page} (${status})  ${job.url}`);
}

const queue = [...jobs];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      await check(job);
      await sleep(150);
    }
  }),
);

console.log(`${pages.length} pages × ${versions.length} versions checked`);
if (broken.length) {
  console.log(`${broken.length} broken:\n  ${broken.sort().join("\n  ")}`);
  process.exit(1);
}
console.log("all links OK");
