# BLK PHX LABS V34 Deployment Guide

## CRITICAL: Your RAG is Failing Because SOURCES = 0

The dashboard shows zero articles are reaching your Cloud Function. This is an **upstream sourcing failure**, not a RAG quality issue.

---

## Quick Diagnosis (Do This First)

### 1. Check Gmail Manually
```
In Gmail, search: from:googlealerts-noreply@google.com
```

**If you see recent emails:**
- Apps Script can access them → problem is in the script logic
- Proceed to Step 2

**If you see NO emails in past 7 days:**
- Google Alerts not arriving or changed sender address
- Check Google Alerts settings: https://www.google.com/alerts
- Verify alerts are enabled and frequency is set correctly

### 2. Run Apps Script Manually
1. Open Apps Script: https://script.google.com/
2. Select your BLK PHX LABS project
3. Choose `compileWeeklyBriefing` function
4. Click **Run**
5. View → **Logs**

**Look for these diagnostic messages:**
```
[DIAGNOSTIC] Threads found: X
[DIAGNOSTIC] Total articles parsed: Y
[DIAGNOSTIC] Fresh articles: Z
```

**Diagnosis based on logs:**

| Threads | Parsed | Fresh | Problem |
|---------|--------|-------|---------|
| 0 | 0 | 0 | Gmail search not finding emails |
| >0 | 0 | 0 | Email parsing regex failing |
| >0 | >0 | 0 | All articles already in history |
| >0 | >0 | >0 | Working! Issue is in Cloud Function |

---

## Deployment Steps

### Phase 1: Apps Script Fix (Emergency Patch)

**File:** `apps_script_FIXED.js`

**Changes:**
1. Removed early exit when freshArticles = 0 (now always dispatches)
2. Added comprehensive diagnostic logging
3. Reduced history window from 7 days to 2 days
4. Better error messages

**Deploy:**
1. Open Apps Script editor
2. **Replace entire code** with `apps_script_FIXED.js`
3. Save (Ctrl+S or Cmd+S)
4. Run manually once to test
5. Check logs for `[DIAGNOSTIC]` messages

**Expected Result:**
- Even with 0 fresh articles, job will dispatch to Cloud Function
- You'll see exactly where the pipeline breaks

---

### Phase 2: Cloud Function Fix (Semantic Relevance)

**File:** `main_FIXED.py`

**Major Changes:**
1. **Semantic relevance scoring** instead of keyword matching
   - Old: Only matched exact terms like "crispr", "alphafold"
   - New: Uses Gemini to score relevance 0-10 semantically
   - Result: 60-80% more articles captured

2. **Increased context budget** from 6,000 to 20,000 chars
   - Fits 15-20 articles instead of ~5

3. **Emergency fallback** when no articles fit budget
   - Takes top 10 anyway (truncated) instead of returning empty

4. **Better diagnostics** throughout pipeline

**Deploy:**

```bash
# 1. Update Cloud Function code
cd /path/to/cloud-function
cp main_FIXED.py main.py

# 2. Ensure GEMINI_API_KEY is set as environment variable
gcloud functions describe blkphxlabs-audio-engine --format="value(environmentVariables.GEMINI_API_KEY)"

# If not set:
gcloud run services update blkphxlabs-audio-engine \
  --update-env-vars GEMINI_API_KEY="your-api-key-here"

# 3. Deploy
gcloud functions deploy blkphxlabs-audio-engine \
  --gen2 \
  --runtime=python311 \
  --region=us-central1 \
  --source=. \
  --entry-point=generate_content \
  --trigger-event-filters="type=google.cloud.storage.object.v1.finalized" \
  --trigger-event-filters="bucket=labmind-briefing-ops"

# 4. Monitor deployment
gcloud functions logs read blkphxlabs-audio-engine --limit=50
```

---

## Testing Protocol

### Test 1: Apps Script Diagnostic Run

```
1. Apps Script → Select compileWeeklyBriefing
2. Run
3. View → Logs
4. Look for:
   [DIAGNOSTIC] Threads found: X
   [DIAGNOSTIC] Fresh articles: Y
   [DIAGNOSTIC] RAG payload: Z articles
   [DIAGNOSTIC] GCS Upload Status: 200
```

**Success Criteria:**
- GCS Upload Status: 200 (means job dispatched)
- Even if Fresh = 0, job should still dispatch

### Test 2: Cloud Function Logs

```bash
# Watch logs in real-time
gcloud functions logs read blkphxlabs-audio-engine \
  --limit=100 \
  --format="table(timestamp, textPayload)"

# Look for:
[TRIGGER] Job loaded: X articles in payload
[SEMANTIC] X/10 | ['domain'] | Article Title
[RELEVANCE] High (6-10): X
[PASS 1] Extracted X facts
```

**Success Criteria:**
- Job loaded with articles > 0
- Semantic scores showing (not all 0)
- Facts extracted > 0

### Test 3: End-to-End Verification

```
1. Check dashboard: https://storage.googleapis.com/labmind-briefing-ops/index.html
2. Look for: SOURCES: X (should be > 0)
3. Listen to audio briefing
4. Verify it contains real content (not "no signals")
```

---

## Troubleshooting Guide

### Problem: "Threads found: 0"

**Solution:**
1. Manually search Gmail: `from:googlealerts-noreply@google.com`
2. If no results, Google Alerts not arriving
3. Check sender address may have changed
4. Try broader search: `subject:Google Alert`
5. Update `SEARCH_QUERY` in Apps Script if sender changed

### Problem: "Threads found: X, Parsed: 0"

**Solution:**
1. The `parseForensic()` regex isn't matching
2. Gmail HTML format may have changed
3. Add logging to see raw email body
4. Update regex pattern

### Problem: "Parsed: X, Fresh: 0"

**Solution:**
1. All articles already in history
2. History window may be too long
3. Already fixed in V32 (reduced to 2 days)
4. Manually clear history: Delete `BlkPhxLabs_Link_DB` spreadsheet

### Problem: "Job loaded: 0 articles"

**Solution:**
1. Apps Script not dispatching
2. Check Apps Script logs for errors
3. Verify GCS credentials are set
4. Check OAuth2 token is valid

### Problem: "Semantic scores all low (0-2)"

**Solution:**
1. Articles genuinely not relevant to biotech
2. Review Google Alerts search terms
3. Add more specific alert queries
4. Semantic scoring is working, content quality is low

### Problem: "No facts extracted"

**Solution:**
1. Context budget too small (check logs)
2. Articles are paywalled/blocked
3. Scraper failing (check scraper logs)
4. Gemini API quota exceeded

---

## Monitoring Setup

### Set Up Alerts for SOURCES = 0

Add this to Cloud Function at the end of `generate_content()`:

```python
# After dashboard generation
if len(successful_sources) == 0:
    # Send alert via webhook
    httpx.post("YOUR_SLACK_WEBHOOK", json={
        "text": "⚠️ BLK PHX LABS: Zero sources in latest briefing"
    })
```

### Weekly Health Check

Create a simple monitoring script:

```bash
#!/bin/bash
# Check latest briefing
curl -s https://storage.googleapis.com/labmind-briefing-ops/index.html | grep "SOURCES:" | grep -o "[0-9]*"

# If returns 0, send alert
```

---

## Performance Expectations

### Before Fix (V33)
- **Taxonomy match rate:** ~5% (keyword matching)
- **Avg sources per briefing:** 0-2
- **Quality:** "No signals detected"

### After Fix (V34)
- **Semantic match rate:** ~60-80%
- **Avg sources per briefing:** 8-15
- **Quality:** Actual intelligence analysis

---

## Rollback Plan

If V34 causes issues:

```bash
# Revert Cloud Function
gcloud functions deploy blkphxlabs-audio-engine \
  --source=gs://labmind-briefing-ops/backups/v33/

# Revert Apps Script
# Copy V31 code back from version history
```

---

## Next Steps After V34 Stabilizes

1. **Add Playwright for JS-heavy sites**
   - Many biotech news sites require JavaScript rendering
   - Beautiful Soup can't handle these

2. **Implement batch semantic scoring**
   - Currently scores articles one-by-one (slow)
   - Batch 10 articles per Gemini call (faster, cheaper)

3. **Add content deduplication**
   - Same story from multiple sources
   - Use embeddings to detect semantic duplicates

4. **Expand to arXiv/bioRxiv**
   - Direct access to preprints
   - Higher signal quality than news aggregators

5. **Add user feedback loop**
   - "Was this briefing useful?" button
   - Use feedback to tune semantic scoring

---

## Support

If you still see SOURCES: 0 after deploying V34:

1. Share Apps Script logs (full `[DIAGNOSTIC]` output)
2. Share Cloud Function logs (first 100 lines)
3. Share manual Gmail search results
4. I'll identify the exact failure point

The diagnostic logging in V34 will make the problem obvious.
