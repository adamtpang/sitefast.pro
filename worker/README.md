# SiteFast Edge Optimizer

Gemini-powered PageSpeed optimizer running at Cloudflare's edge.

## Setup

```bash
cd worker
npm init -y
npm install -D wrangler
```

## Configuration

1. Set your Gemini API key:
```bash
wrangler secret put GEMINI_API_KEY
```

2. Update `wrangler.toml` with your origin domain:
```toml
[vars]
ORIGIN_DOMAIN = "https://your-customer-site.com"
```

## Development

```bash
npx wrangler dev
```

## Deploy

```bash
# Deploy to workers.dev (staging)
npx wrangler deploy

# Deploy to production with custom domain
npx wrangler deploy --env production
```

## How It Works

1. **Customer points DNS** → Their domain resolves to your Cloudflare Worker
2. **Worker fetches origin** → Gets the original slow site
3. **Gemini analyzes** → Extracts title, h1, description for context
4. **AI generates** → JSON-LD schema, meta improvements
5. **HTMLRewriter injects** → Lazy loading, preconnects, optimizations
6. **Cached at edge** → Optimized site served globally

## Optimizations Applied

| Optimization | Description |
|-------------|-------------|
| JSON-LD Schema | AI-generated Organization schema |
| Lazy Loading | Native lazy loading for images/iframes |
| Preconnects | Resource hints for external domains |
| Async Scripts | Analytics scripts made async |
| CLS Prevention | fetchpriority for above-fold images |
| DNS Prefetch | Prefetch hints for remaining domains |

## Customer Onboarding

1. Customer adds CNAME: `www.their-site.com` → `optimized.sitefast.pro`
2. You add their domain to `wrangler.toml` routes
3. Set ORIGIN_DOMAIN for their original server
4. Deploy and test

## Scripts

Add to package.json:
```json
{
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "deploy:production": "wrangler deploy --env production"
  },
  "devDependencies": {
    "wrangler": "^3.0.0"
  }
}
```
