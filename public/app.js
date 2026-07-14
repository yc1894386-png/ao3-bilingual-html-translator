if (!window.fetch) {
  window.fetch = (url, options = {}) => {
    if (window.XMLHttpRequest) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(options.method || "GET", url);
        for (const [key, value] of Object.entries(options.headers || {})) xhr.setRequestHeader(key, value);
        xhr.onload = () => {
          const responseText = xhr.responseText || "";
          resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            statusText: xhr.statusText,
            text: () => Promise.resolve(responseText),
            json: () => Promise.resolve(responseText ? JSON.parse(responseText) : {})
          });
        };
        xhr.onerror = () => reject(new TypeError("Network request failed."));
        xhr.send(options.body ?? null);
      });
    }
    if ((options.method || "GET").toUpperCase() !== "POST") {
      return Promise.reject(new TypeError("This browser can only send POST requests."));
    }
    return new Promise((resolve, reject) => {
      const id = "formFetch" + Date.now() + Math.random().toString(16).slice(2);
      const iframe = document.createElement("iframe");
      const form = document.createElement("form");
      const input = document.createElement("textarea");
      iframe.name = id;
      iframe.hidden = true;
      form.hidden = true;
      form.method = "POST";
      form.action = url;
      form.target = id;
      form.enctype = "application/x-www-form-urlencoded";
      input.name = "body";
      input.value = String(options.body || "");
      form.appendChild(input);
      document.body.append(iframe, form);
      iframe.onload = () => {
        try {
          const responseText = iframe.contentDocument?.body?.textContent || "";
          resolve({
            ok: true,
            status: 200,
            statusText: "OK",
            text: () => Promise.resolve(responseText),
            json: () => Promise.resolve(responseText ? JSON.parse(responseText) : {})
          });
        } catch (error) {
          reject(error);
        } finally {
          form.remove();
          iframe.remove();
        }
      };
      form.submit();
    });
  };
}
document.documentElement.dataset.appJs = "started";
window.addEventListener("error", (event) => {
  const status = document.querySelector("#statusText");
  if (status) status.textContent = `Script error: ${event.message || "unknown"}`;
});
window.addEventListener("unhandledrejection", (event) => {
  const status = document.querySelector("#statusText");
  if (status) status.textContent = `Script error: ${event.reason?.message || event.reason || "unknown"}`;
});

const state = {
  fileName: "",
  rawHtml: "",
  metadata: null,
  segments: [],
  mode: "bilingual",
  previewAll: false,
  previewVisibleCount: 120,
  previewMissingOnly: false,
  works: [],
  currentWorkIndex: -1,
  segmentById: new Map()
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const PREVIEW_LIMIT = 60;
const PREVIEW_PAGE_SIZE = 100;
const GLOSSARY_STORAGE_KEY = "ao3TranslatorGlossary";
const GOOGLE_CONTEXT_STORAGE_KEY = "ao3GoogleContextMode";
const READER_NAME_STORAGE_KEY = "ao3TranslatorReaderName";
const READER_NAME_EN_STORAGE_KEY = "ao3TranslatorReaderNameEn";
const SESSION_DB_NAME = "ao3TranslatorSessionDb";
const SESSION_STORE_NAME = "sessions";
const SESSION_RECORD_KEY = "latest";
const SESSION_FALLBACK_KEY = "ao3TranslatorSessionFallback";
const SESSION_FALLBACK_CHUNK_PREFIX = "ao3TranslatorSessionFallbackChunk:";
const GOOGLE_CONTEXT_MAX_ITEMS = 36;
const GOOGLE_CONTEXT_MAX_CHARS = 28000;
const GOOGLE_NORMAL_MAX_ITEMS = 30;
const GOOGLE_NORMAL_MAX_CHARS = 22000;
const GOOGLE_FAST_CONCURRENCY = 4;
const GOOGLE_FAST_SPLIT_ITEMS = 8;
const AI_CHUNK_LIMITS = {
  doubao: { maxItems: 14, maxChars: 16000 },
  doubaoFallback: { maxItems: 4, maxChars: 4200 },
  deepseek: { maxItems: 10, maxChars: 10500 },
  polishDoubao: { maxItems: 2, maxChars: 2600 },
  polishDeepseek: { maxItems: 10, maxChars: 10000 }
};

const els = {
  fileInput: $("#fileInput"),
  dropZone: $("#dropZone"),
  fileMeta: $("#fileMeta"),
  latestDownloadButton: $("#latestDownloadButton"),
  localPathInput: $("#localPathInput"),
  localPathButton: $("#localPathButton"),
  importFolderButton: $("#importFolderButton"),
  importFolderHint: $("#importFolderHint"),
  workList: $("#workList"),
  providerSelect: $("#providerSelect"),
  googleContextMode: $("#googleContextMode"),
  googleContextRow: $("#googleContextRow"),
  aiSettings: $("#aiSettings"),
  apiKeyInput: $("#apiKeyInput"),
  keyStatus: $("#keyStatus"),
  endpointInput: $("#endpointInput"),
  modelInput: $("#modelInput"),
  glossaryInput: $("#glossaryInput"),
  termSourceInput: $("#termSourceInput"),
  termTargetInput: $("#termTargetInput"),
  addTermButton: $("#addTermButton"),
  readerNameEnInput: $("#readerNameEnInput"),
  readerNameInput: $("#readerNameInput"),
  applyReaderNameButton: $("#applyReaderNameButton"),
  presetGlossaryButton: $("#presetGlossaryButton"),
  applyGlossaryButton: $("#applyGlossaryButton"),
  startButton: $("#startButton"),
  stopButton: $("#stopButton"),
  startAllButton: $("#startAllButton"),
  doubaoMissingButton: $("#doubaoMissingButton"),
  polishButton: $("#polishButton"),
  doubaoPolishButton: $("#doubaoPolishButton"),
  clearTranslationsButton: $("#clearTranslationsButton"),
  progressFill: $("#progressFill"),
  statusText: $("#statusText"),
  exportTitleInput: $("#exportTitleInput"),
  titleSuggestButton: $("#titleSuggestButton"),
  titleIdeas: $("#titleIdeas"),
  exportButtons: $$("[data-export]"),
  epubButtons: $$("[data-epub]"),
  workTitle: $("#workTitle"),
  workMeta: $("#workMeta"),
  preview: $("#preview"),
  togglePreviewButton: $("#togglePreviewButton"),
  modeButtons: $$("[data-mode]")
};

let hasServerDeepSeekKey = false;
let hasServerDoubaoKey = false;
const selectedSegmentIds = new Set();
let previewRenderTimer = 0;
let previewRenderQueued = false;
let previewEditSaveTimer = 0;
let workListRenderTimer = 0;
let lastWorkListKey = "";
let rawInflateLoader = null;
let sessionSaveTimer = 0;
let sessionSaveInFlight = false;
let sessionSaveAgain = false;
let restoringSession = false;
let bulkTranslateMode = false;
let translationStopRequested = false;

function setStatus(message = "", isError = false) {
  if (!els.statusText) return;
  els.statusText.textContent = message;
  els.statusText.classList.toggle("error", Boolean(isError));
}

function setProgress(done = 0, total = 0) {
  const safeDone = Math.max(0, Number(done || 0));
  const safeTotal = Math.max(0, Number(total || 0));
  if (els.progressFill) {
    const percent = safeTotal ? (safeDone / safeTotal) * 100 : 0;
    els.progressFill.style.width = `${safeDone < safeTotal ? Math.min(99, percent) : 100}%`;
  }
}

function setBusy(value) {
  document.body.classList.toggle("busy", Boolean(value));
  if (els.stopButton) els.stopButton.disabled = !value;
}

function isDecorativeText(value = "") {
  const compact = String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, "")
    .trim();
  if (!compact) return true;
  if (/[A-Za-z0-9\u4e00-\u9fff]/.test(compact)) return false;
  return compact.length <= 80 && /^[\p{P}\p{S}]+$/u.test(compact);
}

function isDecorativeSegment(segment) {
  return Boolean(segment?.decorative || isDecorativeText(segment?.originalText || ""));
}

function isTranslatedSegment(segment) {
  if (isDecorativeSegment(segment)) return true;
  if (!segment) return false;
  const html = segment.translationHtml || "";
  if (segment._checkedTranslationHtml === html && typeof segment._isTranslated === "boolean") return segment._isTranslated;
  segment._checkedTranslationHtml = html;
  segment._isTranslated = Boolean(html && !isEffectivelyUntranslated(segment, html));
  return segment._isTranslated;
}

function rebuildSegmentIndex(work = activeWork()) {
  state.segmentById = new Map();
  state.segments.forEach((segment, index) => {
    segment.index = index;
    state.segmentById.set(segment.id, segment);
  });
  if (work) {
    work.segmentById = state.segmentById;
    work.progressDone = state.segments.filter(isTranslatedSegment).length;
    work.progressTotal = state.segments.length;
  }
}

function recalculateWorkProgress(work = activeWork()) {
  if (!work) return { done: 0, total: 0 };
  const total = work.segments?.length || 0;
  const done = (work.segments || []).filter(isTranslatedSegment).length;
  work.progressDone = done;
  work.progressTotal = total;
  return { done, total };
}

function safeRenderPreview() {
  try {
    renderPreview();
  } catch (error) {
    els.preview.innerHTML = '<p class="empty error">Preview paused after an error. Your translation is saved locally; refresh to restore.</p>';
    setStatus("Preview paused after an error. Your translation is saved locally; refresh to restore.", true);
    scheduleSessionSave(100);
  }
}

function schedulePreviewRender(force = false) {
  if (els.preview?.contains(document.activeElement) && document.activeElement?.closest?.(".zh")) return;
  if (force) {
    if (previewRenderTimer) clearTimeout(previewRenderTimer);
    previewRenderTimer = 0;
    previewRenderQueued = false;
    safeRenderPreview();
    return;
  }
  if (previewRenderQueued) return;
  previewRenderQueued = true;
  previewRenderTimer = window.setTimeout(() => {
    requestAnimationFrame(() => {
      previewRenderQueued = false;
      previewRenderTimer = 0;
      safeRenderPreview();
    });
  }, 800);
}

function scheduleWorkListRender(force = false) {
  const key = state.works.map((work, index) => `${index === state.currentWorkIndex ? "*" : ""}${work.fileName}:${work.progressDone || 0}/${work.progressTotal || work.segments?.length || 0}`).join("|");
  if (!force && key === lastWorkListKey) return;
  lastWorkListKey = key;
  if (force) {
    if (workListRenderTimer) clearTimeout(workListRenderTimer);
    workListRenderTimer = 0;
    renderWorkList();
    return;
  }
  if (workListRenderTimer) return;
  workListRenderTimer = window.setTimeout(() => {
    workListRenderTimer = 0;
    renderWorkList();
  }, 500);
}

function activeWork() {
  return state.works[state.currentWorkIndex] || null;
}

function openSessionDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("IndexedDB is not available."));
    const request = indexedDB.open(SESSION_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SESSION_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local save."));
  });
}

function clearFallbackSession() {
  if (!("localStorage" in window)) return;
  const count = Number(localStorage.getItem(SESSION_FALLBACK_KEY) || 0);
  for (let i = 0; i < count; i += 1) localStorage.removeItem(SESSION_FALLBACK_CHUNK_PREFIX + i);
  localStorage.removeItem(SESSION_FALLBACK_KEY);
}

function writeFallbackSession(snapshot) {
  if (!("localStorage" in window)) throw new Error("Local storage is not available.");
  const text = JSON.stringify(snapshot);
  const chunkSize = 250000;
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));
  clearFallbackSession();
  chunks.forEach((chunk, index) => localStorage.setItem(SESSION_FALLBACK_CHUNK_PREFIX + index, chunk));
  localStorage.setItem(SESSION_FALLBACK_KEY, String(chunks.length));
}

function readFallbackSession() {
  if (!("localStorage" in window)) return null;
  const count = Number(localStorage.getItem(SESSION_FALLBACK_KEY) || 0);
  if (!count) return null;
  let text = "";
  for (let i = 0; i < count; i += 1) text += localStorage.getItem(SESSION_FALLBACK_CHUNK_PREFIX + i) || "";
  return text ? JSON.parse(text) : null;
}

async function readSessionSnapshot() {
  try {
    const db = await openSessionDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE_NAME, "readonly");
      const request = tx.objectStore(SESSION_STORE_NAME).get(SESSION_RECORD_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read local save."));
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    });
  } catch {
    return readFallbackSession();
  }
}

async function writeSessionSnapshot(snapshot) {
  try {
    const db = await openSessionDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE_NAME, "readwrite");
      tx.objectStore(SESSION_STORE_NAME).put(snapshot, SESSION_RECORD_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error("Could not save locally."));
      };
    });
  } catch {
    writeFallbackSession(snapshot);
  }
}

async function deleteSessionSnapshot() {
  clearFallbackSession();
  try {
    const db = await openSessionDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE_NAME, "readwrite");
      tx.objectStore(SESSION_STORE_NAME).delete(SESSION_RECORD_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error("Could not clear local save."));
      };
    });
  } catch (error) {
    console.warn("Local session clear failed", error);
  }
}

function plainWorkForSave(work) {
  return {
    fileName: work.fileName || "",
    rawHtml: "",
    metadata: work.metadata || null,
    segments: (work.segments || []).map((segment) => ({
      id: segment.id,
      index: segment.index,
      key: segment.key,
      tag: segment.tag,
      kind: segment.kind,
      scope: segment.scope,
      chapterKey: segment.chapterKey || "",
      chapterTitle: segment.chapterTitle || "",
      chapterOrder: segment.chapterOrder || 0,
      originalHtml: segment.originalHtml,
      originalText: segment.originalText,
      decorative: Boolean(segment.decorative),
      translationHtml: segment.translationHtml || "",
      failedReason: segment.failedReason || ""
    })),
    exportTitle: work.exportTitle || "",
    selectedIds: [...(work.selectedIds || [])],
    sizeKb: work.sizeKb || "",
    progressDone: work.progressDone || 0,
    progressTotal: work.progressTotal || 0,
    status: work.status || ""
  };
}

function sessionSnapshot() {
  return {
    savedAt: Date.now(),
    currentWorkIndex: state.currentWorkIndex,
    mode: state.mode,
    previewAll: state.previewAll,
    previewVisibleCount: state.previewVisibleCount,
    works: state.works.map(plainWorkForSave)
  };
}

async function saveSessionNow() {
  if (restoringSession || !state.works.length) return;
  if (sessionSaveInFlight) {
    sessionSaveAgain = true;
    return;
  }
  sessionSaveInFlight = true;
  try {
    await writeSessionSnapshot(sessionSnapshot());
  } catch (error) {
    console.warn("Local session save failed", error);
  } finally {
    sessionSaveInFlight = false;
    if (sessionSaveAgain) {
      sessionSaveAgain = false;
      scheduleSessionSave(250);
    }
  }
}

function scheduleSessionSave(delay = 900) {
  if (restoringSession) return;
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = window.setTimeout(() => {
    sessionSaveTimer = 0;
    saveSessionNow();
  }, delay);
}

function restoreWorkShape(work) {
  return {
    fileName: work.fileName || "",
    rawHtml: work.rawHtml || "",
    metadata: work.metadata || null,
    segments: Array.isArray(work.segments) ? work.segments : [],
    exportTitle: work.exportTitle || "",
    selectedIds: Array.isArray(work.selectedIds) ? work.selectedIds : [],
    sizeKb: work.sizeKb || "",
    progressDone: Number(work.progressDone || 0),
    progressTotal: Number(work.progressTotal || work.segments?.length || 0),
    status: work.status || ""
  };
}

async function restoreSavedSession() {
  try {
    const snapshot = await readSessionSnapshot();
    if (!snapshot?.works?.length || state.works.length) return false;
    restoringSession = true;
    state.works = snapshot.works.map(restoreWorkShape);
    state.mode = snapshot.mode || "bilingual";
    state.previewAll = false;
    state.previewVisibleCount = PREVIEW_LIMIT;
    state.currentWorkIndex = -1;
    els.modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
    setActiveWork(Math.min(Math.max(Number(snapshot.currentWorkIndex || 0), 0), state.works.length - 1));
    updateFileMeta();
    setStatus("Restored local autosave. Your previous translations are back.");
    return true;
  } catch (error) {
    console.warn("Local session restore failed", error);
    return false;
  } finally {
    restoringSession = false;
  }
}

function saveActiveSelection() {
  const work = activeWork();
  if (work) {
    work.selectedIds = [...selectedSegmentIds];
    scheduleSessionSave();
  }
}

function setActiveWork(index) {
  saveActiveSelection();
  const work = state.works[index];
  if (!work) return;
  state.currentWorkIndex = index;
  state.fileName = work.fileName;
  state.rawHtml = work.rawHtml;
  state.metadata = work.metadata;
  state.segments = work.segments;
  state.previewVisibleCount = PREVIEW_LIMIT;
  state.previewMissingOnly = false;
  rebuildSegmentIndex(work);
  selectedSegmentIds.clear();
  for (const id of work.selectedIds || []) selectedSegmentIds.add(id);
  els.exportTitleInput.value = work.exportTitle || neatTitle(work.metadata?.title || work.fileName);
  setProgress(work.progressDone || 0, work.progressTotal || work.segments.length || 0);
  setStatus(work.status || `Opened ${work.fileName}.`);
  updateReady();
  scheduleWorkListRender(true);
  if (!bulkTranslateMode) schedulePreviewRender(true);
  scheduleSessionSave(bulkTranslateMode ? 4000 : 900);
}

function syncActiveWork() {
  const work = activeWork();
  if (!work) return;
  work.fileName = state.fileName;
  work.rawHtml = state.rawHtml;
  work.metadata = state.metadata;
  work.segments = state.segments;
  work.exportTitle = els.exportTitleInput.value.trim();
  work.selectedIds = [...selectedSegmentIds];
  work.progressDone = state.segments.filter(isTranslatedSegment).length;
  work.progressTotal = state.segments.length;
  scheduleSessionSave((bulkTranslateMode || document.body.classList.contains("busy")) ? 4000 : 900);
}

function updateFileMeta() {
  if (!els.fileMeta) return;
  if (!state.works.length) {
    els.fileMeta.textContent = "or drag files here";
    return;
  }
  if (state.works.length === 1) {
    const work = state.works[0];
    els.fileMeta.textContent = work.sizeKb ? `${work.fileName} - ${work.sizeKb} KB` : work.fileName;
    return;
  }
  els.fileMeta.textContent = `${state.works.length} works loaded`;
}

function resetActiveWork(message = "No file loaded.") {
  state.fileName = "";
  state.rawHtml = "";
  state.metadata = null;
  state.segments = [];
  state.previewVisibleCount = PREVIEW_LIMIT;
  state.previewMissingOnly = false;
  state.segmentById = new Map();
  state.currentWorkIndex = -1;
  selectedSegmentIds.clear();
  if (els.exportTitleInput) els.exportTitleInput.value = "";
  setProgress(0, 0);
  updateFileMeta();
  updateReady();
  scheduleWorkListRender(true);
  schedulePreviewRender(true);
  setStatus(message);
  if (!restoringSession) deleteSessionSnapshot();
}

function removeWork(index) {
  if (document.body.classList.contains("busy") && index === state.currentWorkIndex) {
    setStatus("Translation is still running. Stop or wait before deleting this work.", true);
    return;
  }
  const work = state.works[index];
  if (!work) return;
  const title = work.metadata?.title || work.fileName || `Work ${index + 1}`;
  const confirmed = window.confirm(`Delete "${title}" from this page?\n\nThis will not delete the original file from your computer.`);
  if (!confirmed) return;

  if (index === state.currentWorkIndex) selectedSegmentIds.clear();
  state.works.splice(index, 1);

  if (!state.works.length) {
    resetActiveWork(`Deleted "${title}".`);
    return;
  }

  if (index === state.currentWorkIndex) {
    state.currentWorkIndex = -1;
    setActiveWork(Math.min(index, state.works.length - 1));
  } else {
    if (index < state.currentWorkIndex) state.currentWorkIndex -= 1;
    scheduleWorkListRender(true);
  }
  updateFileMeta();
  scheduleSessionSave(100);
  setStatus(`Deleted "${title}".`);
}

const providerDefaults = {
  google: {
    endpoint: "",
    model: ""
  },
  doubao: {
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    model: "doubao-seed-2-1-pro-260628"
  },
  deepseek: {
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash"
  }
};

const corePresets = [
  ["Leon", "里昂"],
  ["Leon S. Kennedy", "里昂·S·肯尼迪"],
  ["Leon Kennedy", "里昂·肯尼迪"],
  ["Rebecca", "瑞贝卡"],
  ["Rebecca Chambers", "瑞贝卡·钱伯斯"],
  ["Claire", "克莱尔"],
  ["Claire Redfield", "克莱尔·雷德菲尔德"],
  ["Chris", "克里斯"],
  ["Chris Redfield", "克里斯·雷德菲尔德"],
  ["Ada", "艾达"],
  ["Ada Wong", "艾达·王"],
  ["Ashley", "阿什莉"],
  ["Ashley Graham", "阿什莉·格拉汉姆"],
  ["Luis", "路易斯"],
  ["Luis Serra", "路易斯·塞拉"],
  ["Wesker", "威斯克"],
  ["Albert Wesker", "阿尔伯特·威斯克"],
  ["Raccoon City", "浣熊市"],
  ["BSAA", "BSAA"],
  ["S.T.A.R.S.", "S.T.A.R.S."],
  ["Omega", "Omega"],
  ["Alpha", "Alpha"],
  ["Beta", "Beta"],
  ["omega", "omega"],
  ["alpha", "alpha"],
  ["beta", "beta"],
  ["zombies", "丧尸"],
  ["zoobies", "丧尸"],
  ["zoobie", "丧尸"],
  ["sister", "妹妹"],
  ["Sergeant", "中士"],
  ["captain", "队长"],
  ["Elpis", "厄尔庇斯"],
  ["M/M", "男/男"],
  ["F/M", "女/男"],
  ["F/F", "女/女"],
  ["Gen", "无CP"],
  ["Explicit", "成人级"],
  ["Mature", "成熟级"],
  ["Teen And Up Audiences", "青少年及以上"],
  ["Archive Warning", "AO3警告"],
  ["No Archive Warnings Apply", "无AO3警告"],
  ["force", "按语境：强迫 / 用力 / 迫使"],
  ["forced", "按语境：被迫 / 强迫"],
  ["forze", "按语境：force 拼写错误，通常译作强迫/用力"],
  ["frozen", "按语境：僵住 / 冻僵 / 冰冷"],
  ["forzen", "按语境：frozen 拼写错误，通常译作僵住/冻僵"],
  ["move", "按语境：走 / 动身 / 快走 / 移动"],
  ["let's move", "走吧 / 快走"],
];

const legacyPresets = corePresets;
const presets = corePresets;

function looksMojibake(value = "") {
  return false;
}

function textWithBreaks(html = "") {
  const div = document.createElement("div");
  div.innerHTML = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<\/div\s*>/gi, "\n");
  return div.textContent.replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
}

function textOnly(html = "") {
  const div = document.createElement("div");
  div.innerHTML = String(html || "");
  return (div.textContent || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function innerHtml(html = "") {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.firstElementChild ? doc.body.firstElementChild.innerHTML : doc.body.innerHTML;
}

function cleanTitle(value = "") {
  return textOnly(value)
    .replace(/\s*\|\s*Archive[\s\S]*$/i, "")
    .replace(/\s*-\s*Archive of Our Own[\s\S]*$/i, "")
    .replace(/\s*-\s*AO3[\s\S]*$/i, "")
    .trim();
}

function neatTitle(value = "") {
  return cleanTitle(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([:;,.!?])/g, "$1")
    .trim();
}

function sanitize(root) {
  root.querySelectorAll("script, iframe, object, embed, form").forEach((node) => node.remove());
  root.querySelectorAll("*").forEach((node) => {
    [...node.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value || "";
      if (name.startsWith("on")) node.removeAttribute(attr.name);
      if ((name === "href" || name === "src") && /^javascript:/i.test(value)) node.removeAttribute(attr.name);
    });
  });
}

function normalizeAo3BreakParagraphs(root) {
  const candidates = [...root.querySelectorAll(".userstuff p, .userstuff div, #workskin p, #workskin div")];
  for (const node of candidates) {
    if (node.closest("#footer, .navigation, .actions, .landmark")) continue;
    if (node.querySelector("p, li, blockquote, div")) continue;
    if (!node.querySelector("br")) continue;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (text.length < 120) continue;

    const html = node.innerHTML.trim();
    let parts = html
      .split(/(?:\s*<br\s*\/?>\s*){2,}/i)
      .map((part) => part.replace(/^(?:\s*<br\s*\/?>\s*)+|(?:\s*<br\s*\/?>\s*)+$/gi, "").trim())
      .filter((part) => textOnly(part).length > 0);

    if (parts.length <= 1 && text.length > 600) {
      parts = html
        .split(/\s*<br\s*\/?>\s*/i)
        .map((part) => part.trim())
        .filter((part) => textOnly(part).length > 0);
    }

    if (parts.length <= 1) continue;
    const fragment = node.ownerDocument.createDocumentFragment();
    for (const part of parts) {
      for (const piece of splitLongHtmlPart(part)) {
        const p = node.ownerDocument.createElement("p");
        p.innerHTML = piece;
        fragment.appendChild(p);
      }
    }
    node.replaceWith(fragment);
  }
}

function markAo3ChapterTitles(root) {
  const selectors = [
    ".chapter > .title",
    ".chapter > h1.title",
    ".chapter > h2.title",
    ".chapter > h3.title",
    ".chapter > header .title",
    "section.chapter > h1",
    "section.chapter > h2",
    "section.chapter > h3",
    "article.chapter > h1",
    "article.chapter > h2",
    "article.chapter > h3",
    "body > h1",
    "body > h2"
  ];
  root.querySelectorAll(selectors.join(",")).forEach((node) => {
    if (node.closest(".summary, .notes, dl.meta, .meta, #footer, .navigation, .actions, .landmark")) return;
    node.dataset.ao3ChapterTitle = "1";
  });
}

function chapterContainerForNode(node) {
  const chapter = node.closest?.("section.chapter, article.chapter, .chapter, [id^='chapter-']");
  if (!chapter || chapter.closest(".summary, .notes, dl.meta, .meta, #footer, .navigation, .actions, .landmark")) return null;
  return chapter;
}

function ao3FlowChapterMarkerForNode(node) {
  const root = node.closest?.("#chapters");
  if (!root) return null;
  let child = node;
  while (child && child.parentElement !== root) child = child.parentElement;
  if (!child) child = node.closest?.(".userstuff, .meta.group, blockquote, div, section, article") || node;
  for (let cursor = child; cursor; cursor = cursor.previousElementSibling) {
    if (!cursor.matches?.(".meta.group")) continue;
    const heading = cursor.querySelector("h1.heading, h2.heading, h3.heading, .heading, h1, h2, h3");
    const title = cleanExportText(heading?.textContent || "");
    if (title && !/^(summary|notes?|chapter text|work text|preface|end notes?)$/i.test(title)) return cursor;
  }
  return null;
}

function chapterTitleFromAo3Marker(marker) {
  const heading = marker?.querySelector?.("h1.heading, h2.heading, h3.heading, .heading, h1, h2, h3");
  const text = cleanExportText(heading?.textContent || "");
  if (!text || text.length > 160) return "";
  if (/^(summary|notes?|chapter text|work text|preface|end notes?)$/i.test(text)) return "";
  return text;
}

function chapterTitleFromContainer(chapter) {
  const heading = chapter?.querySelector?.("[data-ao3-chapter-title='1'], h1.title, h2.title, h3.title, .title, h1, h2, h3");
  const text = cleanExportText(heading?.textContent || "");
  if (!text || text.length > 160) return "";
  if (/^(summary|notes?|chapter text|work text|preface|end notes?)$/i.test(text)) return "";
  return text;
}

function ao3FlowChapterBlockCount(doc) {
  let count = 0;
  for (const root of doc.querySelectorAll("#chapters")) {
    let hasOpenChapter = false;
    for (const child of root.children) {
      if (child.matches?.(".meta.group")) {
        if (chapterTitleFromAo3Marker(child)) hasOpenChapter = true;
        continue;
      }
      if (hasOpenChapter && child.matches?.(".userstuff, blockquote, div, section, article")) {
        if (translatableNodes(child).length) {
          count += 1;
          hasOpenChapter = false;
        }
      }
    }
  }
  return count;
}

function splitLongHtmlPart(html) {
  const text = textOnly(html);
  if (text.length <= 1800 || /<[^>]+>/.test(html)) return [html];
  const sentences = html.match(/[^.!?\u3002\uff01\uff1f]+[.!?\u3002\uff01\uff1f"']?\s*|[^.!?\u3002\uff01\uff1f]+$/g) || [html];
  const parts = [];
  let current = "";
  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    if (current && (current.length + sentence.length > 1400)) {
      parts.push(current.trim());
      current = "";
    }
    current += `${current ? " " : ""}${sentence}`;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length > 1 ? parts : [html];
}

function translatableNodes(root) {
  const selector = [
    "h2.title.heading",
    "[data-ao3-chapter-title='1']",
    "section.chapter > h1",
    "section.chapter > h2",
    "section.chapter > h3",
    "article.chapter > h1",
    "article.chapter > h2",
    "article.chapter > h3",
    ".chapter .title",
    ".preface .title",
    ".preface .heading",
    ".summary .heading",
    ".notes .heading",
    "h3.title",
    ".userstuff p",
    ".userstuff li",
    ".userstuff blockquote",
    ".userstuff div",
    "#workskin p",
    "#workskin li",
    "#workskin blockquote",
    "#workskin div",
    ".tags a",
    "dd.rating a",
    "dd.warning a",
    "dd.category a",
    "dd.fandom a",
    "dd.relationship a",
    "dd.character a",
    "dd.freeform a"
  ].join(",");

  const seen = new Set();
  return [...root.querySelectorAll(selector)].filter((node) => {
    if (seen.has(node)) return false;
    seen.add(node);
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (text.length < 2) return false;
    if (node.closest("#footer, .navigation, .actions, .landmark")) return false;
    return !node.querySelector("p, li, blockquote, div");
  });
}

function segmentKind(node) {
  if (node.matches("dd.rating a, dd.warning a, dd.category a, dd.fandom a, dd.relationship a, dd.character a, dd.freeform a, .tags a")) {
    return "meta";
  }
  if (node.closest(".userstuff, #workskin, .chapter, section.chapter, article.chapter") || node.matches("[data-ao3-chapter-title='1'], .chapter .title, .preface .title, h2.title.heading")) {
    return "body";
  }
  return "meta";
}


function stableHash(value = "") {
  let hash = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizedSegmentText(nodeOrText = "") {
  const text = typeof nodeOrText === "string" ? nodeOrText : nodeOrText?.textContent || "";
  return String(text)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function segmentScope(node) {
  if (node.matches?.("[data-ao3-chapter-title='1'], section.chapter > h1, section.chapter > h2, section.chapter > h3, article.chapter > h1, article.chapter > h2, article.chapter > h3, .chapter .title")) return "chapter-title";
  if (node.matches?.("h2.title.heading, .chapter .title, .preface .title, .preface .heading")) return "title";
  if (node.closest?.(".summary")) return "summary";
  if (node.closest?.(".notes")) return "notes";
  if (node.closest?.("dl.meta, .meta")) return "meta";
  if (node.closest?.(".userstuff, #workskin, .chapter, section.chapter, article.chapter")) return "body";
  return "other";
}

function segmentKeyBase(node) {
  const tag = node.tagName.toLowerCase();
  const kind = segmentKind(node);
  const scope = segmentScope(node);
  const text = normalizedSegmentText(node);
  return `${kind}|${scope}|${tag}|${stableHash(text)}`;
}

function segmentKeyForNode(node, counters = new Map()) {
  const base = segmentKeyBase(node);
  const count = counters.get(base) || 0;
  counters.set(base, count + 1);
  return `${base}|${count}`;
}

function segmentOriginalHtml(node) {
  if (segmentKind(node) !== "meta") return node.outerHTML;
  const tag = node.tagName.toLowerCase();
  return "<" + tag + ">" + escapeHtml(normalizedSegmentText(node)) + "</" + tag + ">";
}

function segmentIdentity(segment = {}) {
  return [
    segment.kind || "",
    segment.scope || "",
    segment.tag || "",
    stableHash(normalizedSegmentText(segment.originalText || ""))
  ].join("|");
}

function buildSegmentLookup(segments = []) {
  const byKey = new Map();
  const byIdentity = new Map();
  for (const segment of segments) {
    if (segment.key) byKey.set(segment.key, segment);
    const identity = segmentIdentity(segment);
    if (!byIdentity.has(identity)) byIdentity.set(identity, []);
    byIdentity.get(identity).push(segment);
  }
  return { byKey, byIdentity };
}

function segmentForExportNode(node, index, lookup, usedIds, counters) {
  const key = segmentKeyForNode(node, counters);
  const exact = lookup.byKey.get(key);
  if (exact && !usedIds.has(exact.id)) return exact;

  const identity = [
    segmentKind(node),
    segmentScope(node),
    node.tagName.toLowerCase(),
    stableHash(normalizedSegmentText(node))
  ].join("|");
  const candidates = lookup.byIdentity.get(identity) || [];
  const byIdentity = candidates.find((segment) => !usedIds.has(segment.id));
  if (byIdentity) return byIdentity;

  const byIndex = state.segments[index];
  if (byIndex && !usedIds.has(byIndex.id)) {
    const sameText = normalizedSegmentText(byIndex.originalText || "") === normalizedSegmentText(node);
    const sameTag = byIndex.tag === node.tagName.toLowerCase();
    const sameKind = byIndex.kind === segmentKind(node);
    if (sameText && sameTag && sameKind) return byIndex;
  }

  return null;
}

const requiredGlossaryTerms = [
  ["Leon S. Kennedy/Reader", "\u91cc\u6602\u00b7S\u00b7\u80af\u5c3c\u8fea / \u8bfb\u8005"],
  ["Leon Kennedy/Reader", "\u91cc\u6602\u00b7\u80af\u5c3c\u8fea / \u8bfb\u8005"],
  ["Leon", "\u91cc\u6602"],
  ["Leon S. Kennedy", "\u91cc\u6602\u00b7S\u00b7\u80af\u5c3c\u8fea"],
  ["Leon Kennedy", "\u91cc\u6602\u00b7\u80af\u5c3c\u8fea"],
  ["Rebecca", "\u745e\u8d1d\u5361"],
  ["Rebecca Chambers", "\u745e\u8d1d\u5361\u00b7\u94b1\u4f2f\u65af"],
  ["Omega", "omega"],
  ["Alpha", "alpha"],
  ["Beta", "beta"],
  ["omegas", "omegas"],
  ["alphas", "alphas"],
  ["betas", "betas"],
  ["omega", "omega"],
  ["alpha", "alpha"],
  ["beta", "beta"],
  ["zombies", "\u4e27\u5c38"],
  ["zoobies", "\u4e27\u5c38"],
  ["zoobie", "\u4e27\u5c38"],
  ["sister", "\u59b9\u59b9"],
  ["Sergeant", "\u4e2d\u58eb"],
  ["captain", "\u961f\u957f"],
  ["Elpis", "\u5384\u5c14\u5e87\u65af"]
];

function splitGlossaryLine(line = "") {
  const index = String(line).search(/[:\uff1a]/);
  if (index < 0) return null;
  const source = line.slice(0, index).trim();
  const target = line.slice(index + 1).trim();
  return source && target ? { source, target } : null;
}

function parseGlossary() {
  return els.glossaryInput.value
    .split(/\r?\n/)
    .map((line) => splitGlossaryLine(line.trim()))
    .filter(Boolean)
    .sort((a, b) => b.source.length - a.source.length);
}

function cleanGlossaryTarget(target = "") {
  const raw = String(target || "").trim();
  if (/keep as-is|\u4e0d\u7ffb\u8bd1/i.test(raw)) return "";
  const first = raw.split(/[\uFF0C,;\uFF1B]|\s+\/\s+/)[0].trim();
  if (!first || /context|voice|tone|\u6309\u8bed\u5883|\u6309\u89d2\u8272|by /i.test(first)) return "";
  return first;
}

function glossaryTargetForExactText(text = "") {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  for (const item of parseGlossary()) {
    const source = String(item.source || "").replace(/\s+/g, " ").trim();
    if (!source || source !== normalized) continue;
    if (/keep as-is|\u4e0d\u7ffb\u8bd1/i.test(item.target || "")) return source;
    const target = cleanGlossaryTarget(item.target);
    if (target) return target;
  }
  return "";
}

function localMetaTranslation(segment) {
  if (segment.kind !== "meta") return "";
  const target = glossaryTargetForExactText(segment.originalText);
  return target ? localTranslationHtml(segment, target) : "";
}

function looksLikeLeakedAo3Href(text = "") {
  return /%[0-9a-f]{2}|\*s\*|\*d\*|\/works\b|["']\s*>|&quot;\s*&gt;|&#34;\s*&gt;/i.test(String(text || ""));
}

function localTranslationHtml(segment, target = "") {
  const doc = new DOMParser().parseFromString(segment?.originalHtml || "", "text/html");
  const node = doc.body.firstElementChild;
  const text = preserveSystemOrnaments(segment?.originalText || "", target);
  if (!node) return "<" + (segment?.tag || "p") + ">" + escapeHtml(text) + "</" + (segment?.tag || "p") + ">";
  node.textContent = text;
  return node.outerHTML;
}

function preserveSystemOrnaments(original = "", target = "") {
  const source = String(original || "").trim();
  let output = String(target || "");
  const leading = source.match(/^[^\w\u4e00-\u9fff\[]+/u)?.[0]?.trim();
  const trailing = source.match(/[^\w\u4e00-\u9fff\]]+$/u)?.[0]?.trim();
  if (leading && /[^\s()[\]{}"'`.,:;!?-]/u.test(leading)) output = leading + " " + output;
  if (trailing && trailing !== leading && /[^\s()[\]{}"'`.,:;!?-]/u.test(trailing)) output += " " + trailing;
  return output;
}

function stripSystemPrefix(value = "") {
  return String(value)
    .replace(/^[^A-Za-z0-9\[]+/g, "")
    .replace(/^[\s\[\](!)\u26a0\u25b2-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function translateSystemQuote(value = "") {
  const text = String(value || "").trim();
  const exact = new Map([
    ["are you kidding me, leon?", "\u4f60\u5728\u5f00\u73a9\u7b11\u5427\uff0c\u91cc\u6602\uff1f"]
  ]);
  return exact.get(text.toLowerCase()) || text;
}

function translateSystemShortText(normalized = "") {
  const plain = stripSystemPrefix(normalized)
    .toLowerCase()
    .replace(/\s*[-\u2013\u2014]+\s*$/g, "")
    .replace(/[.\u3002]+$/g, "")
    .trim();
  const tight = plain.replace(/\s+/g, "");
  const key = stripSystemPrefix(normalized)
    .toLowerCase()
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/^[\s\[\](!)\u26a0\u25b2-]+|[\s\[\](!)\u26a0\u25b2-]+$/g, "")
    .replace(/\s*[-\u2013\u2014]+\s*$/g, "")
    .replace(/[.\u3002]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const keyTight = key.replace(/\s+/g, "");
  const currentLevel2 = key.match(/^current level:\s*["']?(.+?)["']?$/i);
  if (currentLevel2) return "\u5f53\u524d\u7b49\u7ea7\uff1a\u201c" + translateSystemQuote(currentLevel2[1]) + "\u201d";
  const systemStatus2 = key.match(/^system:\s*(.+)$/i);
  if (systemStatus2) {
    const value = systemStatus2[1].trim();
    if (value === "anomaly detected") return "\u7cfb\u7edf\uff1a\u68c0\u6d4b\u5230\u5f02\u5e38";
    return "\u7cfb\u7edf\uff1a" + value;
  }
  const looseMap = new Map([
    ["sweetheart syndrome", "\u751c\u5fc3\u7efc\u5408\u5f81"],
    ["reminder:", "\u63d0\u9192\uff1a"],
    ["reminder", "\u63d0\u9192\uff1a"],
    ["system: anomaly detected", "\u7cfb\u7edf\uff1a\u68c0\u6d4b\u5230\u5f02\u5e38"],
    ["anomaly detected", "\u68c0\u6d4b\u5230\u5f02\u5e38"]
  ]);
  if (looseMap.has(key)) return looseMap.get(key);
  if (looseMap.has(keyTight)) return looseMap.get(keyTight);
  const currentLevel = plain.replace(/[鈥溾€漖/g, "\"").match(/^current level:\s*["']?(.+?)["']?$/i);
  if (currentLevel) return "\u5f53\u524d\u7b49\u7ea7\uff1a\u201c" + translateSystemQuote(currentLevel[1]) + "\u201d";
  const systemStatus = plain.match(/^system:\s*(.+)$/i);
  if (systemStatus) {
    const value = systemStatus[1].replace(/[.\u3002]+$/g, "").trim();
    if (value === "anomaly detected") return "\u7cfb\u7edf\uff1a\u68c0\u6d4b\u5230\u5f02\u5e38";
    return "\u7cfb\u7edf\uff1a" + value;
  }
  const dateMatch = plain.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})$/i);
  const months = {
    january: "1", february: "2", march: "3", april: "4", may: "5", june: "6",
    july: "7", august: "8", september: "9", october: "10", november: "11", december: "12"
  };
  if (dateMatch && months[dateMatch[1]]) {
    return dateMatch[3] + "\u5e74" + months[dateMatch[1]] + "\u6708" + dateMatch[2] + "\u65e5";
  }
  const progress = normalized.match(/(\d{1,3})\s*%/);
  if (progress && normalized.length <= 80) return progress[1] + "%";
  if (/\[\s*yes\s*\].*[\[\s]no\s*\]/i.test(normalized)) return "[\u662f] [\u5426]";
  if (/\[\s*yes\s*\]/i.test(normalized)) return "[\u662f]";
  if (/\[\s*no\s*\]/i.test(normalized)) return "[\u5426]";
  if (/^\d+\s*\.{1,3}$/.test(plain)) return plain.replace(/\./g, "\u2026");
  const map = new Map([
    ["yes", "\u662f"],
    ["no", "\u5426"],
    ["[ yes ] [ no ]", "[\u662f] [\u5426]"],
    ["[yes][no]", "[\u662f] [\u5426]"],
    ["yes|no", "[\u662f] [\u5426]"],
    ["do you want to restart?", "\u662f\u5426\u91cd\u65b0\u5f00\u59cb\uff1f"],
    ["doyouwanttorestart?", "\u662f\u5426\u91cd\u65b0\u5f00\u59cb\uff1f"],
    ["critical error", "\u4e25\u91cd\u9519\u8bef"],
    ["criticalerror", "\u4e25\u91cd\u9519\u8bef"],
    ["memory analysis", "\u8bb0\u5fc6\u5206\u6790\u4e2d\u2026\u2026"],
    ["memory analysis...", "\u8bb0\u5fc6\u5206\u6790\u4e2d\u2026\u2026"],
    ["operating system corrupted", "\u64cd\u4f5c\u7cfb\u7edf\u5df2\u635f\u574f\u3002"],
    ["error correction", "\u9519\u8bef\u4fee\u6b63\u4e2d\u2026\u2026"],
    ["error correction...", "\u9519\u8bef\u4fee\u6b63\u4e2d\u2026\u2026"],
    ["repairing errors", "\u6b63\u5728\u4fee\u590d\u9519\u8bef\u2026\u2026"],
    ["repairing errors...", "\u6b63\u5728\u4fee\u590d\u9519\u8bef\u2026\u2026"],
    ["repairing errors in progress", "\u9519\u8bef\u4fee\u590d\u8fdb\u884c\u4e2d\u2026\u2026"],
    ["connection interrupted due to failure", "\u8fde\u63a5\u56e0\u6545\u969c\u4e2d\u65ad"],
    ["data recovery failed", "\u6570\u636e\u6062\u590d\u5931\u8d25\u3002"],
    ["restarting in 3", "3\u79d2\u540e\u91cd\u542f\u2026\u2026"],
    ["restarting in 3...", "3\u79d2\u540e\u91cd\u542f\u2026\u2026"],
    ["location not registered", "\u4f4d\u7f6e\u672a\u6ce8\u518c\u3002"],
    ["visual glitch detected -- correcting", "\u68c0\u6d4b\u5230\u89c6\u89c9\u6545\u969c\u2014\u2014\u6b63\u5728\u4fee\u6b63\u2026\u2026"],
    ["visual glitch detected -- correcting...", "\u68c0\u6d4b\u5230\u89c6\u89c9\u6545\u969c\u2014\u2014\u6b63\u5728\u4fee\u6b63\u2026\u2026"],
    ["temporary memory corrupted", "\u4e34\u65f6\u8bb0\u5fc6\u5df2\u635f\u574f\u3002"],
    ["skipping is not recommended", "\u4e0d\u5efa\u8bae\u8df3\u8fc7\u2014\u2014"],
    ["connection stabilized", "\u8fde\u63a5\u5df2\u7a33\u5b9a"],
    ["welcome, user", "\u6b22\u8fce\uff0c\u7528\u6237\u3002"],
    ["progress system activated", "\u8fdb\u5ea6\u7cfb\u7edf\u5df2\u542f\u52a8\u3002"],
    ["inventory -- accessible at any time", "\u3010\u7269\u54c1\u680f\u3011\u2014\u2014\u968f\u65f6\u53ef\u7528\u3002"],
    ["upgrade store -- unlocked", "\u3010\u5347\u7ea7\u5546\u5e97\u3011\u2014\u2014\u5df2\u89e3\u9501\u3002"],
    ["available skills:", "\u53ef\u7528\u6280\u80fd\uff1a"],
    ["health:", "\u751f\u547d\uff1a"],
    ["stamina:", "\u8010\u529b\uff1a"],
    ["new objective:", "\u65b0\u76ee\u6807\uff1a"],
    ["alteration detected", "\u68c0\u6d4b\u5230\u5f02\u53d8"],
    ["error 404: inadmissible character", "\u9519\u8bef 404\uff1a\u4e0d\u53ef\u63a5\u53d7\u5b57\u7b26"],
    ["restart", "\u91cd\u65b0\u5f00\u59cb"],
    ["continue", "\u7ee7\u7eed"],
    ["game over", "\u6e38\u620f\u7ed3\u675f"],
    ["gameover", "\u6e38\u620f\u7ed3\u675f"],
    ["start", "\u5f00\u59cb"],
    ["stop", "\u505c\u6b62"],
    ["error", "\u9519\u8bef"],
    ["warning", "\u8b66\u544a"]
  ]);
  return map.get(plain) || map.get(tight) || "";
}

function localShortTextTranslation(segment) {
  if (segment.kind !== "body") return "";
  const normalized = String(segment.originalText || "").replace(/\s+/g, " ").trim();
  if (isReaderNamePlaceholder(normalized)) {
    const name = readerNameZh();
    return name ? "<" + (segment.tag || "p") + ">" + escapeHtml(name) + "</" + (segment.tag || "p") + ">" : "";
  }
  const compact = normalized
    .toLowerCase()
    .replace(/\[\s*/g, "[ ")
    .replace(/\s*\]/g, " ]")
    .replace(/\s+/g, " ")
    .trim();
  const tight = compact.replace(/\s+/g, "");
  const target = translateSystemShortText(compact) || translateSystemShortText(tight);
  return target ? localTranslationHtml(segment, target) : "";
}

function readerNameZh() {
  return (els.readerNameInput?.value || "").replace(/\s+/g, " ").trim();
}

function readerNameEn() {
  return (els.readerNameEnInput?.value || "").replace(/\s+/g, " ").trim();
}

function readerName() {
  return readerNameZh();
}

function isReaderNamePlaceholder(value = "") {
  return /^[\[(\s{]*y\s*[\/\\]\s*n[\])\s}]*$/i.test(String(value || "").trim());
}

function hasReaderNamePlaceholder(value = "") {
  return /[\[({]?\s*y\s*[\/\\]\s*n\s*[\])}]?/i.test(String(value || ""));
}

function applyReaderNameToText(value = "", language = "zh") {
  const name = language === "en" ? readerNameEn() : readerNameZh();
  if (!name) return String(value || "");
  return String(value || "").replace(/[\[({]?\s*y\s*[\/\\]\s*n\s*[\])}]?/gi, name);
}

function applyReaderNameToHtml(html = "", language = "zh") {
  const name = language === "en" ? readerNameEn() : readerNameZh();
  if (!name || !html) return html || "";
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    node.nodeValue = applyReaderNameToText(node.nodeValue, language);
  });
  return doc.body.innerHTML;
}

function applyReaderNameToTranslationHtml(html = "", segment = null) {
  let output = applyReaderNameToHtml(html, "zh");
  const name = readerNameZh();
  if (!name || !hasReaderNamePlaceholder(segment?.originalText || segment?.originalHtml || "")) return output;
  const englishName = readerNameEn().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  output = transformHtmlTextNodes(output, (text) => {
    let value = String(text || "")
      .replace(/[\[({]?\s*y\s*[\/\\]\s*n\s*[\])}]?/gi, name)
      .replace(/[（(\[【]?\s*是\s*[\/／\\]\s*否\s*[）)\]】]?/g, name)
      .replace(/[（(\[【]?\s*(?:你的名字|您的名字|你名字|读者姓名)\s*[）)\]】]?/g, name);
    if (englishName) value = value.replace(new RegExp(englishName, "gi"), name);
    return value;
  });
  return output;
}

function saveReaderName() {
  const zh = readerNameZh();
  const en = readerNameEn();
  if (zh) localStorage.setItem(READER_NAME_STORAGE_KEY, zh);
  else localStorage.removeItem(READER_NAME_STORAGE_KEY);
  if (en) localStorage.setItem(READER_NAME_EN_STORAGE_KEY, en);
  else localStorage.removeItem(READER_NAME_EN_STORAGE_KEY);
}

function loadReaderName() {
  if (els.readerNameInput) els.readerNameInput.value = localStorage.getItem(READER_NAME_STORAGE_KEY) || "\u62c9\u5c3c\u5a05";
  if (els.readerNameEnInput) els.readerNameEnInput.value = localStorage.getItem(READER_NAME_EN_STORAGE_KEY) || "Laniya";
}

function saveGlossary() {
  localStorage.setItem(GLOSSARY_STORAGE_KEY, els.glossaryInput.value);
}

function ensureRequiredGlossaryTerms() {
  const parsed = parseGlossary();
  const existing = new Set(parsed.map((item) => item.source.toLowerCase()));
  const additions = requiredGlossaryTerms
    .filter(([source]) => !existing.has(source.toLowerCase()))
    .map(([source, target]) => source + ": " + target);
  if (!additions.length) return 0;
  els.glossaryInput.value = (els.glossaryInput.value.trim() + "\n" + additions.join("\n")).trim();
  return additions.length;
}

function loadSavedGlossary() {
  const saved = localStorage.getItem(GLOSSARY_STORAGE_KEY);
  if (saved && saved.trim() && !looksMojibake(saved)) els.glossaryInput.value = saved;
  else els.glossaryInput.value = defaultGlossaryText();
  mergePresetGlossary(true);
  ensureRequiredGlossaryTerms();
  saveGlossary();
}

function mergePresetGlossary(silent = false) {
  const existing = new Set(parseGlossary().map((item) => item.source.toLowerCase()));
  const additions = presets.filter(([source]) => !existing.has(String(source).toLowerCase()));
  if (!additions.length) {
    if (!silent) setStatus("Presets already added.");
    return 0;
  }
  els.glossaryInput.value = (els.glossaryInput.value.trim() + "\n" + additions.map(([a, b]) => a + ": " + b).join("\n")).trim();
  ensureRequiredGlossaryTerms();
  saveGlossary();
  if (!silent) setStatus("Added " + additions.length + " preset terms.");
  return additions.length;
}

function applyGlossaryToString(value = "") {
  let output = normalizeReadableTerms(value);
  for (const item of parseGlossary()) {
    const target = cleanGlossaryTarget(item.target);
    if (!item.source || !target) continue;
    const source = item.source.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
    const pattern = /^[A-Za-z0-9 .'-]+$/.test(item.source) ? `\\b${source}\\b` : source;
    output = output.replace(new RegExp(pattern, "g"), target);
  }
  return tidyCjkSpacing(output);
}

function trustedNameGlossaryTerms() {
  const required = new Map(requiredGlossaryTerms.map(([source, target]) => [source.toLowerCase(), { source, target }]));
  const properNamePattern = /^[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*$/;
  const ordinaryWordBlocklist = new Set([
    "you", "reader", "sister", "captain", "sergeant", "agent", "partner", "mission",
    "alpha", "beta", "omega", "heat", "rut", "plot", "praise", "comfort",
    "blood", "injury", "violence", "english", "words", "chapters", "comments",
    "kudos", "bookmarks", "hits", "complete work", "work in progress"
  ]);
  for (const item of parseGlossary()) {
    const target = cleanGlossaryTarget(item.target);
    if (!item.source || !target) continue;
    const sourceKey = item.source.toLowerCase();
    if (ordinaryWordBlocklist.has(sourceKey)) continue;
    const looksLikeName = properNamePattern.test(item.source) && (item.source.includes(" ") || item.source.includes(".") || target.length <= 8);
    if (required.has(sourceKey) || looksLikeName) {
      required.set(item.source.toLowerCase(), { source: item.source, target });
    }
  }
  return [...required.values()].sort((a, b) => b.source.length - a.source.length);
}

function transformHtmlTextNodes(html = "", transform) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) node.nodeValue = transform(node.nodeValue || "");
  return doc.body.innerHTML;
}

function applyTrustedNameGlossary(html = "") {
  return transformHtmlTextNodes(html, (text) => {
    let output = String(text || "");
    for (const item of trustedNameGlossaryTerms()) {
      const source = item.source.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
      output = output.replace(new RegExp(`\\b${source}\\b`, "g"), item.target);
    }
    return normalizeReadableTerms(output);
  });
}

function applyUserGlossaryHtml(html = "") {
  return transformHtmlTextNodes(html, (text) => applyGlossaryToString(text));
}

function cleanNameArtifacts(html = "") {
  return normalizeReadableTerms(html);
}

function tidyCjkSpacingLegacy(value = "") {
  return tidyCjkSpacing(value);
}

function tidyCjkSpacing(value = "") {
  return String(value)
    .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/\s+([，。！？；：、）》】”])/g, "$1")
    .replace(/([（《【“])\s+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeReadableTerms(html = "") {
  return tidyCjkSpacing(String(html)
    .replace(/\u6b27\u7c73\u4f3d/g, "omega")
    .replace(/\u963f\u5c14\u6cd5/g, "alpha")
    .replace(/\u8d1d\u5854/g, "beta")
    .replace(/\u83b1\u6602/g, "\u91cc\u6602")
    .replace(/\u5229\u6602/g, "\u91cc\u6602")
    .replace(/\u674e\u6602/g, "\u91cc\u6602")
    .replace(/\bLeon\b/g, "\u91cc\u6602")
    .replace(/\bRebecca\b/g, "\u745e\u8d1d\u5361")
    .replace(/\u4e3d\u8d1d\u5361/g, "\u745e\u8d1d\u5361")
    .replace(/\u745e\u4e3d\u8d1d\u5361/g, "\u745e\u8d1d\u5361")
    .replace(/\bWesker\b/g, "\u5a01\u65af\u514b")
    .replace(/\bAda\b/g, "\u827e\u8fbe")
    .replace(/\bClaire\b/g, "\u514b\u83b1\u5c14")
    .replace(/\bChris\b/g, "\u514b\u91cc\u65af")
    .replace(/(\u91cc\u6602)(?:[\s\uff0c\u3001,]+\1)+/g, "\u91cc\u6602")
    .replace(/(\u745e\u8d1d\u5361)(?:[\s\uff0c\u3001,]+\1)+/g, "\u745e\u8d1d\u5361")
    .replace(/(\u5a01\u65af\u514b)(?:[\s\uff0c\u3001,]+\1)+/g, "\u5a01\u65af\u514b")
    .replace(/(\u827e\u8fbe)(?:[\s\uff0c\u3001,]+\1)+/g, "\u827e\u8fbe")
    .replace(/(\u514b\u83b1\u5c14)(?:[\s\uff0c\u3001,]+\1)+/g, "\u514b\u83b1\u5c14")
    .replace(/(\u514b\u91cc\u65af)(?:[\s\uff0c\u3001,]+\1)+/g, "\u514b\u91cc\u65af")
    .replace(/\u4f60[\s\uff0c\u3001,]*(\u91cc\u6602|\u83b1\u6602|\u745e\u8d1d\u5361)(?=[\uff0c\u3002\uff01\uff1f\u3001\s<]|$)/g, "\u4f60")
    .replace(/\u4f60\s*(\u91cc\u6602|\u83b1\u6602|\u745e\u8d1d\u5361)(?=[\uff0c\u3002\uff01\uff1f\u3001\s<])/g, "\u4f60")
    .replace(/(\u4ed6|\u5979)\s*(\u91cc\u6602|\u83b1\u6602|\u745e\u8d1d\u5361|\u5a01\u65af\u514b|\u827e\u8fbe|\u514b\u83b1\u5c14|\u514b\u91cc\u65af)(?=[\uff0c\u3002\uff01\uff1f\u3001\s<])/g, "$1")
    .replace(/\u4e27\u5c38\s*\u4e27\u5c38+/g, "\u4e27\u5c38"));
}

function normalizedForCompare(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function textSimilarity(a = "", b = "") {
  const left = new Set(String(a).toLowerCase().match(/[a-z]{3,}/g) || []);
  const right = new Set(String(b).toLowerCase().match(/[a-z]{3,}/g) || []);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of right) if (left.has(word)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function isEffectivelyUntranslated(segment, html = "") {
  if (!segment) return true;
  if (isDecorativeSegment(segment)) return false;
  const local = localMetaTranslation(segment) || localShortTextTranslation(segment);
  const translatedText = textOnly(html);
  if (!translatedText) return true;
  if (/当前等级[：:]\s*[“"]?n[”"]?/i.test(translatedText)
      && !/^current level\s*:/i.test(String(segment.originalText || "").trim())) return true;
  if (local && textOnly(local) === translatedText) return false;
  const originalText = String(segment.originalText || "").replace(/\s+/g, " ").trim();
  if (normalizedForCompare(translatedText) === normalizedForCompare(originalText)) return true;
  if (segment.kind !== "body") return false;
  if (/[\u4e00-\u9fff]/.test(translatedText)) return false;
  const letters = (translatedText.match(/[A-Za-z]/g) || []).length;
  const ratio = letters / Math.max(translatedText.length, 1);
  return originalText.length > 40 && ratio > 0.55 && textSimilarity(originalText, translatedText) > 0.45;
}

function repairSegmentTranslation(segment, html = segment?.translationHtml || "") {
  if (!segment) return html || "";
  if (isDecorativeSegment(segment)) return segment.originalHtml || html || "";
  const current = applyReaderNameToTranslationHtml(applyUserGlossaryHtml(applyTrustedNameGlossary(html || "")), segment);
  const currentText = textOnly(current);
  const local = localMetaTranslation(segment) || localShortTextTranslation(segment);
  if (segment.kind === "meta" && looksLikeLeakedAo3Href(currentText)) return local || applyTrustedNameGlossary(segment.originalHtml || "");
  if (readerName() && isReaderNamePlaceholder(segment.originalText) && local) return local;
  const broken = /\ufffd|\u951f|\u95c1|\u7ef1|\u6d5c/.test(currentText);
  if ((broken || !currentText) && local) return local;
  if (isEffectivelyUntranslated(segment, current)) return local || "";
  return current;
}

function parseHtml(options = {}) {
  const quiet = Boolean(options.quiet);
  const doc = new DOMParser().parseFromString(state.rawHtml, "text/html");
  sanitize(doc.documentElement);
  markAo3ChapterTitles(doc);
  normalizeAo3BreakParagraphs(doc);

  const title = cleanTitle(doc.querySelector("h2.title.heading")?.innerHTML)
    || cleanTitle(doc.querySelector("title")?.innerHTML)
    || "AO3 Work";
  const author = textOnly(doc.querySelector("h3.byline.heading")?.innerHTML)
    || textOnly(doc.querySelector("[rel='author']")?.innerHTML);

  const nodes = translatableNodes(doc);
  const chapterInfos = new Map();
  const chapterInfoForNode = (node) => {
    const marker = ao3FlowChapterMarkerForNode(node);
    if (marker) {
      if (!chapterInfos.has(marker)) {
        const order = chapterInfos.size + 1;
        chapterInfos.set(marker, {
          key: marker.id || "ao3-chapter-" + order,
          title: chapterTitleFromAo3Marker(marker),
          order
        });
      }
      return chapterInfos.get(marker);
    }
    const chapter = chapterContainerForNode(node);
    if (!chapter) return { key: "", title: "", order: 0 };
    if (!chapterInfos.has(chapter)) {
      const order = chapterInfos.size + 1;
      chapterInfos.set(chapter, {
        key: chapter.id || "ao3-chapter-" + order,
        title: chapterTitleFromContainer(chapter),
        order
      });
    }
    return chapterInfos.get(chapter);
  };

  state.metadata = { title, author };
  els.exportTitleInput.value = neatTitle(title);
  const keyCounters = new Map();
  state.segments = nodes.map((node, index) => {
    const chapterInfo = chapterInfoForNode(node);
    return {
      id: `seg-${index + 1}`,
      index,
      key: segmentKeyForNode(node, keyCounters),
      tag: node.tagName.toLowerCase(),
      kind: segmentKind(node),
      scope: segmentScope(node),
      chapterKey: chapterInfo.key,
      chapterTitle: chapterInfo.title,
      chapterOrder: chapterInfo.order,
      originalHtml: segmentOriginalHtml(node),
      originalText: normalizedSegmentText(node),
      decorative: isDecorativeText(normalizedSegmentText(node)),
      translationHtml: "",
      failedReason: ""
    };
  });
  for (const segment of state.segments) {
    const local = localMetaTranslation(segment) || localShortTextTranslation(segment);
    if (local) segment.translationHtml = local;
  }
  const booxHeadingCount = hydrateChapterMetadataFromBooxHeadings(doc);
  const detectedChapterCount = new Set(state.segments.map((segment) => segment.chapterKey).filter(Boolean)).size;
  const flowChapterCount = ao3FlowChapterBlockCount(doc);
  if (booxHeadingCount <= 1 && (flowChapterCount > detectedChapterCount || detectedChapterCount <= 1)) {
    hydrateChapterMetadataByAo3FlowOrder(doc);
  }

  state.previewVisibleCount = PREVIEW_LIMIT;
  state.previewMissingOnly = false;
  rebuildSegmentIndex();
  syncActiveWork();
  if (!quiet) {
    updateReady();
    schedulePreviewRender(true);
    setProgress(0, state.segments.length);
    setStatus(state.segments.length ? `Imported ${state.segments.length} segments.` : "No readable paragraphs found.", !state.segments.length);
  }
}

function parseWork(work, options = {}) {
  state.fileName = work.fileName;
  state.rawHtml = work.rawHtml;
  state.metadata = work.metadata;
  state.segments = work.segments;
  parseHtml(options);
  work.metadata = state.metadata;
  work.segments = state.segments;
  work.exportTitle = els.exportTitleInput.value.trim();
  work.progressDone = 0;
  work.progressTotal = state.segments.length;
  work.status = state.segments.length ? `Imported ${state.segments.length} segments.` : "No readable paragraphs found.";
}

function countTranslated() {
  const work = activeWork();
  if (work && Number.isFinite(work.progressDone)) return work.progressDone;
  return state.segments.filter(isTranslatedSegment).length;
}

function countWorkTranslated(work) {
  if (work && Number.isFinite(work.progressDone)) return work.progressDone;
  return (work?.segments || []).filter(isTranslatedSegment).length;
}

function renderWorkList() {
  if (!els.workList) return;
  if (!state.works.length) {
    els.workList.innerHTML = "";
    return;
  }
  els.workList.innerHTML = state.works.map((work, index) => {
    const done = countWorkTranslated(work);
    const total = work.progressTotal || work.segments.length || 0;
    const percent = total ? Math.round((done / total) * 100) : 0;
    const title = work.metadata?.title || work.fileName;
    return `<div class="work-item ${index === state.currentWorkIndex ? "active" : ""}">
      <button type="button" class="work-open" data-work-index="${index}" title="鎵撳紑杩欑瘒">
        <span>${escapeHtml(title)}</span>
        <small>${done}/${total} 路 ${percent}%</small>
        <i><b style="width:${percent}%"></b></i>
      </button>
      <button type="button" class="work-delete" data-delete-work="${index}" title="浠庡垪琛ㄥ垹闄よ繖绡?>鍒犻櫎</button>
    </div>`;
  }).join("");
}

function updateReady() {
  const ready = state.segments.length > 0;
  const done = countTranslated();
  els.startButton.disabled = !ready;
  if (els.stopButton) els.stopButton.disabled = !document.body.classList.contains("busy");
  if (els.startAllButton) {
    els.startAllButton.disabled = !state.works.some((work) => (work.segments || []).some((segment) => !isTranslatedSegment(segment)));
  }
  if (els.doubaoMissingButton) {
    els.doubaoMissingButton.disabled = !ready || !state.segments.some((segment) => !isTranslatedSegment(segment));
  }
  els.polishButton.disabled = !ready || !done;
  if (els.clearTranslationsButton) els.clearTranslationsButton.disabled = !ready || !done;
  if (els.doubaoPolishButton) {
    els.doubaoPolishButton.disabled = !ready || selectedSegmentIds.size === 0;
    els.doubaoPolishButton.textContent = selectedSegmentIds.size
      ? `\u91cd\u65b0\u7ffb\u8bd1 (${selectedSegmentIds.size})`
      : "\u91cd\u65b0\u7ffb\u8bd1";
  }
  if (els.titleSuggestButton) els.titleSuggestButton.disabled = !ready;
  if (els.togglePreviewButton) {
    els.togglePreviewButton.disabled = !ready || state.segments.length <= PREVIEW_LIMIT;
    els.togglePreviewButton.textContent = "\u7ee7\u7eed\u663e\u793a\u66f4\u591a";
  }
  els.applyGlossaryButton.disabled = !ready;
  els.exportButtons.forEach((button) => button.disabled = !ready);
  els.epubButtons.forEach((button) => button.disabled = !ready);
  els.workTitle.textContent = state.metadata?.author ? `${state.metadata.title} - ${state.metadata.author}` : (state.metadata?.title || "Preview");
  els.workMeta.textContent = ready ? `${state.segments.length} segments / ${done} translated` : "Import a file first.";
  scheduleWorkListRender();
}

function clearCurrentTranslations() {
  if (!state.segments.length) return;
  for (const segment of state.segments) {
    segment.translationHtml = "";
    segment.failedReason = "";
  }
  selectedSegmentIds.clear();
  syncActiveWork();
  setProgress(0, state.segments.length);
  updateReady();
  schedulePreviewRender(true);
  setStatus("Cleared current translation. Start translate can run again.");
}

function renderPreview() {
  els.preview.className = `preview mode-${state.mode}`;
  if (!state.segments.length) {
    els.preview.innerHTML = '<p class="empty">No file yet.</p>';
    return;
  }
  const missingSegments = state.segments.filter((segment) => !isTranslatedSegment(segment));
  const sourceSegments = state.previewMissingOnly ? missingSegments : state.segments;
  const visibleCount = Math.min(state.previewVisibleCount || PREVIEW_LIMIT, sourceSegments.length);
  const visible = sourceSegments.slice(0, visibleCount);
  const hasMorePreview = visibleCount < sourceSegments.length;
  const notice = state.segments.length > PREVIEW_LIMIT
    ? '<p class="preview-note">' + (state.previewMissingOnly ? '\u6b63\u5728\u53ea\u663e\u793a\u672a\u7ffb\u8bd1 / \u5931\u8d25\u6bb5\u843d\uff1a' + missingSegments.length + ' \u6bb5\u3002' : '\u5df2\u663e\u793a ' + visibleCount + ' / ' + state.segments.length + ' \u6bb5\uff0c\u4e0b\u7ffb\u4f1a\u81ea\u52a8\u7ee7\u7eed\u6e32\u67d3\u3002') + '\u7ffb\u8bd1\u548c\u5bfc\u51fa\u90fd\u4f1a\u5904\u7406\u5168\u6587\u3002</p>'
    : '';
  const missingButton = missingSegments.length
    ? '<button type="button" class="preview-more" data-preview-missing>' + (state.previewMissingOnly ? '\u8fd4\u56de\u666e\u901a\u9884\u89c8' : '\u53ea\u770b ' + missingSegments.length + ' \u6bb5\u5f85\u8865\u7ffb') + '</button>'
    : '';
  const moreButton = hasMorePreview
    ? '<button type="button" class="preview-more" data-preview-more>\u7ee7\u7eed\u663e\u793a\u66f4\u591a</button>'
    : '';
  els.preview.innerHTML = notice + missingButton + visible.map((segment) => {
    const missing = !isDecorativeSegment(segment) && !isTranslatedSegment(segment);
    const failed = segment.failedReason && state.previewMissingOnly ? ' failed' : '';
    const zh = isTranslatedSegment(segment) ? segment.translationHtml : "";
    const selector = segment.kind === "body"
      ? '<label class="segment-tools" title="\u9009\u4e2d\u540e\u53ef\u91cd\u65b0\u7ffb\u8bd1"><input type="checkbox" class="segment-select" aria-label="\u9009\u4e2d\u8fd9\u6bb5\u91cd\u65b0\u7ffb\u8bd1" ' + (selectedSegmentIds.has(segment.id) ? 'checked' : '') + '><span></span></label>'
      : '';
    const retryTools = !isDecorativeSegment(segment) && !isTranslatedSegment(segment)
      ? '<div class="retry-tools"><button type="button" data-retry-segment="current">\u8865\u8fd9\u6bb5</button><button type="button" data-retry-segment="doubao">\u8c46\u5305\u8865</button></div>'
      : '';
    return '<div class="pair ' + (selectedSegmentIds.has(segment.id) ? 'selected ' : '') + (missing ? 'missing ' : '') + failed + '" data-id="' + segment.id + '">' +
      selector +
      '<div class="en">' + applyReaderNameToHtml(segment.originalHtml, "en") + '</div>' +
      retryTools +
      '<div class="zh" contenteditable="true" spellcheck="false">' + applyReaderNameToTranslationHtml(zh, segment) + '</div>' +
      '</div>';
  }).join("") + moreButton;
}

function updateVisibleTranslation(segment) {
  if (!segment || !els.preview) return;
  const selectorId = String(segment.id || "").replace(/["\\]/g, "\\$&");
  const pair = els.preview.querySelector('[data-id="' + selectorId + '"]');
  if (!pair) return;
  const translated = isTranslatedSegment(segment);
  const zh = pair.querySelector(".zh");
  if (zh && !zh.contains(document.activeElement)) {
    zh.innerHTML = translated ? applyReaderNameToTranslationHtml(segment.translationHtml, segment) : "";
  }
  pair.classList.toggle("missing", !isDecorativeSegment(segment) && !translated);
  if (translated) pair.querySelector(".retry-tools")?.remove();
}

function extendPreviewPage() {
  if (!state.segments.length) return;
  const sourceCount = state.previewMissingOnly
    ? state.segments.filter((segment) => !isTranslatedSegment(segment)).length
    : state.segments.length;
  const current = state.previewVisibleCount || PREVIEW_LIMIT;
  if (current >= sourceCount) return;
  state.previewVisibleCount = Math.min(sourceCount, current + PREVIEW_PAGE_SIZE);
  schedulePreviewRender(true);
}

function maybeExtendPreviewOnScroll() {
  if (!state.segments.length) return;
  const bottomGap = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
  if (bottomGap < 900) extendPreviewPage();
}

function chunkSegments(size, list = state.segments) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

function chunkSegmentsByLoad(list, maxItems, maxChars) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const segment of list) {
    const size = Math.max(segment.originalHtml?.length || 0, segment.originalText?.length || 0, 1);
    if (current.length && (current.length >= maxItems || chars + size > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function segmentContext(segment) {
  const index = Number.isFinite(segment.index) ? segment.index : state.segments.indexOf(segment);
  const before = [];
  const after = [];
  for (let i = index - 1; i >= 0 && before.length < 2; i -= 1) {
    if (state.segments[i].kind === "body") before.unshift(state.segments[i].originalText);
  }
  for (let i = index + 1; i < state.segments.length && after.length < 2; i += 1) {
    if (state.segments[i].kind === "body") after.push(state.segments[i].originalText);
  }
  return {
    before: before.join("\n").slice(-700),
    after: after.join("\n").slice(0, 500)
  };
}

async function translateAll(options = {}) {
  if (!options.keepStopState) translationStopRequested = false;
  let provider = options.provider || els.providerSelect.value;
  if (provider !== "google") {
    provider = "google";
    els.providerSelect.value = "google";
    updateAiSettings();
    setStatus("Full translation uses Google for speed.");
  }
  const work = activeWork();
  const workTitle = work?.metadata?.title || work?.fileName || state.metadata?.title || "current work";
  if (provider === "doubao" && !els.apiKeyInput.value.trim() && !hasServerDoubaoKey) {
    setStatus("Paste Doubao API Key first, or set local ARK_API_KEY.", true);
    revealKeySettings("doubao");
    return;
  }

  for (const segment of state.segments) {
    if (isTranslatedSegment(segment)) continue;
    const local = localMetaTranslation(segment) || localShortTextTranslation(segment);
    if (local) {
      segment.translationHtml = local;
      segment.failedReason = "";
    }
  }

  const targetSegments = state.segments.filter((segment) => !isTranslatedSegment(segment));
  if (!targetSegments.length) {
    syncActiveWork();
    updateReady();
    state.previewMissingOnly = false;
    if (!bulkTranslateMode) schedulePreviewRender(true);
    setStatus("No missing paragraphs. Preview and export are ready.");
    return 0;
  }

  if (!bulkTranslateMode) state.previewMissingOnly = false;

  const googleContext = provider === "google" && (!els.googleContextMode || els.googleContextMode.checked);
  const limits = options.limits || (provider === "google"
    ? (googleContext
      ? { maxItems: GOOGLE_CONTEXT_MAX_ITEMS, maxChars: GOOGLE_CONTEXT_MAX_CHARS }
      : { maxItems: GOOGLE_NORMAL_MAX_ITEMS, maxChars: GOOGLE_NORMAL_MAX_CHARS })
    : (AI_CHUNK_LIMITS[provider] || AI_CHUNK_LIMITS.deepseek));
  const chunks = chunkSegmentsByLoad(targetSegments, limits.maxItems, limits.maxChars);

  els.startButton.disabled = true;
  setBusy(true);
  let completed = state.segments.filter(isTranslatedSegment).length;
  let failedCount = 0;
  let renderedChunks = 0;
  let lastPreviewTick = 0;
  let lastSaveTick = 0;
  const reportProgress = (done, total) => options.onProgress ? options.onProgress(done, total) : setProgress(done, total);
  reportProgress(completed, state.segments.length);
  setStatus("Translating current work: " + workTitle);

  const applyTranslations = (translations, chunk) => {
    const expectedIds = new Set(chunk.map((segment) => segment.id));
    const returnedIds = new Set((translations || []).map((item) => item.id));
    if (returnedIds.size !== expectedIds.size || [...returnedIds].some((id) => !expectedIds.has(id))) {
      throw new Error("Translator returned mismatched paragraph results.");
    }
    for (const item of translations || []) {
      const segment = state.segmentById.get(item.id);
      if (!segment) continue;
      const wasDone = isTranslatedSegment(segment);
      if (item.error) {
        segment.translationHtml = "";
        segment.failedReason = item.error || "untranslated";
      } else {
        const repaired = repairSegmentTranslation(segment, item.html || "");
        if (isEffectivelyUntranslated(segment, repaired)) {
          segment.translationHtml = "";
          segment.failedReason = "untranslated";
        } else {
          segment.translationHtml = repaired;
          segment.failedReason = "";
        }
      }
      const isDone = isTranslatedSegment(segment);
      if (!wasDone && isDone) completed += 1;
      if (wasDone && !isDone) completed -= 1;
      if (!isDone) failedCount += 1;
    }
    reportProgress(completed, state.segments.length);
    renderedChunks += 1;
    setStatus((provider === "google" ? "Google translate current work " : "Translating current work ")
      + completed + "/" + state.segments.length + " - batch " + renderedChunks + "/" + chunks.length);
    const now = Date.now();
    if (work) {
      work.progressDone = completed;
      work.progressTotal = state.segments.length;
    }
    for (const item of translations || []) updateVisibleTranslation(state.segmentById.get(item.id));
    scheduleWorkListRender();
    if (els.workMeta) els.workMeta.textContent = state.segments.length + " segments / " + completed + " translated";
    if (renderedChunks % 24 === 0 || now - lastSaveTick > 15000) {
      lastSaveTick = now;
      syncActiveWork();
    }
    lastPreviewTick = now;
  };

  try {
    if (provider === "google") {
      let nextIndex = 0;
      let googleHadSplitError = false;
      const translateChunk = async (index) => {
        if (translationStopRequested) return;
        const chunk = chunks[index];
        const translations = await postTranslateWithSplit({
          provider,
          endpoint: els.endpointInput.value.trim(),
          apiKey: els.apiKeyInput.value.trim(),
          model: els.modelInput.value.trim(),
          glossary: parseGlossary(),
          from: "en",
          to: "zh-CN",
          googleMode: googleContext ? "context" : "normal",
          onSplit: () => { googleHadSplitError = true; },
          items: chunk.map((segment) => ({
            id: segment.id,
            tag: segment.tag,
            text: segment.originalText,
            html: segment.originalHtml,
            kind: segment.kind
          }))
        });
        applyTranslations(translations, chunk);
      };
      async function worker() {
        while (nextIndex < chunks.length && !googleHadSplitError && !translationStopRequested) {
          const index = nextIndex;
          nextIndex += 1;
          await translateChunk(index);
        }
      }
      await Promise.all(Array.from({ length: Math.min(GOOGLE_FAST_CONCURRENCY, chunks.length) }, () => worker()));
      while (nextIndex < chunks.length && !translationStopRequested) {
        const index = nextIndex;
        nextIndex += 1;
        await translateChunk(index);
      }
    } else {
      for (let index = 0; index < chunks.length && !translationStopRequested; index += 1) {
        const chunk = chunks[index];
        setStatus("Translating current work batch " + (index + 1) + "/" + chunks.length + "...");
        const translations = await postTranslateWithSplit({
          provider,
          endpoint: els.endpointInput.value.trim(),
          apiKey: els.apiKeyInput.value.trim(),
          model: els.modelInput.value.trim(),
          glossary: parseGlossary(),
          from: "en",
          to: "zh-CN",
          items: chunk.map((segment) => ({
            id: segment.id,
            tag: segment.tag,
            text: segment.originalText,
            html: segment.originalHtml,
            kind: segment.kind,
            ...segmentContext(segment)
          }))
        });
        applyTranslations(translations, chunk);
      }
    }
  } finally {
    syncActiveWork();
    updateReady();
    if (!bulkTranslateMode) {
      els.startButton.disabled = false;
      setBusy(false);
    }
    if (!bulkTranslateMode) schedulePreviewRender(true);
  }

  const missing = state.segments.filter((segment) => !isTranslatedSegment(segment)).length;
  state.previewMissingOnly = false;
  if (missing) {
    state.previewVisibleCount = PREVIEW_LIMIT;
  }
  if (!bulkTranslateMode) schedulePreviewRender(true);
  updateReady();
  setStatus(missing
    ? (translationStopRequested ? "Stopped. Saved completed paragraphs; you can switch works now." : "Done. " + missing + " paragraphs still need retry. Click Start translate to retry only those.")
    : "Done. Preview and export are ready.");
  return missing;
}

async function translateAllWorks() {
  const targets = state.works
    .map((work, index) => ({ work, index }))
    .filter(({ work }) => (work.segments || []).some((segment) => !isTranslatedSegment(segment)));
  if (!targets.length) return setStatus("No missing paragraphs in loaded works.");
  const originalIndex = state.currentWorkIndex;
  bulkTranslateMode = true;
  translationStopRequested = false;
  if (els.startAllButton) els.startAllButton.disabled = true;
  els.startButton.disabled = true;
  let doneWorks = 0;
  let failedWorks = 0;
  const totalSegments = targets.reduce((sum, { work }) => sum + (work.segments?.length || 0), 0);
  let overallDone = targets.reduce((sum, { work }) => sum + countWorkTranslated(work), 0);
  setProgress(overallDone, totalSegments);
  try {
    for (const { work, index } of targets) {
      setActiveWork(index);
      const workStartDone = countWorkTranslated(work);
      setProgress(overallDone, totalSegments);
      setStatus("Batch translating " + (doneWorks + 1) + "/" + targets.length + ": " + (work.metadata?.title || work.fileName || "work"));
      try {
        await translateAll({
          keepStopState: true,
          onProgress: (workDone) => setProgress(overallDone + Math.max(0, workDone - workStartDone), totalSegments)
        });
        overallDone += Math.max(0, countWorkTranslated(work) - workStartDone);
        setProgress(overallDone, totalSegments);
        doneWorks += 1;
        setStatus("Finished " + doneWorks + "/" + targets.length + ". Moving to next work...");
        if (translationStopRequested) break;
      } catch (error) {
        failedWorks += 1;
        setStatus("Skipped one failed work and continuing: " + (error.message || "translation failed"), true);
      }
    }
  } finally {
    bulkTranslateMode = false;
    setBusy(false);
    if (state.works[originalIndex]) setActiveWork(originalIndex);
    else if (state.works.length) setActiveWork(0);
    updateReady();
    schedulePreviewRender(true);
  }
  setStatus("Batch translate finished: " + doneWorks + "/" + targets.length + " works" + (failedWorks ? ", " + failedWorks + " failed/skipped." : "."));
}

async function translateMissingWithDoubao() {
  if (!els.apiKeyInput.value.trim() && !hasServerDoubaoKey) {
    setStatus("Doubao key is not connected. Start translate is still using your current translator.", true);
    return;
  }
  await translateAll({ provider: "doubao", limits: AI_CHUNK_LIMITS.doubaoFallback });
}

async function translateOneSegment(segmentId, requestedProvider = "current") {
  const segment = state.segmentById.get(segmentId);
  if (!segment || isDecorativeSegment(segment)) return;
  const provider = requestedProvider === "doubao" ? "doubao" : els.providerSelect.value;
  if (provider === "doubao" && !els.apiKeyInput.value.trim() && !hasServerDoubaoKey) {
    setStatus("Doubao key is not connected. Use the main Translator dropdown only when you want to configure Doubao.", true);
    return;
  }
  if (provider === "deepseek" && !els.apiKeyInput.value.trim() && !hasServerDeepSeekKey) {
    setStatus("Fill DeepSeek API Key once first.", true);
    revealKeySettings("deepseek");
    return;
  }
  const local = localMetaTranslation(segment) || localShortTextTranslation(segment);
  if (local) {
    segment.translationHtml = local;
    segment.failedReason = "";
    syncActiveWork();
    updateReady();
    schedulePreviewRender(true);
    setStatus("This paragraph was filled by local rules.");
    return;
  }
  const defaults = providerDefaults[provider] || {};
  const googleContext = provider === "google" && (!els.googleContextMode || els.googleContextMode.checked);
  setBusy(true);
  setStatus((provider === "doubao" ? "Doubao" : provider === "google" ? "Google" : "AI") + " translating this paragraph...");
  try {
    const translations = await postTranslateWithSplit({
      provider,
      endpoint: defaults.endpoint || els.endpointInput.value.trim(),
      apiKey: els.apiKeyInput.value.trim(),
      model: defaults.model || els.modelInput.value.trim(),
      glossary: parseGlossary(),
      from: "en",
      to: "zh-CN",
      googleMode: googleContext ? "context" : "normal",
      single: true,
      items: [{
        id: segment.id,
        tag: segment.tag,
        text: segment.originalText,
        html: segment.originalHtml,
        kind: segment.kind,
        ...segmentContext(segment)
      }]
    });
    const item = translations[0] || {};
    if (item.error) throw new Error(item.error);
    const repaired = repairSegmentTranslation(segment, item.html || "");
    if (!repaired || isEffectivelyUntranslated(segment, repaired)) throw new Error("Still untranslated.");
    segment.translationHtml = repaired;
    segment.failedReason = "";
    syncActiveWork();
    updateReady();
    schedulePreviewRender(true);
    setStatus("Filled this paragraph.");
  } catch (error) {
    segment.failedReason = error.message || "untranslated";
    syncActiveWork();
    updateReady();
    schedulePreviewRender(true);
    setStatus(error.message || "This paragraph did not translate.", true);
  } finally {
    setBusy(false);
  }
}

async function postTranslate(payload) {
  const controller = new AbortController();
  const timeoutMs = payload.provider === "doubao" ? (payload.single ? 35000 : 70000) : 85000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data.translations || [];
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(payload.provider === "doubao"
        ? "Doubao timed out; splitting this batch smaller."
        : "Translator timed out; splitting this batch smaller.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function postTranslateWithRetry(payload) {
  const isGoogle = payload.provider === "google";
  const delays = isGoogle ? [0, 450, 1100, 2200] : [0];
  let lastError;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) {
      setStatus(`Google 鏆傛椂娌℃帴浣忥紝绛変竴涓嬪啀璇?${attempt + 1}/${delays.length}...`);
      await sleep(delays[attempt]);
    }
    try {
      return await postTranslate(payload);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function postTranslateWithSplit(payload) {
  try {
    const items = payload.items || [];
    if (payload.provider === "google" && items.length > GOOGLE_FAST_SPLIT_ITEMS) {
      return await postTranslate(payload);
    }
    return await postTranslateWithRetry(payload);
  } catch (error) {
    const items = payload.items || [];
    if (payload.task === "polish" && items.length <= 1) {
      return items.map((item) => ({ id: item.id, html: item.current || item.html || "" }));
    }
    if (items.length <= 1 && ["doubao", "deepseek", "google"].includes(payload.provider)) {
      return items.map((item) => ({ id: item.id, html: "", error: error.message || "Request failed." }));
    }
    if (!["doubao", "deepseek", "google"].includes(payload.provider)) throw error;
    if (payload.provider === "google") {
      if (typeof payload.onSplit === "function") payload.onSplit();
      setStatus("Google batch was too large; splitting and continuing...");
      await sleep(1200);
    } else if (payload.provider === "doubao") {
      setStatus("Doubao is slow; splitting this batch smaller...");
      await sleep(350);
    }
    const middle = Math.ceil(items.length / 2);
    const left = await postTranslateWithSplit({ ...payload, items: items.slice(0, middle) });
    const right = await postTranslateWithSplit({ ...payload, items: items.slice(middle) });
    return [...left, ...right];
  }
}

async function polishChinese(provider = "deepseek") {
  const isDoubao = provider === "doubao";
  const hasKey = isDoubao ? hasServerDoubaoKey : hasServerDeepSeekKey;
  if (!els.apiKeyInput.value.trim() && !hasKey) {
    setStatus(`Fill ${isDoubao ? "Doubao" : "DeepSeek"} API Key once first.`, true);
    revealKeySettings(isDoubao ? "doubao" : "deepseek");
    return;
  }
  const translated = state.segments.filter((segment) => segment.kind === "body" && isTranslatedSegment(segment));
  const limits = isDoubao ? AI_CHUNK_LIMITS.polishDoubao : AI_CHUNK_LIMITS.polishDeepseek;
  const chunks = chunkSegmentsByLoad(translated, limits.maxItems, limits.maxChars);
  els.polishButton.disabled = true;
  if (els.doubaoPolishButton) els.doubaoPolishButton.disabled = true;
  setBusy(true);
  setProgress(0, translated.length);
  let done = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    setStatus(`${isDoubao ? "Doubao Pro" : "Fast"} polishing batch ${index + 1}/${chunks.length}...`);
    let translations;
    try {
      translations = await postTranslateWithSplit({
        provider,
        endpoint: providerDefaults[provider].endpoint,
        apiKey: els.apiKeyInput.value.trim(),
        model: providerDefaults[provider].model,
        task: "polish",
        temperature: 0.12,
        glossary: parseGlossary(),
        items: chunk.map((segment) => ({
          id: segment.id,
          source: segment.originalText,
          current: segment.translationHtml,
          html: segment.translationHtml,
          ...segmentContext(segment)
        }))
      });
    } catch (error) {
      setStatus(`杩欎竴灏忔壒娑﹁壊澶辫触锛屽凡璺宠繃缁х画锛?{error.message || error}`, true);
      done += chunk.length;
      setProgress(done, translated.length);
      continue;
    }
    for (const item of translations) {
      const segment = state.segmentById.get(item.id);
      if (segment) {
        segment.translationHtml = repairSegmentTranslation(segment, item.html || segment.translationHtml);
        segment.failedReason = isTranslatedSegment(segment) ? "" : "untranslated";
      }
    }
    done += chunk.length;
    setProgress(done, translated.length);
    if (index === chunks.length - 1 || index % 3 === 2) schedulePreviewRender();
  }
  els.polishButton.disabled = false;
  if (els.doubaoPolishButton) els.doubaoPolishButton.disabled = false;
  syncActiveWork();
  setProgress(activeWork()?.progressDone || 0, activeWork()?.progressTotal || state.segments.length);
  schedulePreviewRender(true);
  setBusy(false);
  setStatus("Polish done.");
}

async function doubaoRewriteSelected() {
  if (!els.apiKeyInput.value.trim() && !hasServerDoubaoKey) {
    setStatus("Fill Doubao API Key once, or set local ARK_API_KEY.", true);
    revealKeySettings("doubao");
    return;
  }
  const selected = state.segments.filter((segment) => selectedSegmentIds.has(segment.id) && segment.kind === "body");
  if (!selected.length) return setStatus("Select body paragraphs first.", true);
  const chunks = chunkSegmentsByLoad(selected, 4, 5200);
  if (els.doubaoPolishButton) els.doubaoPolishButton.disabled = true;
  setBusy(true);
  setProgress(0, selected.length);
  let done = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    setStatus(`Doubao Pro rewriting selected batch ${index + 1}/${chunks.length}...`);
    const translations = await postTranslateWithSplit({
      provider: "doubao",
      endpoint: providerDefaults.doubao.endpoint,
      apiKey: els.apiKeyInput.value.trim(),
      model: providerDefaults.doubao.model,
      task: "rewrite",
      temperature: 0.2,
      glossary: parseGlossary(),
      items: chunk.map((segment) => ({
        id: segment.id,
        source: segment.originalText,
        current: segment.translationHtml,
        html: segment.translationHtml || segment.originalHtml,
        ...segmentContext(segment)
      }))
    });
    for (const item of translations) {
      const segment = state.segmentById.get(item.id);
      if (segment) {
        segment.translationHtml = repairSegmentTranslation(segment, item.html || segment.translationHtml);
        segment.failedReason = isTranslatedSegment(segment) ? "" : "untranslated";
      }
    }
    done += chunk.length;
    setProgress(done, selected.length);
    schedulePreviewRender();
  }
  syncActiveWork();
  setProgress(activeWork()?.progressDone || 0, activeWork()?.progressTotal || state.segments.length);
  schedulePreviewRender(true);
  setBusy(false);
  updateReady();
  setStatus("Selected paragraphs rewritten by Doubao Pro.");
}

async function suggestTitles() {
  const sourceTitle = els.exportTitleInput.value.trim() || state.metadata?.title || "";
  if (!sourceTitle) return setStatus("No title to translate.", true);
  if (!els.apiKeyInput.value.trim() && !hasServerDeepSeekKey) {
    setStatus("Fill DeepSeek API Key once for AI title ideas.", true);
    revealKeySettings("deepseek");
    return;
  }
  els.titleSuggestButton.disabled = true;
  els.titleIdeas.innerHTML = `<p class="empty">Generating...</p>`;
  try {
    const translations = await postTranslate({
      provider: "deepseek",
      endpoint: providerDefaults.deepseek.endpoint,
      apiKey: els.apiKeyInput.value.trim(),
      model: providerDefaults.deepseek.model,
      task: "title",
      temperature: 0.75,
      glossary: parseGlossary(),
      items: [{
        id: "title",
        html: `<p>Title: ${escapeHtml(sourceTitle)}</p>`
      }]
    });
    const raw = textWithBreaks(translations[0]?.html || "");
    const ideas = raw.split(/[锛?\n|]/)
      .map((item) => item.replace(/^[0-9涓€浜屼笁鍥涗簲]\s*[.銆?锛?]?\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 5);
    els.titleIdeas.innerHTML = ideas.length
      ? ideas.map((idea) => `<button type="button" class="title-idea" data-title="${escapeHtml(idea)}">${escapeHtml(idea)}</button>`).join("")
      : `<p class="empty">${escapeHtml(raw || "No ideas returned.")}</p>`;
    setStatus("Title ideas ready.");
  } catch (error) {
    els.titleIdeas.innerHTML = "";
    setStatus(error.message || "Title ideas failed.", true);
  } finally {
    els.titleSuggestButton.disabled = false;
  }
}

async function loadServerConfig() {
  try {
    const response = await fetch("/api/config");
    const data = await response.json();
    hasServerDeepSeekKey = Boolean(data.hasDeepSeekKey);
    hasServerDoubaoKey = Boolean(data.hasDoubaoKey);
    updateAiSettings();
  } catch {
    els.keyStatus.textContent = "Key status unavailable.";
  }
}

function addTerm() {
  const source = els.termSourceInput.value.trim();
  const target = els.termTargetInput.value.trim();
  if (!source || !target) return setStatus("Fill both original and translation.", true);
  const lines = els.glossaryInput.value.split(/\r?\n/);
  const existingIndex = lines.findIndex((line) => {
    const index = line.search(/[:：]/);
    return index >= 0 && line.slice(0, index).trim().toLowerCase() === source.toLowerCase();
  });
  const nextLine = `${source}: ${target}`;
  if (existingIndex >= 0) lines[existingIndex] = nextLine;
  else lines.push(nextLine);
  els.glossaryInput.value = lines.map((line) => line.trim()).filter(Boolean).join("\n");
  saveGlossary();
  els.termSourceInput.value = "";
  els.termTargetInput.value = "";
  syncActiveWork();
  setStatus(existingIndex >= 0 ? `Updated glossary: ${source}` : `Added glossary: ${source}`);
}

function addPresets() {
  mergePresetGlossary(false);
}

function applyGlossaryToPreview() {
  let changed = 0;
  for (const segment of state.segments) {
    const current = segment.translationHtml || "";
    const repaired = repairSegmentTranslation(segment, current);
    const next = segment.kind === "meta" ? applyGlossaryToString(repaired) : applyUserGlossaryHtml(applyTrustedNameGlossary(repaired));
    if (next !== segment.translationHtml) {
      segment.translationHtml = next;
      changed += 1;
    }
  }
  const work = activeWork();
  const progress = recalculateWorkProgress(work);
  setProgress(progress.done, progress.total);
  schedulePreviewRender(true);
  setStatus(`Glossary applied to ${changed} segments.`);
}

function safeBase() {
  return (els.exportTitleInput.value.trim() || state.metadata?.title || state.fileName || "ao3-work")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function ensureExportStyle(doc, type) {
  const style = doc.createElement("style");
  style.textContent = [
    ".ao3-zh{font-weight:650;}",
    ".ao3-bilingual-body{margin-bottom:1.05em;}",
    ".ao3-bilingual-body>.ao3-en,.ao3-bilingual-body>.ao3-zh{display:block;margin:.35em 0;}",
    ".ao3-bilingual-body>.ao3-zh{margin-top:.55em;}",
    ".ao3-zh em,.ao3-zh i{font-style:normal;font-weight:750;letter-spacing:.03em;}",
    ".ao3-meta-zh{font-weight:650;}",
    type === "zh" ? ".ao3-en{display:none!important;}" : "",
    type === "en" ? ".ao3-zh{display:none!important;}" : ""
  ].filter(Boolean).join("\n");
  (doc.head || doc.documentElement).appendChild(style);
}

function replaceNodeHtml(node, html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const translated = doc.body.firstElementChild;
  if (translated && translated.tagName.toLowerCase() === node.tagName.toLowerCase()) {
    node.innerHTML = translated.innerHTML;
  } else {
    node.innerHTML = doc.body.innerHTML || node.innerHTML;
  }
}

function untranslatedExportHtml(segment) {
  if (isDecorativeSegment(segment)) return segment.originalHtml || "";
  return "";
}

function exportTranslationHtml(segment) {
  if (isDecorativeSegment(segment)) return applyReaderNameToHtml(segment.originalHtml || "", "en");
  return applyReaderNameToTranslationHtml(isTranslatedSegment(segment) ? segment.translationHtml : untranslatedExportHtml(segment), segment);
}

function innerHtmlForExport(html = "") {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  return doc.body.firstElementChild ? doc.body.firstElementChild.innerHTML : doc.body.innerHTML;
}

function cleanExportText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function isChapterTitleSegment(segment, exportTitle = "") {
  if (!segment || segment.kind !== "body" || !["title", "chapter-title"].includes(segment.scope)) return false;
  const text = cleanExportText(segment.originalText);
  if (!text || text.length > 160) return false;
  const title = cleanExportText(exportTitle);
  if (title && text.toLowerCase() === title.toLowerCase()) return false;
  const importedTitle = cleanExportText(state.metadata?.title || "");
  if (importedTitle && text.toLowerCase() === importedTitle.toLowerCase()) return false;
  if (/^(summary|notes?|chapter text|work text|preface|end notes?)$/i.test(text)) return false;
  return true;
}

function booxExportStyle(type) {
  return [
    "body{line-height:1.65;margin:0 auto;padding:1em;}",
    ".book-title{text-align:center;margin:1.5em 0 2em;}",
    ".book-author{text-align:center;margin:-1.5em 0 2em;}",
    ".frontmatter{margin:0 0 2em;}",
    ".meta-line{margin:0 0 .45em;}",
    ".toc{margin:1.5em 0 2.5em;}",
    ".toc a{text-decoration:none;}",
    ".chapter{break-before:page;page-break-before:always;}",
    ".chapter:first-of-type{break-before:auto;page-break-before:auto;}",
    ".chapter-title{text-align:center;margin:2em 0 1.5em;}",
    ".chapter-subtitle{text-align:center;margin:-1em 0 1.5em;font-weight:normal;}",
    ".segpair{margin:0 0 1.2em;}",
    ".src{margin:0 0 .35em;}",
    ".zh{margin:0;}",
    ".untranslated{opacity:.75;}",
    type === "zh" ? ".src{display:none;}" : "",
    type === "en" ? ".zh{display:none;}" : ""
  ].filter(Boolean).join("\n");
}

function buildBooxChapters(segments, exportTitle) {
  const bodySegments = segments.filter((segment) => isBooxBodySegment(segment, exportTitle));
  const explicitTitles = bodySegments.filter((segment) => isChapterTitleSegment(segment, exportTitle) || isChapterMarkerText(segment));
  const chapters = [];
  let current = null;
  let currentKey = "";

  const startChapter = (title, hasTitle = Boolean(title)) => {
    current = {
      id: "chapter-" + (chapters.length + 1),
      title: title || "",
      hasTitle,
      segments: []
    };
    chapters.push(current);
  };

  const ao3ChapterKeys = [...new Set(bodySegments.map((segment) => segment.chapterKey).filter(Boolean))];
  if (ao3ChapterKeys.length > 1) {
    for (const segment of bodySegments) {
      if (!segment.chapterKey) continue;
      if (segment.chapterKey !== currentKey) {
        currentKey = segment.chapterKey;
        const title = cleanExportText(segment.chapterTitle || "");
        startChapter(title, Boolean(title));
      }
      if (isChapterTitleSegment(segment, exportTitle) || isChapterMarkerText(segment)) {
        if (current && (!current.title || /^Chapter \d+$/i.test(current.title))) {
          current.title = cleanExportText(segment.originalText);
          current.hasTitle = Boolean(current.title);
        }
        continue;
      }
      current.segments.push(segment);
    }
    if (chapters.length) return chapters.filter((chapter) => chapter.segments.some((segment) => !isDecorativeSegment(segment)));
  }

  if (!explicitTitles.length) startChapter("");

  for (const segment of bodySegments) {
    if (isChapterTitleSegment(segment, exportTitle) || isChapterMarkerText(segment)) {
      startChapter(cleanExportText(segment.originalText));
      continue;
    }
    if (!current) startChapter("");
    current.segments.push(segment);
  }

  if (!chapters.length) startChapter("");
  return chapters.filter((chapter) => chapter.segments.some((segment) => !isDecorativeSegment(segment)));
}

function isChapterMarkerText(segment) {
  const text = cleanExportText(segment?.originalText || "");
  return /^chapter\s+\d+(?:\s*[:锛?-].*)?$/i.test(text);
}

function isBooxBodySegment(segment, exportTitle = "") {
  return Boolean(segment && (
    segment.kind !== "meta"
    && !["summary", "notes"].includes(segment.scope)
    && (!["title", "chapter-title"].includes(segment.scope) || isChapterTitleSegment(segment, exportTitle) || isChapterMarkerText(segment))
  ));
}

function hydrateChapterMetadataFromBooxHeadings(doc) {
  const root = doc.querySelector("#chapters") || doc.body;
  if (!root) return 0;

  let headings = [...root.querySelectorAll("h1.heading, h2.heading, h3.heading, h3.title, h2.title")]
    .filter((heading) => !heading.classList.contains("toc-heading"));
  if (!headings.length) {
    headings = [...root.querySelectorAll("p, div")].filter((node) => {
      if (node.children.length && ![...node.children].every((child) => child.matches("span, strong, b, em, i, a, br"))) return false;
      const text = cleanExportText(node.textContent);
      return text.length <= 160 && /^(?:chapter|part)\s+(?:\d+|[ivxlcdm]+)\b/i.test(text);
    });
  }

  const entries = [];
  const seenStarts = new Set();
  for (const heading of headings) {
    let start = heading;
    while (start.parentElement && start.parentElement !== root) start = start.parentElement;
    if (start.parentElement !== root || seenStarts.has(start)) continue;
    seenStarts.add(start);
    entries.push({
      start,
      title: cleanExportText(heading.textContent)
    });
  }
  if (entries.length <= 1) return 0;

  const children = [...root.children];
  const childIndex = new Map(children.map((child, index) => [child, index]));
  const starts = entries.map((entry) => childIndex.get(entry.start));
  const nodes = translatableNodes(doc);
  const lookup = buildSegmentLookup(state.segments);
  const usedIds = new Set();
  const counters = new Map();
  const assignedChapters = new Set();

  state.segments.forEach((segment) => {
    segment.chapterKey = "";
    segment.chapterTitle = "";
    segment.chapterOrder = 0;
  });

  nodes.forEach((node, nodeIndex) => {
    let top = node;
    while (top.parentElement && top.parentElement !== root) top = top.parentElement;
    const index = childIndex.get(top);
    if (index === undefined) return;
    let chapterIndex = -1;
    for (let i = 0; i < starts.length; i += 1) {
      if (starts[i] > index) break;
      chapterIndex = i;
    }
    if (chapterIndex < 0) return;
    const segment = segmentForExportNode(node, nodeIndex, lookup, usedIds, counters);
    if (!segment) return;
    usedIds.add(segment.id);
    segment.chapterKey = "boox-heading-chapter-" + (chapterIndex + 1);
    segment.chapterTitle = entries[chapterIndex].title;
    segment.chapterOrder = chapterIndex + 1;
    if (isBooxBodySegment(segment, state.metadata?.title || "")) assignedChapters.add(chapterIndex);
  });

  return assignedChapters.size;
}

function hydrateChapterMetadataFromRawHtml() {
  if (!state.rawHtml) return;
  const doc = new DOMParser().parseFromString(state.rawHtml, "text/html");
  sanitize(doc.documentElement);
  markAo3ChapterTitles(doc);
  normalizeAo3BreakParagraphs(doc);
  if (hydrateChapterMetadataFromBooxHeadings(doc) > 1) return;
  const nodes = translatableNodes(doc);
  const lookup = buildSegmentLookup(state.segments);
  const usedIds = new Set();
  const counters = new Map();
  const chapterInfos = new Map();
  const chapterInfoForNode = (node) => {
    const marker = ao3FlowChapterMarkerForNode(node);
    if (marker) {
      if (!chapterInfos.has(marker)) {
        const order = chapterInfos.size + 1;
        chapterInfos.set(marker, {
          key: marker.id || "ao3-chapter-" + order,
          title: chapterTitleFromAo3Marker(marker),
          order
        });
      }
      return chapterInfos.get(marker);
    }
    const chapter = chapterContainerForNode(node);
    if (!chapter) return { key: "", title: "", order: 0 };
    if (!chapterInfos.has(chapter)) {
      const order = chapterInfos.size + 1;
      chapterInfos.set(chapter, {
        key: chapter.id || "ao3-chapter-" + order,
        title: chapterTitleFromContainer(chapter),
        order
      });
    }
    return chapterInfos.get(chapter);
  };
  nodes.forEach((node, index) => {
    const segment = segmentForExportNode(node, index, lookup, usedIds, counters);
    if (!segment) return;
    usedIds.add(segment.id);
    const info = chapterInfoForNode(node);
    if (!info.key) return;
    segment.chapterKey = info.key;
    segment.chapterTitle = info.title;
    segment.chapterOrder = info.order;
  });
  const detectedChapterCount = new Set(state.segments.map((segment) => segment.chapterKey).filter(Boolean)).size;
  const flowChapterCount = ao3FlowChapterBlockCount(doc);
  if (flowChapterCount > detectedChapterCount || detectedChapterCount <= 1) {
    hydrateChapterMetadataByAo3FlowOrder(doc);
  }
}

function hydrateChapterMetadataByAo3FlowOrder(doc) {
  const chapterBlocks = [];
  const roots = [...doc.querySelectorAll("#chapters")];
  for (const root of roots) {
    let current = null;
    for (const child of root.children) {
      if (child.matches?.(".meta.group")) {
        const title = chapterTitleFromAo3Marker(child);
        if (title) {
          current = { title, nodes: [] };
          chapterBlocks.push(current);
        }
        continue;
      }
      if (current && child.matches?.(".userstuff, blockquote, div, section, article")) {
        current.nodes.push(...translatableNodes(child));
      }
    }
  }
  const blocks = chapterBlocks.filter((block) => block.nodes.length);
  if (blocks.length <= 1) return;
  const targetSegments = state.segments.filter((segment) => isBooxBodySegment(segment, state.metadata?.title || ""));
  if (!targetSegments.length) return;
  targetSegments.forEach((segment) => {
    segment.chapterKey = "";
    segment.chapterTitle = "";
    segment.chapterOrder = 0;
  });
  let offset = 0;
  blocks.forEach((block, blockIndex) => {
    const key = "ao3-flow-chapter-" + (blockIndex + 1);
    const isLast = blockIndex === blocks.length - 1;
    const sliceEnd = isLast ? targetSegments.length : Math.min(targetSegments.length, offset + block.nodes.length);
    for (const segment of targetSegments.slice(offset, sliceEnd)) {
      segment.chapterKey = key;
      segment.chapterTitle = block.title;
      segment.chapterOrder = blockIndex + 1;
    }
    offset = sliceEnd;
  });
}

function buildSegPairHtml(segment, type) {
  const source = innerHtmlForExport(applyReaderNameToHtml(segment.originalHtml, "en"));
  if (isDecorativeSegment(segment)) {
    return "<section class=\"segpair decorative\" id=\"" + escapeHtml(segment.id) + "\"><p class=\"src\">" + source + "</p></section>";
  }
  const translated = isTranslatedSegment(segment)
    ? innerHtmlForExport(applyReaderNameToTranslationHtml(segment.translationHtml, segment))
    : "";
  if (type === "zh" && !translated) return "";
  return [
    "<section class=\"segpair\" id=\"" + escapeHtml(segment.id) + "\">",
    type !== "zh" ? "<p class=\"src\">" + source + "</p>" : "",
    type !== "en" && translated ? "<p class=\"zh\">" + translated + "</p>" : "",
    "</section>"
  ].filter(Boolean).join("\n");
}

function hasExportBodyContent(segment, type) {
  if (!segment || isDecorativeSegment(segment)) return false;
  if (isChapterTitleSegment(segment) || isChapterMarkerText(segment)) return false;
  const sourceText = textOnly(segment.originalHtml || segment.originalText || "");
  const translatedText = textOnly(segment.translationHtml || "");
  if (type === "zh") return Boolean(translatedText);
  if (type === "en") return Boolean(sourceText);
  return Boolean(sourceText || translatedText);
}

function buildFrontMatterHtml(segments, type) {
  const frontSegments = segments.filter((segment) => segment.kind === "meta" || ["summary", "notes"].includes(segment.scope));
  if (!frontSegments.length) return "";
  const rows = frontSegments.map((segment) => {
    if (segment.kind === "meta") {
      const original = escapeHtml(segment.originalText || "");
      const translated = isTranslatedSegment(segment) ? escapeHtml(textOnly(segment.translationHtml)) : "";
      const text = translated && translated !== original ? original + " / " + translated : original;
      return "<p class=\"meta-line\">" + text + "</p>";
    }
    return buildSegPairHtml(segment, type);
  }).filter(Boolean).join("\n");
  return "<section class=\"frontmatter\">\n" + rows + "\n</section>";
}

function chapterDisplayTitle(chapter) {
  return cleanExportText(chapter?.title || "");
}

function chapterOriginalTitle(chapter, index) {
  const title = cleanExportText(chapter?.title || "");
  return title && title !== chapterDisplayTitle(chapter) ? title : "";
}

function applyBilingualHtml(node, translationHtml) {
  const originalClone = node.cloneNode(true);
  const translatedClone = node.cloneNode(true);
  replaceNodeHtml(translatedClone, translationHtml || node.outerHTML);
  originalClone.classList.add("ao3-en");
  translatedClone.classList.add("ao3-zh");
  const wrapper = node.ownerDocument.createElement("div");
  wrapper.className = "ao3-bilingual-body";
  wrapper.append(originalClone, translatedClone);
  node.replaceWith(wrapper);
}

function applyBilingualMeta(node, translationHtml) {
  const translated = textOnly(translationHtml);
  const original = node.textContent.replace(/\s+/g, " ").trim();
  if (translated && translated !== original) node.textContent = `${original} / ${translated}`;
}

function buildHtml(type) {
  const exportTitle = els.exportTitleInput.value.trim() || state.metadata?.title || state.fileName || "AO3 Work";
  const author = state.metadata?.author || "";
  const lang = type === "en" ? "en" : "zh-CN";
  hydrateChapterMetadataFromRawHtml();
  const chapters = buildBooxChapters(state.segments, exportTitle);
  const renderedChapters = chapters
    .map((chapter, index) => ({
      chapter,
      index,
      rows: chapter.segments.map((segment) => buildSegPairHtml(segment, type)).filter(Boolean)
    }))
    .filter((item) => item.rows.length && item.chapter.segments.some((segment) => hasExportBodyContent(segment, type)));
  const tocChapters = renderedChapters
    .map((item, visibleIndex) => ({
      ...item,
      title: item.chapter.hasTitle ? chapterDisplayTitle(item.chapter) : ""
    }))
    .filter((item) => item.title);
  const toc = tocChapters.length ? [
    '<nav id="toc" class="toc" role="doc-toc">',
    "<h2>\u76ee\u5f55</h2>",
    "<ol>",
    ...tocChapters.map(({ chapter, title }) => "<li><a href=\"#" + escapeHtml(chapter.id) + "\">" + escapeHtml(title) + "</a></li>"),
    "</ol>",
    "</nav>"
  ].join("\n") : "";
  const frontMatter = buildFrontMatterHtml(state.segments, type);
  const chapterHtml = renderedChapters.map((item, visibleIndex) => {
    const title = item.chapter.hasTitle ? chapterDisplayTitle(item.chapter) : "";
    const originalTitle = chapterOriginalTitle(item.chapter, visibleIndex);
    return [
      "<section class=\"chapter\">",
      title ? "<h1 class=\"chapter-title\" id=\"" + escapeHtml(item.chapter.id) + "\">" + escapeHtml(title) + "</h1>" : "",
      originalTitle ? "<p class=\"chapter-subtitle\">" + escapeHtml(originalTitle) + "</p>" : "",
      item.rows.join("\n"),
      "</section>"
  ].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n");
  return [
    "<!doctype html>",
    "<html lang=\"" + lang + "\">",
    "<head>",
    '<meta charset="utf-8">',
    "<title>" + escapeHtml(exportTitle) + "</title>",
    "<style>" + booxExportStyle(type) + "</style>",
    "</head>",
    "<body>",
    "<h1 class=\"book-title\">" + escapeHtml(exportTitle) + "</h1>",
    author ? "<p class=\"book-author\">" + escapeHtml(author) + "</p>" : "",
    frontMatter,
    toc,
    chapterHtml,
    "</body>",
    "</html>"
  ].filter(Boolean).join("\n");
}

function download(name, text, type = "text/html;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function u16(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255]);
}

function u32(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = (date.getFullYear() - 1980) << 9 | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function storedZip(files) {
  const encoder = new TextEncoder();
  const now = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    const crc = crc32(data);
    const local = concatBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(now.time), u16(now.day),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
    ]);
    const central = concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(now.time), u16(now.day),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name
    ]);
    localParts.push(local);
    centralParts.push(central);
    offset += local.length;
  }
  const central = concatBytes(centralParts);
  const end = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(offset), u16(0)
  ]);
  return new Blob([...localParts, central, end], { type: "application/epub+zip" });
}

function epubContent(type) {
  const title = els.exportTitleInput.value.trim() || state.metadata?.title || "AO3 Work";
  const author = state.metadata?.author || "";
  const doc = document.implementation.createHTMLDocument(title);
  doc.documentElement.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  doc.documentElement.setAttribute("lang", type === "en" ? "en" : "zh-CN");
  doc.head.innerHTML = `<title>${escapeHtml(title)}</title><meta charset="utf-8"><style>
    body{font-family:serif;line-height:1.75;margin:1.2em;}
    h1{font-size:1.45em;margin:0 0 .2em;}
    .byline{color:#666;margin:0 0 1.2em;}
    .meta{font-family:sans-serif;color:#555;font-size:.92em;}
    .pair{margin:1em 0 1.2em;}
    .en,.zh{display:block;margin:.35em 0;}
    .zh{font-weight:650;}
    .zh em,.zh i{font-style:normal;font-weight:750;letter-spacing:.03em;}
  </style>`;
  doc.body.innerHTML = "";
  const h1 = doc.createElement("h1");
  h1.textContent = title;
  doc.body.appendChild(h1);
  if (author) {
    const byline = doc.createElement("p");
    byline.className = "byline";
    byline.textContent = author;
    doc.body.appendChild(byline);
  }

  for (const segment of state.segments) {
    if (type === "zh" && !isTranslatedSegment(segment) && !isDecorativeSegment(segment)) continue;
    const wrapper = doc.createElement(segment.kind === "meta" ? "p" : "div");
    wrapper.className = segment.kind === "meta" ? "meta" : "pair";
    if (type === "en") {
      wrapper.innerHTML = applyReaderNameToHtml(segment.originalHtml, "en");
    } else if (type === "zh") {
      wrapper.innerHTML = exportTranslationHtml(segment);
    } else if (segment.kind === "meta") {
      const translated = isTranslatedSegment(segment) ? textOnly(segment.translationHtml) : "";
      wrapper.textContent = translated && translated !== segment.originalText
        ? `${segment.originalText} / ${translated}`
        : segment.originalText;
    } else {
      const translated = exportTranslationHtml(segment);
      wrapper.innerHTML = `<div class="en">${applyReaderNameToHtml(segment.originalHtml, "en")}</div>${translated ? `<div class="zh">${translated}</div>` : ""}`;
    }
    doc.body.appendChild(wrapper);
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n${new XMLSerializer().serializeToString(doc.documentElement)}`;
}

function buildEpub(type) {
  const title = els.exportTitleInput.value.trim() || state.metadata?.title || "AO3 Work";
  const author = state.metadata?.author || "Unknown";
  const identifier = `urn:uuid:${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const content = epubContent(type);
  return storedZip([
    { name: "mimetype", content: "application/epub+zip" },
    { name: "META-INF/container.xml", content: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>` },
    { name: "OEBPS/content.opf", content: `<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeHtml(identifier)}</dc:identifier>
    <dc:title>${escapeHtml(title)}</dc:title>
    <dc:creator>${escapeHtml(author)}</dc:creator>
    <dc:language>${type === "en" ? "en" : "zh-CN"}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="content"/></spine>
</package>` },
    { name: "OEBPS/nav.xhtml", content: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${type === "en" ? "en" : "zh-CN"}">
  <head><title>${escapeHtml(title)}</title></head>
  <body><nav epub:type="toc"><ol><li><a href="content.xhtml">${escapeHtml(title)}</a></li></ol></nav></body>
</html>` },
    { name: "OEBPS/content.xhtml", content }
  ]);
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

async function inflateRaw(bytes) {
  if ("DecompressionStream" in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  await loadRawInflate();
  if (!window.Zlib?.RawInflate) throw new Error("This browser cannot unzip compressed EPUB files.");
  return new Uint8Array(new window.Zlib.RawInflate(bytes).decompress());
}

function loadRawInflate() {
  if (window.Zlib?.RawInflate) return Promise.resolve();
  if (rawInflateLoader) return rawInflateLoader;
  rawInflateLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "./vendor/rawinflate.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not load local EPUB unzip helper."));
    document.head.appendChild(script);
  });
  return rawInflateLoader;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function unzipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i -= 1) {
    if (readU32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid EPUB zip.");
  const count = readU16(bytes, eocd + 10);
  let offset = readU32(bytes, eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (readU32(bytes, offset) !== 0x02014b50) break;
    const method = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);
    const name = decodeUtf8(bytes.slice(offset + 46, offset + 46 + nameLength));
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    const content = method === 0 ? data : method === 8 ? await inflateRaw(data) : null;
    if (content) entries.set(name, content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function epubDirname(path = "") {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index + 1) : "";
}

function resolveEpubPath(base = "", href = "") {
  const parts = (epubDirname(base) + href).split("/");
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function firstText(doc, selector) {
  return cleanExportText(doc.querySelector(selector)?.textContent || "");
}

async function epubToHtml(file) {
  const buffer = await file.arrayBuffer();
  try {
    const response = await fetch("/api/epub-to-html", {
      method: "POST",
      headers: {
        "content-type": "application/epub+zip",
        "x-file-name": encodeURIComponent(file.name)
      },
      body: buffer
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.html) throw new Error(data.error || "EPUB import failed.");
    return data.html;
  } catch (error) {
    // Older running servers may not have the EPUB route yet; fall back to local unzip.
  }
  const entries = await unzipEntries(buffer);
  const containerText = entries.get("META-INF/container.xml");
  if (!containerText) throw new Error("EPUB missing container.xml.");
  const container = new DOMParser().parseFromString(decodeUtf8(containerText), "text/xml");
  const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath || !entries.has(opfPath)) throw new Error("EPUB missing package file.");
  const opf = new DOMParser().parseFromString(decodeUtf8(entries.get(opfPath)), "text/xml");
  const title = firstText(opf, "title, dc\\:title") || file.name.replace(/\.epub$/i, "");
  const author = firstText(opf, "creator, dc\\:creator");
  const manifest = new Map();
  opf.querySelectorAll("manifest item").forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest.set(id, resolveEpubPath(opfPath, href));
  });
  let chapterPaths = [...opf.querySelectorAll("spine itemref")]
    .map((item) => manifest.get(item.getAttribute("idref") || ""))
    .filter(Boolean);
  if (!chapterPaths.length) {
    chapterPaths = [...entries.keys()].filter((name) => /\.(xhtml|html|htm)$/i.test(name) && !/nav|toc/i.test(name));
  }

  const chapters = [];
  for (const path of chapterPaths) {
    const raw = entries.get(path);
    if (!raw) continue;
    const doc = new DOMParser().parseFromString(decodeUtf8(raw), "text/html");
    sanitize(doc.documentElement);
    const heading = doc.body?.querySelector("h1, h2, h3");
    const chapterTitle = cleanExportText(heading?.textContent || doc.querySelector("title")?.textContent || "");
    if (heading) heading.remove();
    const content = doc.body?.innerHTML || "";
    if (!cleanExportText(content)) continue;
    chapters.push(
      "<section class=\"chapter\">" +
      (chapterTitle ? "<h3 class=\"title\">" + escapeHtml(chapterTitle) + "</h3>" : "") +
      "<div class=\"userstuff\">" + content + "</div>" +
      "</section>"
    );
  }
  if (!chapters.length) throw new Error("No readable EPUB chapters found.");
  return [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><title>" + escapeHtml(title) + "</title></head><body>",
    "<h2 class=\"title heading\">" + escapeHtml(title) + "</h2>",
    author ? "<h3 class=\"byline heading\">" + escapeHtml(author) + "</h3>" : "",
    "<div id=\"chapters\">",
    chapters.join("\n"),
    "</div>",
    "</body></html>"
  ].join("\n");
}

function isImportableFile(file) {
  return /\.epub$/i.test(file.name)
    || /\.x?html?$/i.test(file.name)
    || file.type === "text/html"
    || file.type === "application/epub+zip"
    || !file.type;
}

async function importableFileText(file) {
  return /\.epub$/i.test(file.name) || file.type === "application/epub+zip"
    ? epubToHtml(file)
    : file.text();
}

function restoreTranslationsFromWork(previousWork, nextWork) {
  if (!previousWork?.segments?.length || !nextWork?.segments?.length) return 0;
  const previousByKey = new Map(previousWork.segments.map((segment) => [segment.key, segment]));
  let restored = 0;
  for (const segment of nextWork.segments) {
    const previous = previousByKey.get(segment.key);
    if (!previous?.translationHtml) continue;
    segment.translationHtml = previous.translationHtml;
    segment.failedReason = previous.failedReason || "";
    restored += 1;
  }
  return restored;
}

function sourceChapterCount(rawHtml = "") {
  if (!rawHtml) return 0;
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");
  const root = doc.querySelector("#chapters") || doc.body;
  return root ? root.querySelectorAll("h1.heading, h2.heading, h3.heading, h3.title, h2.title").length : 0;
}

async function restoreOriginalChapterStructure() {
  const work = activeWork();
  if (!work || sourceChapterCount(work.rawHtml) > 1) return false;
  try {
    const response = await fetch("/api/restore-download-source", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName: work.fileName })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || sourceChapterCount(data.html) <= 1) return false;
    const previous = { segments: work.segments };
    const previousTitle = work.exportTitle || els.exportTitleInput.value.trim();
    work.rawHtml = data.html;
    parseWork(work, { quiet: true });
    const restored = restoreTranslationsFromWork(previous, work);
    work.exportTitle = previousTitle;
    els.exportTitleInput.value = previousTitle;
    work.progressDone = work.segments.filter(isTranslatedSegment).length;
    work.progressTotal = work.segments.length;
    work.status = "Restored original chapters and kept " + restored + " translations.";
    rebuildSegmentIndex(work);
    syncActiveWork();
    scheduleWorkListRender(true);
    return true;
  } catch {
    return false;
  }
}

async function addImportedWork(fileName, rawHtml, sizeKb = "") {
  const existingIndex = state.works.findIndex((item) => item.fileName === fileName);
  const previousWork = existingIndex >= 0 ? state.works[existingIndex] : null;
  const work = {
    fileName,
    rawHtml,
    metadata: null,
    segments: [],
    exportTitle: "",
    selectedIds: [],
    sizeKb,
    progressDone: 0,
    progressTotal: 0,
    status: ""
  };
  if (existingIndex >= 0) state.works[existingIndex] = work;
  else state.works.push(work);
  state.currentWorkIndex = existingIndex >= 0 ? existingIndex : state.works.length - 1;
  selectedSegmentIds.clear();
  parseWork(work, { quiet: true });
  const restored = restoreTranslationsFromWork(previousWork, work);
  if (previousWork?.exportTitle) work.exportTitle = previousWork.exportTitle;
  work.progressDone = work.segments.filter(isTranslatedSegment).length;
  work.progressTotal = work.segments.length;
  work.status = restored ? `Re-imported source and kept ${restored} translations.` : work.status;
  rebuildSegmentIndex(work);
  syncActiveWork();
  return work;
}

async function handleFiles(files) {
  try {
    const incoming = [...(files || [])].filter(isImportableFile);
    if (!incoming.length) {
      setStatus("No HTML or EPUB file found. Please choose .html, .htm, .xhtml, or .epub.", true);
      return;
    }
    setStatus(`Importing ${incoming.length} file${incoming.length > 1 ? "s" : ""}...`);
    let firstImportedIndex = -1;
    for (const file of incoming) {
      setStatus(`Importing ${file.name}...`);
      await addImportedWork(file.name, await importableFileText(file), (file.size / 1024).toFixed(1));
      if (firstImportedIndex < 0) firstImportedIndex = state.currentWorkIndex;
    }
    setActiveWork(firstImportedIndex);
    updateFileMeta();
  } catch (error) {
    setStatus(`Import failed: ${error.message || error}`, true);
  } finally {
    if (els.fileInput) els.fileInput.value = "";
  }
}

async function importLocalPath() {
  const path = els.localPathInput?.value.trim();
  if (!path) return setStatus("Paste a local HTML or EPUB path first.", true);
  try {
    setStatus("Importing local file...");
    const response = await fetch("/api/import-local-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.html) throw new Error(data.error || "Local import failed.");
    await addImportedWork(data.fileName || path.split(/[\\/]/).pop() || "AO3 Work", data.html, data.sizeKb || "");
    setActiveWork(state.currentWorkIndex);
    updateFileMeta();
  } catch (error) {
    setStatus(`Import failed: ${error.message || error}`, true);
  }
}

async function importOneFromEndpoint(url, options = {}, loadingText = "Importing file...") {
  try {
    setStatus(loadingText);
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.html) throw new Error(data.error || "Import failed.");
    await addImportedWork(data.fileName || "AO3 Work", data.html, data.sizeKb || "");
    setActiveWork(state.currentWorkIndex);
    updateFileMeta();
  } catch (error) {
    setStatus(`Import failed: ${error.message || error}`, true);
  }
}

async function importFolderFiles() {
  try {
    setStatus("Checking import folder...");
    const listResponse = await fetch("/api/import-folder");
    const list = await listResponse.json().catch(() => ({}));
    if (!listResponse.ok) throw new Error(list.error || "Could not open import folder.");
    if (els.importFolderHint) els.importFolderHint.textContent = list.folder || "";
    const files = Array.isArray(list.files) ? list.files : [];
    if (!files.length) {
      setStatus(`Put .html or .epub files in: ${list.folder}`, true);
      return;
    }
    let firstImportedIndex = -1;
    for (const name of files) {
      setStatus(`Importing ${name}...`);
      const response = await fetch("/api/import-folder-file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.html) throw new Error(data.error || `Could not import ${name}.`);
      await addImportedWork(data.fileName || name, data.html, data.sizeKb || "");
      if (firstImportedIndex < 0) firstImportedIndex = state.currentWorkIndex;
    }
    setActiveWork(firstImportedIndex);
    updateFileMeta();
  } catch (error) {
    setStatus(`Import failed: ${error.message || error}`, true);
  }
}

els.providerSelect.addEventListener("change", () => {
  updateAiSettings();
});
if (els.googleContextMode) {
  els.googleContextMode.checked = false;
  localStorage.setItem(GOOGLE_CONTEXT_STORAGE_KEY, "0");
  els.googleContextMode.addEventListener("change", () => {
    localStorage.setItem(GOOGLE_CONTEXT_STORAGE_KEY, els.googleContextMode.checked ? "1" : "0");
  });
}
els.apiKeyInput.addEventListener("input", () => {
  if (els.apiKeyInput.value.trim()) els.aiSettings.hidden = true;
});
els.fileInput.addEventListener("change", () => handleFiles(els.fileInput.files));
els.fileInput.addEventListener("click", () => {
  els.fileInput.value = "";
});
els.latestDownloadButton?.addEventListener("click", () => {
  importOneFromEndpoint("/api/import-latest-download", { method: "POST" }, "Importing latest download...");
});
els.localPathButton?.addEventListener("click", importLocalPath);
els.localPathInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") importLocalPath();
});
els.importFolderButton?.addEventListener("click", importFolderFiles);
els.dropZone.addEventListener("dragover", (event) => event.preventDefault());
els.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  handleFiles(event.dataTransfer.files);
});
els.workList.addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete-work]");
  if (deleteButton) {
    event.preventDefault();
    event.stopPropagation();
    removeWork(Number(deleteButton.dataset.deleteWork));
    return;
  }
  const button = event.target.closest("[data-work-index]");
  if (!button) return;
  if (document.body.classList.contains("busy")) {
    setStatus("Current work is translating. Wait for it to finish before switching works.", true);
    return;
  }
  setActiveWork(Number(button.dataset.workIndex));
});
els.startButton.addEventListener("click", async () => {
  try {
    await translateAll();
  } catch (error) {
    els.startButton.disabled = false;
    setBusy(false);
    const message = String(error.message || "Translation failed.");
    setStatus(message.includes("Google")
      ? "Google did not respond. Wait a bit and click Start translate again; only missing paragraphs will retry."
      : message, true);
  }
});
if (els.stopButton) {
  els.stopButton.addEventListener("click", () => {
    translationStopRequested = true;
    bulkTranslateMode = false;
    setStatus("Stopping after the current Google batch returns...");
  });
}
if (els.startAllButton) {
  els.startAllButton.addEventListener("click", async () => {
    try {
      await translateAllWorks();
    } catch (error) {
      bulkTranslateMode = false;
      setBusy(false);
      updateReady();
      setStatus(error.message || "Batch translate failed.", true);
    }
  });
}
if (els.doubaoMissingButton) {
  els.doubaoMissingButton.addEventListener("click", async () => {
    revealKeySettings("doubao");
    setStatus("Doubao is available after API key / quota is ready. Full translation uses Google for now.", true);
  });
}
els.polishButton.addEventListener("click", async () => {
  revealKeySettings("deepseek");
  setStatus("AI polish is available after API key / quota is ready.", true);
});
if (els.doubaoPolishButton) {
  els.doubaoPolishButton.addEventListener("click", async () => {
    revealKeySettings("doubao");
    setStatus("Doubao rewrite is available after API key / quota is ready.", true);
  });
}
if (els.clearTranslationsButton) {
  els.clearTranslationsButton.addEventListener("click", clearCurrentTranslations);
}
els.addTermButton.addEventListener("click", addTerm);
els.termTargetInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addTerm();
});
if (els.applyReaderNameButton) {
  els.applyReaderNameButton.addEventListener("click", () => {
    saveReaderName();
    for (const segment of state.segments) {
      if (segment.translationHtml) segment.translationHtml = repairSegmentTranslation(segment, segment.translationHtml);
    }
    syncActiveWork();
    schedulePreviewRender(true);
    setStatus((readerNameZh() || readerNameEn()) ? "Y/N names applied to preview and exports." : "Y/N names cleared.");
  });
}
if (els.readerNameInput) {
  els.readerNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && els.applyReaderNameButton) els.applyReaderNameButton.click();
  });
}
if (els.readerNameEnInput) {
  els.readerNameEnInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && els.applyReaderNameButton) els.applyReaderNameButton.click();
  });
}
els.presetGlossaryButton.addEventListener("click", addPresets);
els.applyGlossaryButton.addEventListener("click", applyGlossaryToPreview);
els.glossaryInput.addEventListener("input", saveGlossary);
els.exportTitleInput.addEventListener("input", () => {
  const work = activeWork();
  if (work) work.exportTitle = els.exportTitleInput.value.trim();
  scheduleSessionSave();
});
els.titleSuggestButton.addEventListener("click", suggestTitles);
els.titleIdeas.addEventListener("click", async (event) => {
  const button = event.target.closest(".title-idea");
  if (!button) return;
  const title = button.dataset.title || button.textContent.trim();
  await navigator.clipboard.writeText(title).catch(() => {});
  setStatus(`Copied title idea: ${title}`);
});
els.preview.addEventListener("input", (event) => {
  const pair = event.target.closest(".pair");
  if (!pair || !event.target.closest(".zh")) return;
  const segment = state.segmentById.get(pair.dataset.id);
  if (segment) {
    segment.translationHtml = event.target.closest(".zh").innerHTML;
    segment.failedReason = isTranslatedSegment(segment) ? "" : "untranslated";
    if (previewEditSaveTimer) clearTimeout(previewEditSaveTimer);
    previewEditSaveTimer = window.setTimeout(() => {
      const progress = recalculateWorkProgress(activeWork());
      setProgress(progress.done, progress.total);
      syncActiveWork();
      updateReady();
    }, 900);
  }
});

els.preview.addEventListener("blur", (event) => {
  if (!event.target.closest?.(".zh")) return;
  if (previewEditSaveTimer) clearTimeout(previewEditSaveTimer);
  previewEditSaveTimer = 0;
  const progress = recalculateWorkProgress(activeWork());
  setProgress(progress.done, progress.total);
  syncActiveWork();
  updateReady();
}, true);
els.preview.addEventListener("click", (event) => {
  const retryButton = event.target.closest("[data-retry-segment]");
  if (retryButton) {
    const pair = retryButton.closest(".pair");
    if (!pair) return;
    void translateOneSegment(pair.dataset.id, retryButton.dataset.retrySegment);
    return;
  }
  const missingButton = event.target.closest("[data-preview-missing]");
  if (missingButton) {
    state.previewMissingOnly = !state.previewMissingOnly;
    state.previewVisibleCount = PREVIEW_LIMIT;
    updateReady();
    schedulePreviewRender(true);
    return;
  }
  const moreButton = event.target.closest("[data-preview-more]");
  if (!moreButton) return;
  extendPreviewPage();
});
els.preview.addEventListener("change", (event) => {
  if (!event.target.classList.contains("segment-select")) return;
  const pair = event.target.closest(".pair");
  if (!pair) return;
  if (event.target.checked) selectedSegmentIds.add(pair.dataset.id);
  else selectedSegmentIds.delete(pair.dataset.id);
  saveActiveSelection();
  updateReady();
});
els.modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    els.modeButtons.forEach((item) => item.classList.toggle("active", item === button));
    schedulePreviewRender(true);
    scheduleSessionSave();
  });
});
els.exportButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    await restoreOriginalChapterStructure();
    const type = button.dataset.export;
    const suffix = type === "bilingual" ? "bilingual" : type === "zh" ? "zh" : "en";
    download(`${safeBase()} ${suffix}.html`, buildHtml(type));
  });
});
els.epubButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    await restoreOriginalChapterStructure();
    const type = button.dataset.epub;
    const suffix = type === "bilingual" ? "bilingual" : type === "zh" ? "zh" : "en";
    downloadBlob(`${safeBase()} ${suffix}.epub`, buildEpub(type));
  });
});
if (els.togglePreviewButton) {
  els.togglePreviewButton.addEventListener("click", () => {
    extendPreviewPage();
    updateReady();
  });
}

window.addEventListener("scroll", () => {
  window.requestAnimationFrame(maybeExtendPreviewOnScroll);
}, { passive: true });

document.documentElement.dataset.appJsBottom = "reached";
loadSavedGlossary();
loadReaderName();
if (new URLSearchParams(window.location.search).get("autoImport") === "latest") {
  window.setTimeout(() => {
    importOneFromEndpoint("/api/import-latest-download", { method: "POST" }, "Importing latest download...");
  }, 200);
}
const embeddedAutoWork = $("#autoWorkJson")?.value;
if (embeddedAutoWork || window.__AUTO_IMPORT_WORK__) {
  void (async () => {
    try {
      const work = embeddedAutoWork ? JSON.parse(embeddedAutoWork) : window.__AUTO_IMPORT_WORK__;
    setStatus(`Importing ${work.fileName || "latest download"}...`);
    await addImportedWork(work.fileName || "AO3 Work", work.html || "", work.sizeKb || "");
    setActiveWork(state.currentWorkIndex);
    updateFileMeta();
    } catch (error) {
      setStatus(`Embedded import failed: ${error.message || error}`, true);
    }
  })();
}
restoreSavedSession().then((restored) => {
  if (!restored) updateReady();
}).finally(() => {
  loadServerConfig();
});
