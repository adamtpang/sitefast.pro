/**
 * SiteFast Edge Optimizer - Cloudflare Worker
 *
 * A Gemini-powered edge solution that optimizes websites in real-time.
 * Customers point their DNS to this worker, and we serve their site
 * with PageSpeed enhancements applied at the edge.
 *
 * Optimizations:
 * - AI-generated JSON-LD schema (via Gemini)
 * - Lazy loading for images
 * - Resource preconnect hints
 * - Critical CSS extraction hints
 * - Meta tag optimization
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Get the origin domain from query param, header, or env
    // Priority: ?origin= query param > X-Origin-Domain header > env variable
    let originDomain = url.searchParams.get('origin') ||
      request.headers.get('X-Origin-Domain') ||
      env.ORIGIN_DOMAIN ||
      'https://example.com';

    // Clean up the origin URL
    if (!originDomain.startsWith('http')) {
      originDomain = 'https://' + originDomain;
    }

    // Remove the origin param from the path we're proxying
    url.searchParams.delete('origin');
    const pathAndQuery = url.pathname + (url.search || '');
    const originUrl = originDomain + pathAndQuery;

    try {
      // 1. Fetch the original site
      const originalResponse = await fetch(originUrl, {
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'SiteFast-Edge/1.0',
          'Accept': request.headers.get('Accept') || 'text/html',
        },
        cf: {
          // Cache the origin response for 1 hour
          cacheTtl: 3600,
          cacheEverything: true,
        }
      });

      // Only transform HTML responses
      const contentType = originalResponse.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        return originalResponse;
      }

      // 2. Extract page context using HTMLRewriter
      let pageContext = {
        title: '',
        h1: '',
        description: '',
        images: [],
        externalDomains: new Set(),
      };

      const contextRewriter = new HTMLRewriter()
        .on('title', {
          text(text) { pageContext.title += text.text; }
        })
        .on('h1', {
          text(text) { pageContext.h1 += text.text; }
        })
        .on('meta[name="description"]', {
          element(el) { pageContext.description = el.getAttribute('content') || ''; }
        })
        .on('img[src]', {
          element(el) {
            const src = el.getAttribute('src');
            if (src) pageContext.images.push(src);
          }
        })
        .on('link[href], script[src]', {
          element(el) {
            const href = el.getAttribute('href') || el.getAttribute('src');
            if (href && href.startsWith('http')) {
              try {
                const domain = new URL(href).origin;
                pageContext.externalDomains.add(domain);
              } catch { }
            }
          }
        });

      // Clone and extract context
      const clonedRes = originalResponse.clone();
      await contextRewriter.transform(clonedRes).text();

      // 3. Call Gemini to generate optimizations
      let geminiOptimizations = null;
      if (env.GEMINI_API_KEY) {
        geminiOptimizations = await generateOptimizations(env.GEMINI_API_KEY, pageContext, originDomain);
      }

      // 4. Apply all optimizations via HTMLRewriter
      const optimizedResponse = applyOptimizations(originalResponse, pageContext, geminiOptimizations, originDomain);

      // Add cache headers for edge caching
      const headers = new Headers(optimizedResponse.headers);
      headers.set('X-SiteFast-Optimized', 'true');
      headers.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');

      return new Response(optimizedResponse.body, {
        status: optimizedResponse.status,
        headers,
      });

    } catch (error) {
      // On error, return the original site unmodified
      console.error('SiteFast Error:', error);
      return fetch(originUrl);
    }
  }
};

/**
 * Call Gemini API to generate SEO/schema optimizations
 */
async function generateOptimizations(apiKey, pageContext, originDomain) {
  const prompt = `You are an SEO expert. Based on this website data, generate optimizations.

Website: ${originDomain}
Title: "${pageContext.title}"
Main Heading: "${pageContext.h1}"
Description: "${pageContext.description}"

Return a JSON object (no markdown) with these fields:
{
  "jsonLd": { valid JSON-LD Organization schema },
  "metaDescription": "optimized meta description if current one is weak, or null",
  "preconnectDomains": ["list of domains that should have preconnect hints"],
  "criticalResources": ["list of resources that should be preloaded"]
}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1024,
          }
        })
      }
    );

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (error) {
    console.error('Gemini API error:', error);
  }

  return null;
}

/**
 * Apply all PageSpeed optimizations via HTMLRewriter
 */
function applyOptimizations(response, pageContext, geminiOptimizations, originDomain) {
  let rewriter = new HTMLRewriter();

  // === HEAD OPTIMIZATIONS ===
  rewriter = rewriter.on('head', {
    element(el) {
      // IMPORTANT: Add base tag to fix relative URLs (prevents 404s)
      el.prepend(`<base href="${originDomain}/">`, { html: true });

      // Inject preconnect hints for external domains
      const preconnectDomains = geminiOptimizations?.preconnectDomains ||
        Array.from(pageContext.externalDomains).slice(0, 5);

      for (const domain of preconnectDomains) {
        el.append(`<link rel="preconnect" href="${domain}" crossorigin>`, { html: true });
      }

      // Inject DNS prefetch for remaining domains
      for (const domain of Array.from(pageContext.externalDomains).slice(5, 10)) {
        el.append(`<link rel="dns-prefetch" href="${domain}">`, { html: true });
      }

      // Inject Gemini-generated JSON-LD schema
      if (geminiOptimizations?.jsonLd) {
        const schemaScript = `<script type="application/ld+json">${JSON.stringify(geminiOptimizations.jsonLd)}</script>`;
        el.append(schemaScript, { html: true });
      }

      // Inject critical resource preloads
      if (geminiOptimizations?.criticalResources) {
        for (const resource of geminiOptimizations.criticalResources) {
          const ext = resource.split('.').pop()?.toLowerCase();
          const asType = ext === 'css' ? 'style' : ext === 'js' ? 'script' : 'fetch';
          el.append(`<link rel="preload" href="${resource}" as="${asType}">`, { html: true });
        }
      }

      // Add viewport meta if missing
      el.append(`
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="X-UA-Compatible" content="IE=edge">
      `, { html: true });
    }
  });

  // Update meta description if Gemini suggests improvement
  if (geminiOptimizations?.metaDescription) {
    rewriter = rewriter.on('meta[name="description"]', {
      element(el) {
        el.setAttribute('content', geminiOptimizations.metaDescription);
      }
    });
  }

  // === IMAGE OPTIMIZATIONS ===
  // Add lazy loading to images below the fold
  let imageCount = 0;
  rewriter = rewriter.on('img', {
    element(el) {
      imageCount++;

      // Skip first 2 images (likely above fold)
      if (imageCount > 2) {
        // Add native lazy loading
        if (!el.getAttribute('loading')) {
          el.setAttribute('loading', 'lazy');
        }

        // Add decoding async
        if (!el.getAttribute('decoding')) {
          el.setAttribute('decoding', 'async');
        }
      }

      // Ensure width/height for CLS prevention
      // (Only if we can infer from existing attributes)
      const src = el.getAttribute('src') || '';
      if (!el.getAttribute('width') && !el.getAttribute('height')) {
        // Add fetchpriority for hero images
        if (imageCount <= 2) {
          el.setAttribute('fetchpriority', 'high');
        }
      }
    }
  });

  // === IFRAME OPTIMIZATIONS ===
  rewriter = rewriter.on('iframe', {
    element(el) {
      // Add lazy loading to iframes (YouTube embeds, etc.)
      if (!el.getAttribute('loading')) {
        el.setAttribute('loading', 'lazy');
      }
    }
  });

  // === SCRIPT OPTIMIZATIONS ===
  rewriter = rewriter.on('script[src]', {
    element(el) {
      const src = el.getAttribute('src') || '';

      // Add async to external scripts that aren't critical
      if (src.includes('analytics') || src.includes('gtag') || src.includes('facebook')) {
        if (!el.getAttribute('async') && !el.getAttribute('defer')) {
          el.setAttribute('async', '');
        }
      }
    }
  });

  // === LINK OPTIMIZATIONS ===
  rewriter = rewriter.on('link[rel="stylesheet"]', {
    element(el) {
      const href = el.getAttribute('href') || '';

      // Add media="print" trick for non-critical CSS (converted on load)
      if (href.includes('font') || href.includes('icon')) {
        el.setAttribute('media', 'print');
        el.setAttribute('onload', "this.media='all'");
      }
    }
  });

  // === BODY OPTIMIZATIONS ===
  rewriter = rewriter.on('body', {
    element(el) {
      // Add SiteFast attribution comment
      el.prepend('<!-- Optimized by SiteFast.pro Edge -->', { html: true });
    }
  });

  return rewriter.transform(response);
}
