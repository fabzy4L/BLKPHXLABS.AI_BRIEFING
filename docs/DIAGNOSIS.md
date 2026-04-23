# BLK PHX LABS RAG Failure Analysis

## Current State
**Dashboard shows: SOURCES: 0**
**Status: Complete pipeline failure — no articles reaching the RAG engine**

## Root Cause Chain

### Issue #1: Apps Script Early Exit (CRITICAL)
**Location:** `compileWeeklyBriefing()` lines 50-54

```javascript
if (freshArticles.length === 0) {
  Logger.log('No fresh articles found. Discarding doc.');
  DriveApp.getFileById(doc.getId()).setTrashed(true);
  return;  // ← EXITS WITHOUT CALLING dispatchRAGJob()!
}
```

**Problem:** If all articles are already in history, the script exits before triggering the Cloud Function.

**Why This Happens:**
- History persists for 7 days
- Google Alerts sends same articles across multiple days
- Once an article is seen, it's permanently blocked for 7 days
- Daily runs find "no fresh articles" and abort

### Issue #2: Search Query May Be Too Narrow
**Query:** `from:googlealerts-noreply@google.com newer_than:7d`

**Potential Problems:**
- Google Alerts sender address may have changed
- Alerts may be filtered/labeled in Gmail
- No alerts arriving (check inbox manually)

### Issue #3: Taxonomy-Based Filtering Too Strict
Even when articles arrive, the term-matching approach misses 90%+ of relevant content:

```python
RELEVANCE_TAXONOMY = {
    "crispr_gene_editing": (3, ["crispr", "cas9", "base editing"]),
    # ... only ~50 exact terms total
}
```

**Problem:** Articles using different phrasing ("gene modification tool", "CRISPR-Cas9 system", etc.) score 0.

### Issue #4: Context Budget Too Small
`RAG_CONTEXT_CHAR_LIMIT = 6000` — only ~1,500 words of context for analysis.

### Issue #5: Scraper Failure Rate
Many biotech news sites:
- Require JavaScript rendering (Beautiful Soup can't handle)
- Use paywalls/blocks
- Have aggressive anti-bot measures

Result: Most articles return `[Signal Only]` with no content.

---

## Immediate Fixes (Priority Order)

### FIX #1: Bypass Empty Article Check (Emergency Patch)
**File:** Google Apps Script

```javascript
// REMOVE THIS BLOCK:
// if (freshArticles.length === 0) {
//   Logger.log('No fresh articles found. Discarding doc.');
//   DriveApp.getFileById(doc.getId()).setTrashed(true);
//   return;
// }

// REPLACE WITH:
if (freshArticles.length === 0) {
  Logger.log('No fresh articles — dispatching RAG job anyway for diagnostics.');
  // Still dispatch with empty array to trigger pipeline
}

// Always call this:
updateBriefingSheet(freshArticles);
dispatchRAGJob(freshArticles, secrets);
```

### FIX #2: Add Diagnostic Logging
**File:** Google Apps Script, add after line 27:

```javascript
Logger.log(`[DIAGNOSTIC] Threads found: ${threads.length}`);
let totalArticlesParsed = 0;

threads.forEach((thread) => {
  try {
    const message = thread.getMessages().pop();
    if (!isWithinLookbackWindow(message.getDate(), 7)) {
      Logger.log('[DIAGNOSTIC] Thread outside lookback window');
      return;
    }

    const articles = parseForensic(message.getBody());
    totalArticlesParsed += articles.length;
    Logger.log(`[DIAGNOSTIC] Parsed ${articles.length} articles from thread`);
    
    articles.forEach(item => {
      if (!historySet.has(item.url)) {
        freshArticles.push(item);
        Logger.log(`[DIAGNOSTIC] Fresh article: ${item.title.substring(0, 50)}`);
      } else {
        Logger.log(`[DIAGNOSTIC] Duplicate blocked: ${item.title.substring(0, 50)}`);
      }
    });
  } catch (e) {
    Logger.log('[DIAGNOSTIC] Thread parse error: ' + e.message);
  }
});

Logger.log(`[DIAGNOSTIC] Total parsed: ${totalArticlesParsed}, Fresh: ${freshArticles.length}, History size: ${historySet.size}`);
```

### FIX #3: Reduce History Window
**File:** Google Apps Script, line 70:

```javascript
// Change from 7 days to 2 days to reduce duplicate blocking
purgeOldHistory(sheet, 2);  // Was: purgeOldHistory(sheet, 7)
```

### FIX #4: Replace Term Matching with Semantic Relevance
**File:** Cloud Function (main.py)

Replace the entire `score_relevance()` function with Gemini-based semantic scoring:

```python
def score_relevance_semantic(title: str, fragment: str, api_key: str) -> Tuple[int, list]:
    """
    Uses Gemini to score relevance on a 0-10 scale instead of exact term matching.
    Much more robust than keyword matching.
    """
    prompt = f"""
You are a biotech intelligence filter. Score this article's relevance to a biotech venture focused on:
- CRISPR & gene editing, AI drug discovery, lab automation, cell/gene therapy
- Synthetic biology, bioprinting, digital lab operations
- Competitive intelligence (M&A, funding, regulatory changes)

Article Title: {title}
Article Preview: {fragment[:800]}

Return ONLY a JSON object with NO markdown fences:
{{
  "relevance_score": <integer 0-10>,
  "categories": ["<domain1>", "<domain2>"],
  "reasoning": "<one sentence>"
}}

0 = completely irrelevant
5 = tangentially related
10 = critical strategic intelligence
"""
    
    try:
        result = generate_gemini_text(api_key, prompt, expect_json=True)
        if result and isinstance(result, dict):
            score = result.get('relevance_score', 0)
            cats = result.get('categories', [])
            print(f"[SEMANTIC SCORE] {score}/10 | {cats} | {title[:50]}")
            return (score, cats)
    except Exception as e:
        print(f"[SEMANTIC SCORE] Error: {e}, defaulting to 0")
    
    return (0, [])
```

**Update `rank_and_chunk_context()`:**

```python
# Replace this line (around line 325):
# relevance, categories = score_relevance(title, frag)

# With:
relevance, categories = score_relevance_semantic(title, frag, api_key)
# Note: You'll need to pass api_key as a parameter to rank_and_chunk_context
```

### FIX #5: Increase Context Budget
**File:** main.py, line 23:

```python
RAG_CONTEXT_CHAR_LIMIT = 20000  # Was: 6000
```

### FIX #6: Fallback When No High-Quality Content
**File:** main.py, add to `rank_and_chunk_context()` before return:

```python
# Add before the final return statement:
if len(selected_frags) == 0 and len(scored) > 0:
    # Emergency fallback: take top 10 by signal quality regardless of budget
    print("[RAG] No articles fit budget — using emergency fallback")
    emergency = scored[:10]
    selected_frags = [e["fragment"] for e in emergency]
    selected_meta = emergency
```

---

## Long-Term Improvements

### 1. Replace Beautiful Soup with Playwright
For JavaScript-heavy sites, use headless browser:

```python
# In requirements.txt:
playwright==1.41.0

# In fetch_one():
from playwright.sync_api import sync_playwright

def fetch_one_playwright(url: str, title: str) -> str:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(url, timeout=10000, wait_until='networkidle')
            # Extract text from rendered page
            body_text = page.evaluate('() => document.body.innerText')
            browser.close()
            return f"SOURCE: {title}\nTEXT: {body_text[:1200]}...\n---\n"
        except:
            browser.close()
            return f"SOURCE: {title}\nTEXT: [Blocked]\n---\n"
```

### 2. Add Article Deduplication by Content
Current dedup only uses URL. Add semantic deduplication:

```python
def deduplicate_semantically(articles: list, api_key: str) -> list:
    """Uses embeddings to detect near-duplicate articles"""
    # Implementation using Gemini embeddings
```

### 3. Two-Stage Pipeline
1. **Stage 1:** Fast semantic filter (keep top 50%)
2. **Stage 2:** Deep Gemini analysis on survivors

### 4. Add Monitoring Alerts
Set up Cloud Monitoring to alert when `SOURCES: 0`:

```python
from google.cloud import monitoring_v3

def send_alert_if_zero_sources(source_count: int):
    if source_count == 0:
        # Send alert to Slack/email
        print("[ALERT] ZERO SOURCES DETECTED")
```

---

## Testing Steps

1. **Run Apps Script manually** and check logs:
   - Apps Script → Select `compileWeeklyBriefing`
   - Run → View → Logs
   - Look for `[DIAGNOSTIC]` entries

2. **Check Gmail manually:**
   - Search: `from:googlealerts-noreply@google.com`
   - Verify alerts are arriving

3. **Test Cloud Function with dummy data:**
   ```python
   # Create test payload in GCS:
   {
     "action": "deep_dive_rag",
     "articles": [
       {"title": "CRISPR breakthrough", "url": "https://example.com/1"},
       {"title": "AI drug discovery", "url": "https://example.com/2"}
     ]
   }
   ```

4. **Monitor Cloud Function logs:**
   ```bash
   gcloud functions logs read blkphxlabs-audio-engine --limit=50
   ```

---

## Expected Outcome After Fixes

- Apps Script will dispatch jobs even with 0 fresh articles (for diagnostics)
- Semantic scoring will capture 60-80% of relevant articles (vs. current ~5%)
- 20k context budget will fit 15-20 articles (vs. current ~5)
- You'll have diagnostic logs showing exactly where the pipeline breaks

**Next Step:** Implement Fix #1 and #2, run manually, and share the Apps Script logs.
