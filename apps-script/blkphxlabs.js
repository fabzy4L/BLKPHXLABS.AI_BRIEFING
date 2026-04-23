/**
 * BLK PHX LABS MASTER AUTOMATION (V32 - DIAGNOSTIC PATCH)
 * CHANGES FROM V31:
 * - Added comprehensive diagnostic logging
 * - Removed early exit on empty articles (now always dispatches)
 * - Reduced history window from 7 days to 2 days
 * - Added article count tracking
 */

const TARGET_FOLDER_ID  = '1bgxg4xfSUk53BBJ0n2TMJxinf_DzqB4-';
const SEARCH_QUERY      = 'from:googlealerts-noreply@google.com newer_than:7d';
const BUCKET_NAME       = 'labmind-briefing-ops';
const BRIEFING_SHEET_ID = '1ji1clDmv7YNARpY3TG39ADIC_pbCfdw_fPKVb3lEVLA';

function getSecrets() {
  const props = PropertiesService.getScriptProperties();
  return {
    GEMINI_API_KEY: props.getProperty('GEMINI_API_KEY'),
    RAW_PRIVATE_KEY: props.getProperty('RAW_PRIVATE_KEY'),
    CLIENT_EMAIL: props.getProperty('CLIENT_EMAIL'),
  };
}

function compileWeeklyBriefing() {
  const secrets     = getSecrets();
  const historySet  = loadHistory();
  const threads     = GmailApp.search(SEARCH_QUERY, 0, 100);

  Logger.log(`[DIAGNOSTIC] ===== NEW RUN STARTED =====`);
  Logger.log(`[DIAGNOSTIC] Search query: ${SEARCH_QUERY}`);
  Logger.log(`[DIAGNOSTIC] Threads found: ${threads.length}`);
  Logger.log(`[DIAGNOSTIC] History size: ${historySet.size} URLs`);

  if (threads.length === 0) {
    Logger.log('[DIAGNOSTIC] ⚠️ CRITICAL: No Gmail threads found. Check:');
    Logger.log('[DIAGNOSTIC]   1. Are Google Alerts arriving in inbox?');
    Logger.log('[DIAGNOSTIC]   2. Is sender address correct?');
    Logger.log('[DIAGNOSTIC]   3. Try manual Gmail search with same query');
    // Still dispatch to trigger diagnostic pipeline
    dispatchRAGJob([], secrets);
    return;
  }

  const doc  = DocumentApp.create('BLK PHX LABS Briefing - ' + new Date().toLocaleDateString());
  const body = doc.getBody();
  const freshArticles = [];
  let totalArticlesParsed = 0;
  let duplicatesBlocked = 0;

  threads.forEach((thread, threadIdx) => {
    try {
      const message  = thread.getMessages().pop();
      const msgDate = message.getDate();
      
      if (!isWithinLookbackWindow(msgDate, 7)) {
        Logger.log(`[DIAGNOSTIC] Thread ${threadIdx + 1}: Outside lookback window (${msgDate})`);
        return;
      }

      const articles = parseForensic(message.getBody());
      totalArticlesParsed += articles.length;
      
      Logger.log(`[DIAGNOSTIC] Thread ${threadIdx + 1}: Parsed ${articles.length} articles`);
      
      articles.forEach((item, artIdx) => {
        if (!historySet.has(item.url)) {
          freshArticles.push(item);
          body.appendParagraph(`• ${item.title}`).setLinkUrl(item.url);
          Logger.log(`[DIAGNOSTIC]   ✓ Fresh #${freshArticles.length}: ${item.title.substring(0, 60)}`);
        } else {
          duplicatesBlocked++;
          Logger.log(`[DIAGNOSTIC]   ✗ Duplicate blocked: ${item.title.substring(0, 60)}`);
        }
      });
    } catch (e) {
      Logger.log(`[DIAGNOSTIC] ⚠️ Thread ${threadIdx + 1} parse error: ${e.message}`);
    }
  });

  Logger.log(`[DIAGNOSTIC] ===== PARSING COMPLETE =====`);
  Logger.log(`[DIAGNOSTIC] Total articles parsed: ${totalArticlesParsed}`);
  Logger.log(`[DIAGNOSTIC] Fresh articles: ${freshArticles.length}`);
  Logger.log(`[DIAGNOSTIC] Duplicates blocked: ${duplicatesBlocked}`);
  Logger.log(`[DIAGNOSTIC] Block rate: ${(duplicatesBlocked / Math.max(totalArticlesParsed, 1) * 100).toFixed(1)}%`);

  // CHANGED: Always save and dispatch, even with 0 articles
  doc.saveAndClose();
  moveFileToFolder(doc.getId(), TARGET_FOLDER_ID);

  if (freshArticles.length === 0) {
    Logger.log('[DIAGNOSTIC] ⚠️ WARNING: Zero fresh articles — dispatching anyway for diagnostics');
    Logger.log('[DIAGNOSTIC] This will help identify if the problem is in:');
    Logger.log('[DIAGNOSTIC]   - Gmail sourcing (this script)');
    Logger.log('[DIAGNOSTIC]   - Article scraping (Cloud Function)');
    Logger.log('[DIAGNOSTIC]   - Relevance scoring (Cloud Function)');
  }

  saveHistory(freshArticles);
  updateBriefingSheet(freshArticles);
  dispatchRAGJob(freshArticles, secrets);
  
  Logger.log(`[DIAGNOSTIC] ===== DISPATCH COMPLETE =====`);
}

function dispatchRAGJob(articles, secrets) {
  const uniqueArticles = [...new Map(articles.map(a => [a.url, a])).values()];

  const payload = {
    action:   'deep_dive_rag',
    articles: uniqueArticles.slice(0, 200),
    api_key:  secrets.GEMINI_API_KEY
  };

  Logger.log(`[DIAGNOSTIC] RAG payload: ${payload.articles.length} articles`);
  if (payload.articles.length > 0) {
    Logger.log(`[DIAGNOSTIC] First 3 article titles:`);
    payload.articles.slice(0, 3).forEach((a, i) => {
      Logger.log(`[DIAGNOSTIC]   ${i + 1}. ${a.title}`);
    });
  }
  
  uploadFileToGCS(JSON.stringify(payload), 'queue/trigger_job.json', 'application/json', secrets);
}

function uploadFileToGCS(content, filename, mimeType, secrets) {
  try {
    const service = getGcpService(secrets);
    if (!service.hasAccess()) {
      Logger.log('[DIAGNOSTIC] ⚠️ GCS Auth failed: ' + service.getLastError());
      return;
    }
    const token       = service.getAccessToken();
    const encodedName = encodeURIComponent(filename);

    const response = UrlFetchApp.fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET_NAME}/o?uploadType=media&name=${encodedName}`,
      {
        method:             'POST',
        contentType:        mimeType,
        payload:            content,
        headers:            { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      }
    );
    
    const statusCode = response.getResponseCode();
    Logger.log(`[DIAGNOSTIC] GCS Upload Status: ${statusCode}`);
    
    if (statusCode !== 200) {
      Logger.log('[DIAGNOSTIC] ⚠️ GCS Error Body: ' + response.getContentText());
    } else {
      Logger.log('[DIAGNOSTIC] ✓ Job successfully uploaded to GCS');
    }
  } catch (e) {
    Logger.log('[DIAGNOSTIC] ⚠️ GCS Upload Exception: ' + e.message);
  }
}

function getGcpService(secrets) {
  const cleanKey = secrets.RAW_PRIVATE_KEY.replace(/\\n/g, '\n').trim();
  return OAuth2.createService('GCP')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setPrivateKey(cleanKey)
    .setIssuer(secrets.CLIENT_EMAIL)
    .setSubject(secrets.CLIENT_EMAIL)
    .setPropertyStore(PropertiesService.getScriptProperties())
    .setScope('https://www.googleapis.com/auth/cloud-platform');
}

function resetGCSAuth() {
  const secrets = getSecrets();
  getGcpService(secrets).reset();
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log('Authorization cleared. Re-run compileWeeklyBriefing to re-authenticate.');
}

function loadHistory() {
  try {
    const sheet   = getOrInitDb();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return new Set();
    const urls = sheet.getRange(2, 3, lastRow - 1, 1).getValues().flat().filter(Boolean);
    Logger.log(`[DIAGNOSTIC] History loaded: ${urls.length} seen URLs`);
    return new Set(urls);
  } catch (e) {
    Logger.log('[DIAGNOSTIC] loadHistory error: ' + e.message);
    return new Set();
  }
}

function saveHistory(articles) {
  try {
    const sheet = getOrInitDb();
    const now   = new Date();
    const rows  = articles.map(a => [now, a.title || '', a.url || '']);
    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
      Logger.log(`[DIAGNOSTIC] History saved: ${rows.length} new URLs persisted`);
    }
    // CHANGED: Reduced from 7 days to 2 days to reduce duplicate blocking
    purgeOldHistory(sheet, 2);
  } catch (e) {
    Logger.log('[DIAGNOSTIC] saveHistory error: ' + e.message);
  }
}

function purgeOldHistory(sheet, days) {
  try {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const timestamps = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    let purgeCount   = 0;

    for (let i = timestamps.length - 1; i >= 0; i--) {
      const rowDate = new Date(timestamps[i][0]);
      if (!isNaN(rowDate) && rowDate < cutoff) {
        sheet.deleteRow(i + 2);
        purgeCount++;
      }
    }

    if (purgeCount > 0) {
      Logger.log(`[DIAGNOSTIC] History purged: ${purgeCount} rows older than ${days} days removed`);
    }
  } catch (e) {
    Logger.log('[DIAGNOSTIC] purgeOldHistory error: ' + e.message);
  }
}

function getOrInitDb() {
  const files = DriveApp.searchFiles("title = 'BlkPhxLabs_Link_DB' and trashed = false");
  if (files.hasNext()) {
    return SpreadsheetApp.open(files.next()).getSheets()[0];
  }
  const sheet = SpreadsheetApp.create('BlkPhxLabs_Link_DB').getSheets()[0];
  sheet.appendRow(['Timestamp', 'Title', 'URL']);
  Logger.log('[DIAGNOSTIC] New history database created');
  return sheet;
}

function updateBriefingSheet(articles) {
  try {
    const ss    = SpreadsheetApp.openById(BRIEFING_SHEET_ID);
    const sheet = ss.getSheets()[0];

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Date Found', 'Article Title', 'Article URL']);
      sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#00ff41');
      sheet.setFrozenRows(1);
      Logger.log('[DIAGNOSTIC] Briefing sheet initialized with headers');
    }

    const now  = new Date();
    const rows = articles.map(a => [now, a.title || '', a.url || '']);
    if (rows.length === 0) return;

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
    sheet.autoResizeColumns(1, 3);
    Logger.log(`[DIAGNOSTIC] Briefing sheet updated: ${rows.length} rows appended`);
  } catch (e) {
    Logger.log('[DIAGNOSTIC] updateBriefingSheet error: ' + e.message);
  }
}

function moveFileToFolder(fileId, folderId) {
  try {
    DriveApp.getFileById(fileId).moveTo(DriveApp.getFolderById(folderId));
  } catch (e) {
    Logger.log('[DIAGNOSTIC] moveFileToFolder error: ' + e.message);
  }
}

function parseForensic(html) {
  const results = [];
  const regex   = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  let linkCount = 0;

  while ((match = regex.exec(html)) !== null) {
    linkCount++;
    let url   = match[1];
    let title = match[2].replace(/<[^>]+>/g, '').trim();

    if (url.includes('google.com/url')) {
      try {
        url = decodeURIComponent(url.split('url=')[1].split('&')[0]);
      } catch (e) {
        continue;
      }
    }

    if (!url.includes('google.com') && title.length > 0) {
      results.push({ title, url });
    }
  }
  
  Logger.log(`[DIAGNOSTIC] parseForensic: ${linkCount} total links, ${results.length} extracted`);
  return results;
}

function isWithinLookbackWindow(date, days) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days);
  return new Date(date) >= cutoff;
}
