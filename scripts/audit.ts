/**
 * Bulk PageSpeed Audit Script
 *
 * Usage:
 *   1. Create a leads.csv file with a 'domain' column
 *   2. Run: npx ts-node scripts/audit.ts
 *   3. Results saved to output.csv
 *
 * Requires: npm install -D ts-node typescript @types/node
 */

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

// Configuration
const API_KEY = 'AIzaSyBjsQkGsTD0igGUCrFuCtvwYgP5CAfr6ao';
const STRATEGY = 'mobile';
const MONTHLY_TRAFFIC = 1000;  // Placeholder
const AVG_ORDER_VALUE = 100;   // $100
const INPUT_FILE = 'leads.csv';
const OUTPUT_FILE = 'output.csv';
const PROGRESS_FILE = 'progress.json';
const RATE_LIMIT_MS = 1500;    // 1.5s between requests
const SAVE_EVERY = 10;         // Save progress every 10 rows

interface AuditResult {
  domain: string;
  mobileScore: number;
  lcpSeconds: number;
  revenueLeak: number;
  personalizedHook: string;
  error?: string;
}

// Parse CSV (simple implementation)
function parseCSV(content: string): string[] {
  const lines = content.trim().split('\n');
  const header = lines[0].toLowerCase();
  const domainIndex = header.split(',').findIndex(h =>
    h.trim().replace(/"/g, '') === 'domain'
  );

  if (domainIndex === -1) {
    throw new Error('CSV must have a "domain" column');
  }

  return lines.slice(1)
    .map(line => {
      const cols = line.split(',');
      let domain = cols[domainIndex]?.trim().replace(/"/g, '') || '';
      if (domain && !domain.startsWith('http')) {
        domain = 'https://' + domain;
      }
      return domain;
    })
    .filter(d => d.length > 0);
}

// Fetch URL with promise
function fetch(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    }).on('error', reject);
  });
}

// Calculate revenue leak based on LCP
function calculateRevenueLeak(lcp: number): number {
  let dropRate = 0;
  if (lcp > 4) dropRate = 0.20;
  else if (lcp > 2.5) dropRate = 0.10;

  return Math.round(MONTHLY_TRAFFIC * AVG_ORDER_VALUE * dropRate);
}

// Generate personalized hook
function generateHook(lcp: number, revenueLeak: number): string {
  if (revenueLeak === 0) {
    return `Your site loads in ${lcp.toFixed(1)}s - no major revenue leak detected.`;
  }
  return `I noticed your mobile site takes ${lcp.toFixed(1)}s to load, which is likely leaking $${revenueLeak.toLocaleString()} in monthly revenue.`;
}

// Audit a single domain
async function auditDomain(domain: string): Promise<AuditResult> {
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(domain)}&strategy=${STRATEGY}&key=${API_KEY}`;

  try {
    console.log(`  Auditing: ${domain}`);
    const data = await fetch(apiUrl);

    if (data.error) {
      throw new Error(data.error.message || 'API Error');
    }

    const lhr = data.lighthouseResult;
    const mobileScore = Math.round((lhr.categories?.performance?.score || 0) * 100);
    const lcpSeconds = (lhr.audits?.['largest-contentful-paint']?.numericValue || 0) / 1000;
    const revenueLeak = calculateRevenueLeak(lcpSeconds);
    const personalizedHook = generateHook(lcpSeconds, revenueLeak);

    return {
      domain,
      mobileScore,
      lcpSeconds,
      revenueLeak,
      personalizedHook
    };
  } catch (error: any) {
    console.log(`  ❌ Error: ${error.message}`);
    return {
      domain,
      mobileScore: 0,
      lcpSeconds: 0,
      revenueLeak: 0,
      personalizedHook: '',
      error: error.message
    };
  }
}

// Write results to CSV
function writeCSV(results: AuditResult[], filename: string): void {
  const headers = 'Domain,Mobile_Score,LCP_Seconds,Revenue_Leak_USD,Personalized_Hook\n';
  const rows = results.map(r =>
    `"${r.domain}",${r.mobileScore},${r.lcpSeconds.toFixed(2)},${r.revenueLeak},"${r.personalizedHook.replace(/"/g, '""')}"`
  ).join('\n');

  fs.writeFileSync(filename, headers + rows);
  console.log(`\n✅ Results saved to ${filename}`);
}

// Load progress
function loadProgress(): { completed: Set<string>, results: AuditResult[] } {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
      return {
        completed: new Set(data.completed || []),
        results: data.results || []
      };
    }
  } catch (e) {}
  return { completed: new Set(), results: [] };
}

// Save progress
function saveProgress(completed: string[], results: AuditResult[]): void {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ completed, results }, null, 2));
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main
async function main() {
  console.log('🚀 Bulk PageSpeed Audit');
  console.log('========================\n');

  // Check input file
  if (!fs.existsSync(INPUT_FILE)) {
    console.log(`❌ Input file not found: ${INPUT_FILE}`);
    console.log('\nCreate a CSV file with a "domain" column, e.g.:');
    console.log('domain');
    console.log('example.com');
    console.log('another-site.com');
    process.exit(1);
  }

  // Parse domains
  const content = fs.readFileSync(INPUT_FILE, 'utf-8');
  const domains = parseCSV(content);
  console.log(`📋 Found ${domains.length} domains to audit\n`);

  // Load previous progress
  const { completed, results } = loadProgress();
  if (completed.size > 0) {
    console.log(`📁 Resuming from previous progress (${completed.size} already done)\n`);
  }

  // Audit each domain
  let count = completed.size;
  for (const domain of domains) {
    if (completed.has(domain)) continue;

    count++;
    console.log(`[${count}/${domains.length}]`);

    const result = await auditDomain(domain);
    results.push(result);
    completed.add(domain);

    // Save progress every N rows
    if (count % SAVE_EVERY === 0) {
      saveProgress(Array.from(completed), results);
      console.log(`  💾 Progress saved\n`);
    }

    // Rate limiting
    if (count < domains.length) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  // Write final results
  writeCSV(results, OUTPUT_FILE);

  // Clean up progress file
  if (fs.existsSync(PROGRESS_FILE)) {
    fs.unlinkSync(PROGRESS_FILE);
  }

  // Summary
  const successful = results.filter(r => !r.error);
  const avgScore = successful.length > 0
    ? Math.round(successful.reduce((sum, r) => sum + r.mobileScore, 0) / successful.length)
    : 0;
  const totalLeak = successful.reduce((sum, r) => sum + r.revenueLeak, 0);

  console.log('\n📊 Summary');
  console.log('==========');
  console.log(`Total domains: ${results.length}`);
  console.log(`Successful: ${successful.length}`);
  console.log(`Average score: ${avgScore}`);
  console.log(`Total est. revenue leak: $${totalLeak.toLocaleString()}`);
}

main().catch(console.error);
