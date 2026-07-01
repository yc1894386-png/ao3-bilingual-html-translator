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
const PREVIEW_LIMIT = 120;
const PREVIEW_PAGE_SIZE = 180;
const GLOSSARY_STORAGE_KEY = "ao3TranslatorGlossary";
const GOOGLE_CONTEXT_STORAGE_KEY = "ao3GoogleContextMode";
const READER_NAME_STORAGE_KEY = "ao3TranslatorReaderName";
const SESSION_DB_NAME = "ao3TranslatorSessionDb";
const SESSION_STORE_NAME = "sessions";
const SESSION_RECORD_KEY = "latest";
const SESSION_FALLBACK_KEY = "ao3TranslatorSessionFallback";
const SESSION_FALLBACK_CHUNK_PREFIX = "ao3TranslatorSessionFallbackChunk:";
const GOOGLE_CONTEXT_MAX_ITEMS = 32;
const GOOGLE_CONTEXT_MAX_CHARS = 24000;
const GOOGLE_NORMAL_MAX_ITEMS = 24;
const GOOGLE_NORMAL_MAX_CHARS = 18000;
const GOOGLE_FAST_CONCURRENCY = 2;
const AI_CHUNK_LIMITS = {
  doubao: { maxItems: 5, maxChars: 5600 },
  deepseek: { maxItems: 8, maxChars: 8500 },
  polishDoubao: { maxItems: 4, maxChars: 5200 },
  polishDeepseek: { maxItems: 10, maxChars: 10000 }
};

const els = {
  fileInput: $("#fileInput"),
  dropZone: $("#dropZone"),
  fileMeta: $("#fileMeta"),
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
  readerNameInput: $("#readerNameInput"),
  applyReaderNameButton: $("#applyReaderNameButton"),
  presetGlossaryButton: $("#presetGlossaryButton"),
  applyGlossaryButton: $("#applyGlossaryButton"),
  startButton: $("#startButton"),
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
let workListRenderTimer = 0;
let lastWorkListKey = "";
let rawInflateLoader = null;
let sessionSaveTimer = 0;
let sessionSaveInFlight = false;
let sessionSaveAgain = false;
let restoringSession = false;

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
  return Boolean(segment && textOnly(segment.translationHtml || ""));
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
  schedulePreviewRender(true);
  scheduleSessionSave();
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
  scheduleSessionSave();
}

function updateFileMeta() {
  if (!els.fileMeta) return;
  if (!state.works.length) {
    els.fileMeta.textContent = "or drag files here";
    return;
  }
  if (state.works.length === 1) {
    const work = state.works[0];
    els.fileMeta.textContent = work.sizeKb ? `${work.fileName} · ${work.sizeKb} KB` : work.fileName;
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
    setStatus("翻译/润色还在运行，先等它结束再删除作品。", true);
    return;
  }
  const work = state.works[index];
  if (!work) return;
  const title = work.metadata?.title || work.fileName || `Work ${index + 1}`;
  const confirmed = window.confirm(`删除「${title}」？\n\n只会从当前网页列表移除，不会删除你电脑里的原 HTML 文件。`);
  if (!confirmed) return;

  if (index === state.currentWorkIndex) selectedSegmentIds.clear();
  state.works.splice(index, 1);

  if (!state.works.length) {
    resetActiveWork(`已删除「${title}」。`);
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
  setStatus(`已删除「${title}」。`);
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

const legacyPresets = [
  ["Leon", "里昂"],
  ["Leon S. Kennedy", "里昂·S·肯尼迪"],
  ["Leon Kennedy", "里昂·肯尼迪"],
  ["Rebecca", "瑞贝卡"],
  ["Rebecca Chambers", "瑞贝卡·钱伯斯"],
  ["Claire", "克莱尔"],
  ["Ada Wong", "艾达·王"],
  ["Ada", "艾达"],
  ["Ashley", "阿什莉"],
  ["Ashley Graham", "阿什莉·格拉汉姆"],
  ["Luis Serra", "路易斯·塞拉"],
  ["Luis", "路易斯"],
  ["Claire Redfield", "克莱尔·雷德菲尔德"],
  ["Chris", "克里斯"],
  ["Chris Redfield", "克里斯·雷德菲尔德"],
  ["Jill", "吉尔"],
  ["Jill Valentine", "吉尔·瓦伦丁"],
  ["Wesker", "威斯克"],
  ["Albert Wesker", "阿尔伯特·威斯克"],
  ["Sherry", "雪莉"],
  ["Sherry Birkin", "雪莉·柏金"],
  ["William Birkin", "威廉·柏金"],
  ["Annette Birkin", "安妮特·柏金"],
  ["Carlos Oliveira", "卡洛斯·奥利维拉"],
  ["Barry Burton", "巴瑞·伯顿"],
  ["HUNK", "汉克"],
  ["Luis Serra Navarro", "路易斯·塞拉·纳瓦罗"],
  ["Ingrid Hunnigan", "英格丽·哈尼根"],
  ["President Graham", "格拉汉姆总统"],
  ["Raccoon City", "浣熊市"],
  ["Umbrella", "安布雷拉"],
  ["Umbrella Corporation", "安布雷拉公司"],
  ["Spencer Mansion", "斯宾塞洋馆"],
  ["RPD", "RPD, keep as-is"],
  ["Raccoon Police Department", "浣熊市警察局"],
  ["Arklay Mountains", "阿克雷山"],
  ["Arklay Laboratory", "阿克雷研究所"],
  ["Rockfort Island", "洛克福特岛"],
  ["Kijuju", "基祖祖"],
  ["Tall Oaks", "高橡市"],
  ["Las Plagas", "拉斯普拉加斯"],
  ["BSAA", "BSAA, keep as-is"],
  ["S.T.A.R.S.", "S.T.A.R.S., keep as-is"],
  ["D.S.O.", "D.S.O., keep as-is"],
  ["Blue Umbrella", "蓝色安布雷拉"],
  ["T-virus", "T病毒"],
  ["G-virus", "G病毒"],
  ["C-virus", "C病毒"],
  ["Plaga", "普拉卡"],
  ["B.O.W.", "B.O.W., keep as-is"],
  ["bio-organic weapon", "生化有机武器"],
  ["Ganado", "村民 / 加纳多, by context"],
  ["Majini", "马基尼"],
  ["Licker", "舔食者"],
  ["Tyrant", "暴君"],
  ["Nemesis", "追迹者"],
  ["Regenerator", "再生者"],
  ["rookie cop", "菜鸟警察 / 新人警察, by context"],
  ["government agent", "政府特工"],
  ["agent", "特工"],
  ["partner", "搭档"],
  ["mission", "任务"],
  ["safehouse", "安全屋"],
  ["knife", "匕首"],
  ["handgun", "手枪"],
  ["shotgun", "霰弹枪"],
  ["magnum", "马格南"],
  ["sweetheart", "亲爱的 / 甜心, by voice"],
  ["honey", "亲爱的 / 宝贝, by voice"],
  ["baby", "宝贝, by voice"],
  ["good boy", "乖孩子 / 好孩子, by tone"]
  ,
  ["Explicit", "Explicit"],
  ["Mature", "Mature"],
  ["Teen And Up Audiences", "Teen And Up Audiences"],
  ["General Audiences", "General Audiences"],
  ["Not Rated", "Not Rated"],
  ["M/M", "M/M"],
  ["F/M", "F/M"],
  ["F/F", "F/F"],
  ["Gen", "Gen"],
  ["Multi", "Multi"],
  ["No Archive Warnings Apply", "无AO3警告"],
  ["Creator Chose Not To Use Archive Warnings", "作者选择不使用AO3警告"],
  ["Graphic Depictions Of Violence", "详细暴力描写"],
  ["Major Character Death", "主要角色死亡"],
  ["Rape/Non-Con", "强奸/非自愿"],
  ["Underage", "未成年"],
  ["Complete Work", "已完结"],
  ["Work in Progress", "连载中"],
  ["English", "英语"],
  ["Words", "字数"],
  ["Chapters", "章节"],
  ["Comments", "评论"],
  ["Kudos", "赞"],
  ["Bookmarks", "书签"],
  ["Hits", "点击"]
  ,
  ["Additional Tags", "附加标签"],
  ["Archive Warnings", "AO3警告"],
  ["Category", "分类"],
  ["Fandom", "圈子"],
  ["Relationship", "关系"],
  ["Relationships", "关系"],
  ["Characters", "角色"],
  ["Freeform", "自由标签"],
  ["Rating", "分级"],
  ["Language", "语言"],
  ["Published", "发布"],
  ["Updated", "更新"],
  ["Status", "状态"],
  ["Series", "系列"],
  ["Summary", "简介"],
  ["Notes", "作者的话"],
  ["Chapter", "章节"],
  ["Chapter Text", "正文"],
  ["End Notes", "章末备注"],
  ["Inspired by", "灵感来源"],
  ["Part", "第"],
  ["Fluff", "甜饼"],
  ["Angst", "虐"],
  ["Hurt/Comfort", "伤痛/慰藉"],
  ["Comfort", "慰藉"],
  ["Hurt No Comfort", "只有伤痛没有慰藉"],
  ["Smut", "肉"],
  ["Porn", "肉"],
  ["Porn With Plot", "有剧情的肉"],
  ["Porn Without Plot", "无剧情纯肉"],
  ["Plot What Plot/Porn Without Plot", "无剧情纯肉"],
  ["PWP", "PWP, keep as-is"],
  ["Explicit Sexual Content", "露骨性内容"],
  ["Sexual Content", "性内容"],
  ["First Time", "第一次"],
  ["First Kiss", "初吻"],
  ["Kissing", "接吻"],
  ["Making Out", "热吻"],
  ["Blow Jobs", "口交"],
  ["Hand Jobs", "手交"],
  ["Oral Sex", "口交"],
  ["Anal Sex", "肛交"],
  ["Rimming", "舔肛"],
  ["Come Eating", "吞精"],
  ["Barebacking", "无套"],
  ["Rough Sex", "粗暴性爱"],
  ["Soft Sex", "温柔性爱"],
  ["Dom/sub", "支配/臣服"],
  ["BDSM", "BDSM, keep as-is"],
  ["Bondage", "束缚"],
  ["Aftercare", "事后安抚"],
  ["Dirty Talk", "下流话"],
  ["Praise Kink", "夸奖癖"],
  ["Size Kink", "体型差癖"],
  ["Possessive Behavior", "占有欲"],
  ["Jealousy", "嫉妒"],
  ["Mutual Pining", "双向暗恋"],
  ["Pining", "暗恋"],
  ["Slow Burn", "慢热"],
  ["Friends to Lovers", "朋友变恋人"],
  ["Enemies to Lovers", "敌人变恋人"],
  ["Rivals to Lovers", "对手变恋人"],
  ["Established Relationship", "已确立关系"],
  ["Getting Together", "在一起"],
  ["Confessions", "告白"],
  ["Love Confessions", "告白"],
  ["Developing Relationship", "关系发展"],
  ["Misunderstandings", "误会"],
  ["Unresolved Sexual Tension", "未解决的性张力"],
  ["UST", "UST, keep as-is"],
  ["Emotional Hurt/Comfort", "情感伤痛/慰藉"],
  ["Protective", "保护欲"],
  ["Protective Leon S. Kennedy", "保护欲强的里昂·S·肯尼迪"],
  ["Protective Rebecca Chambers", "保护欲强的瑞贝卡·钱伯斯"],
  ["Bottom Leon S. Kennedy", "Bottom里昂·S·肯尼迪"],
  ["Top Leon S. Kennedy", "Top里昂·S·肯尼迪"],
  ["Bottom Rebecca Chambers", "Bottom瑞贝卡·钱伯斯"],
  ["Top Rebecca Chambers", "Top瑞贝卡·钱伯斯"],
  ["Alternate Universe", "AU"],
  ["Alternate Universe - Canon Divergence", "AU-原作分歧"],
  ["Canon Divergence", "原作分歧"],
  ["Canon Compliant", "遵循原作"],
  ["Post-Canon", "原作后"],
  ["Pre-Canon", "原作前"],
  ["Missing Scene", "缺失场景"],
  ["Fix-It", "修正原作"],
  ["Modern AU", "现代AU"],
  ["College AU", "大学AU"],
  ["No Beta We Die Like Men", "无beta校对"],
  ["No beta we die like men", "无beta校对"],
  ["Not Beta Read", "未经beta校对"],
  ["Beta Read", "已beta校对"],
  ["One Shot", "一发完"],
  ["Drabble", "短打"],
  ["POV", "视角"],
  ["POV Leon S. Kennedy", "里昂·S·肯尼迪视角"],
  ["POV Rebecca Chambers", "瑞贝卡·钱伯斯视角"],
  ["Happy Ending", "HE"],
  ["Bad Ending", "BE"],
  ["Open Ending", "开放式结局"],
  ["Dead Dove: Do Not Eat", "Dead Dove: Do Not Eat, keep as-is"],
  ["Dubious Consent", "模糊同意"],
  ["Dubcon", "Dubcon, keep as-is"],
  ["Non-Consensual", "非自愿"],
  ["Consent Issues", "同意问题"],
  ["Blood and Injury", "血与伤"],
  ["Blood", "血"],
  ["Injury", "受伤"],
  ["Violence", "暴力"],
  ["Graphic Violence", "详细暴力"],
  ["Trauma", "创伤"],
  ["PTSD", "PTSD, keep as-is"],
  ["Nightmares", "噩梦"],
  ["Panic Attacks", "惊恐发作"],
  ["Alcohol", "酒精"],
  ["Drinking", "饮酒"],
  ["Humor", "幽默"],
  ["Crack", "沙雕"],
  ["Crack Treated Seriously", "沙雕设定正经写"],
  ["Domestic Fluff", "居家甜饼"],
  ["Bed Sharing", "同床"],
  ["Sharing a Bed", "同床"],
  ["Cuddling", "拥抱贴贴"],
  ["Touch-Starved", "肌肤饥渴"],
  ["Protective Behavior", "保护行为"],
  ["Emotional Sex", "情感性爱"],
  ["Plot", "剧情"]
  ,
  ["Alpha/Beta/Omega Dynamics", "ABO设定"],
  ["Omegaverse", "Omegaverse, keep as-is"],
  ["Alpha", "Alpha, keep as-is"],
  ["Beta", "Beta, keep as-is"],
  ["Omega", "Omega, keep as-is"],
  ["Heat", "发情期"],
  ["Rut", "易感期"],
  ["Mpreg", "男男生子"],
  ["Pregnancy", "怀孕"],
  ["Kid Fic", "带娃"],
  ["Found Family", "找到的家人"],
  ["Soulmates", "灵魂伴侣"],
  ["Soulmate AU", "灵魂伴侣AU"],
  ["Time Travel", "时间旅行"],
  ["Time Loop", "时间循环"],
  ["Fix-It of Sorts", "某种意义上的修正原作"],
  ["Reader", "读者"],
  ["Reader-Insert", "读者插入"],
  ["You", "你"],
  ["Original Character(s)", "原创角色"],
  ["Original Character", "原创角色"],
  ["OC", "OC, keep as-is"],
  ["Self-Insert", "自我代入"],
  ["Age Difference", "年龄差"],
  ["Age Gap", "年龄差"],
  ["Character Death", "角色死亡"],
  ["Temporary Character Death", "临时角色死亡"],
  ["Past Character Death", "过去角色死亡"],
  ["Major Injuries", "重伤"],
  ["Minor Injuries", "轻伤"],
  ["Medical Procedures", "医疗处理"],
  ["Hospital", "医院"],
  ["Recovery", "恢复期"],
  ["Slow Build", "慢慢发展"],
  ["Tension", "张力"],
  ["Sexual Tension", "性张力"],
  ["Emotional Constipation", "情感便秘"],
  ["Feelings Realization", "意识到感情"],
  ["Idiots in Love", "恋爱笨蛋"],
  ["They Are Idiots", "他们是笨蛋"],
  ["Secret Relationship", "秘密恋情"],
  ["Fake/Pretend Relationship", "假装情侣"],
  ["Fake Relationship", "假装情侣"],
  ["Mutual Masturbation", "互相自慰"],
  ["Masturbation", "自慰"],
  ["Fingerfucking", "手指插入"],
  ["Fingering", "手指插入"],
  ["Praise", "夸奖"],
  ["Degradation", "羞辱"],
  ["Light Bondage", "轻度束缚"],
  ["Knifeplay", "刀具play"],
  ["Bloodplay", "血play"],
  ["Comeplay", "精液play"],
  ["Overstimulation", "过度刺激"],
  ["Orgasm Delay/Denial", "高潮延迟/禁止"],
  ["Aftermath", "事后"],
  ["Morning After", "第二天早上"],
  ["Angst with a Happy Ending", "有HE的虐"],
  ["Bittersweet Ending", "苦甜结局"]
];

const presets = [
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
  ["Luis Serra Navarro", "路易斯·塞拉·纳瓦罗"],
  ["Jill", "吉尔"],
  ["Jill Valentine", "吉尔·瓦伦丁"],
  ["Wesker", "威斯克"],
  ["Albert Wesker", "阿尔伯特·威斯克"],
  ["Sherry", "雪莉"],
  ["Sherry Birkin", "雪莉·柏金"],
  ["William Birkin", "威廉·柏金"],
  ["Annette Birkin", "安妮特·柏金"],
  ["Carlos Oliveira", "卡洛斯·奥利维拉"],
  ["Barry Burton", "巴瑞·伯顿"],
  ["HUNK", "汉克"],
  ["Ingrid Hunnigan", "英格丽·哈尼根"],
  ["President Graham", "格拉汉姆总统"],
  ["Raccoon City", "浣熊市"],
  ["Umbrella", "安布雷拉"],
  ["Umbrella Corporation", "安布雷拉公司"],
  ["Blue Umbrella", "蓝色安布雷拉"],
  ["RPD", "RPD, keep as-is"],
  ["Raccoon Police Department", "浣熊市警察局"],
  ["Arklay Mountains", "阿克雷山区"],
  ["Arklay Laboratory", "阿克雷研究所"],
  ["Spencer Mansion", "斯宾塞洋馆"],
  ["Rockfort Island", "洛克福特岛"],
  ["Kijuju", "基祖祖"],
  ["Tall Oaks", "高橡市"],
  ["Las Plagas", "拉斯普拉卡斯"],
  ["Plaga", "普拉卡"],
  ["Ganado", "村民 / 加纳多, by context"],
  ["Majini", "马基尼"],
  ["Licker", "舔食者"],
  ["Tyrant", "暴君"],
  ["Nemesis", "追踪者"],
  ["Regenerator", "再生者"],
  ["B.O.W.", "B.O.W., keep as-is"],
  ["bio-organic weapon", "生化有机武器"],
  ["T-virus", "T病毒"],
  ["G-virus", "G病毒"],
  ["C-virus", "C病毒"],
  ["BSAA", "BSAA, keep as-is"],
  ["S.T.A.R.S.", "S.T.A.R.S., keep as-is"],
  ["D.S.O.", "D.S.O., keep as-is"],
  ["rookie cop", "菜鸟警察 / 新人警察, by context"],
  ["government agent", "政府特工"],
  ["agent", "特工"],
  ["partner", "搭档"],
  ["mission", "任务"],
  ["safehouse", "安全屋"],
  ["knife", "匕首"],
  ["handgun", "手枪"],
  ["shotgun", "霰弹枪"],
  ["magnum", "马格南"],
  ["sweetheart", "亲爱的 / 甜心, by voice"],
  ["honey", "亲爱的 / 宝贝, by voice"],
  ["baby", "宝贝, by voice"],
  ["good boy", "乖孩子 / 好孩子, by tone"],
  ["Explicit", "Explicit"],
  ["Mature", "Mature"],
  ["Teen And Up Audiences", "Teen And Up Audiences"],
  ["General Audiences", "General Audiences"],
  ["Not Rated", "Not Rated"],
  ["M/M", "M/M"],
  ["F/M", "F/M"],
  ["F/F", "F/F"],
  ["Gen", "Gen"],
  ["Multi", "Multi"],
  ["Other", "Other"],
  ["No Archive Warnings Apply", "无AO3警告"],
  ["Creator Chose Not To Use Archive Warnings", "作者选择不使用AO3警告"],
  ["Graphic Depictions Of Violence", "详细暴力描写"],
  ["Major Character Death", "主要角色死亡"],
  ["Rape/Non-Con", "强奸/非自愿"],
  ["Underage", "未成年"],
  ["Complete Work", "已完结"],
  ["Work in Progress", "连载中"],
  ["English", "英语"],
  ["Words", "字数"],
  ["Chapters", "章节"],
  ["Comments", "评论"],
  ["Kudos", "赞"],
  ["Bookmarks", "书签"],
  ["Hits", "点击"],
  ["Additional Tags", "附加标签"],
  ["Archive Warnings", "AO3警告"],
  ["Category", "分类"],
  ["Fandom", "圈子"],
  ["Relationship", "关系"],
  ["Relationships", "关系"],
  ["Characters", "角色"],
  ["Freeform", "自由标签"],
  ["Rating", "分级"],
  ["Language", "语言"],
  ["Published", "发布"],
  ["Updated", "更新"],
  ["Status", "状态"],
  ["Series", "系列"],
  ["Summary", "简介"],
  ["Notes", "作者的话"],
  ["Chapter", "章节"],
  ["Chapter Text", "正文"],
  ["End Notes", "章末备注"],
  ["Inspired by", "灵感来源"],
  ["Part", "第"],
  ["Fluff", "甜饼"],
  ["Angst", "虐"],
  ["Hurt/Comfort", "伤痛/慰藉"],
  ["Comfort", "慰藉"],
  ["Hurt No Comfort", "只有伤痛没有慰藉"],
  ["Smut", "肉"],
  ["Porn", "肉"],
  ["Porn With Plot", "有剧情的肉"],
  ["Porn Without Plot", "无剧情纯肉"],
  ["Plot What Plot/Porn Without Plot", "无剧情纯肉"],
  ["PWP", "PWP, keep as-is"],
  ["Explicit Sexual Content", "露骨性内容"],
  ["Sexual Content", "性内容"],
  ["First Time", "第一次"],
  ["First Kiss", "初吻"],
  ["Kissing", "接吻"],
  ["Making Out", "热吻"],
  ["Blow Jobs", "口交"],
  ["Hand Jobs", "手交"],
  ["Oral Sex", "口交"],
  ["Anal Sex", "肛交"],
  ["Rimming", "舔肛"],
  ["Come Eating", "吞精"],
  ["Barebacking", "无套"],
  ["Rough Sex", "粗暴性爱"],
  ["Soft Sex", "温柔性爱"],
  ["Dom/sub", "支配/臣服"],
  ["BDSM", "BDSM, keep as-is"],
  ["Bondage", "束缚"],
  ["Aftercare", "事后安抚"],
  ["Dirty Talk", "下流话"],
  ["Praise Kink", "夸奖癖"],
  ["Size Kink", "体型差癖"],
  ["Possessive Behavior", "占有欲"],
  ["Jealousy", "嫉妒"],
  ["Mutual Pining", "双向暗恋"],
  ["Pining", "暗恋"],
  ["Slow Burn", "慢热"],
  ["Friends to Lovers", "朋友变恋人"],
  ["Enemies to Lovers", "敌人变恋人"],
  ["Rivals to Lovers", "对手变恋人"],
  ["Established Relationship", "已确立关系"],
  ["Getting Together", "在一起"],
  ["Confessions", "告白"],
  ["Love Confessions", "告白"],
  ["Developing Relationship", "关系发展"],
  ["Misunderstandings", "误会"],
  ["Unresolved Sexual Tension", "未解决的性张力"],
  ["UST", "UST, keep as-is"],
  ["Emotional Hurt/Comfort", "情感伤痛/慰藉"],
  ["Protective", "保护欲"],
  ["Protective Leon S. Kennedy", "保护欲强的里昂·S·肯尼迪"],
  ["Protective Rebecca Chambers", "保护欲强的瑞贝卡·钱伯斯"],
  ["Bottom Leon S. Kennedy", "Bottom 里昂·S·肯尼迪"],
  ["Top Leon S. Kennedy", "Top 里昂·S·肯尼迪"],
  ["Bottom Rebecca Chambers", "Bottom 瑞贝卡·钱伯斯"],
  ["Top Rebecca Chambers", "Top 瑞贝卡·钱伯斯"],
  ["Alternate Universe", "AU"],
  ["Alternate Universe - Canon Divergence", "AU-原作分歧"],
  ["Canon Divergence", "原作分歧"],
  ["Canon Compliant", "遵循原作"],
  ["Post-Canon", "原作之后"],
  ["Pre-Canon", "原作之前"],
  ["Missing Scene", "缺失场景"],
  ["Fix-It", "修正原作"],
  ["Modern AU", "现代AU"],
  ["College AU", "大学AU"],
  ["No Beta We Die Like Men", "无beta校对"],
  ["No beta we die like men", "无beta校对"],
  ["Not Beta Read", "未经beta校对"],
  ["Beta Read", "已beta校对"],
  ["One Shot", "一发完"],
  ["Drabble", "短打"],
  ["POV", "视角"],
  ["POV Leon S. Kennedy", "里昂·S·肯尼迪视角"],
  ["POV Rebecca Chambers", "瑞贝卡·钱伯斯视角"],
  ["Happy Ending", "HE"],
  ["Bad Ending", "BE"],
  ["Open Ending", "开放式结局"],
  ["Dead Dove: Do Not Eat", "Dead Dove: Do Not Eat, keep as-is"],
  ["Dubious Consent", "模糊同意"],
  ["Dubcon", "Dubcon, keep as-is"],
  ["Non-Consensual", "非自愿"],
  ["Consent Issues", "同意问题"],
  ["Blood and Injury", "血与伤"],
  ["Blood", "血"],
  ["Injury", "受伤"],
  ["Violence", "暴力"],
  ["Graphic Violence", "详细暴力"],
  ["Trauma", "创伤"],
  ["PTSD", "PTSD, keep as-is"],
  ["Nightmares", "噩梦"],
  ["Panic Attacks", "惊恐发作"],
  ["Alcohol", "酒精"],
  ["Drinking", "饮酒"],
  ["Humor", "幽默"],
  ["Crack", "沙雕"],
  ["Crack Treated Seriously", "沙雕设定正经写"],
  ["Domestic Fluff", "居家甜饼"],
  ["Bed Sharing", "同床"],
  ["Sharing a Bed", "同床"],
  ["Cuddling", "拥抱贴贴"],
  ["Touch-Starved", "肌肤饥渴"],
  ["Protective Behavior", "保护行为"],
  ["Emotional Sex", "情感性爱"],
  ["Plot", "剧情"],
  ["Alpha/Beta/Omega Dynamics", "ABO设定"],
  ["Omegaverse", "Omegaverse, keep as-is"],
  ["Alpha", "Alpha, keep as-is"],
  ["Beta", "Beta, keep as-is"],
  ["Omega", "Omega, keep as-is"],
  ["Heat", "发情期"],
  ["Rut", "易感期"],
  ["Mpreg", "男男生子"],
  ["Pregnancy", "怀孕"],
  ["Kid Fic", "带娃"],
  ["Found Family", "找到的家人"],
  ["Soulmates", "灵魂伴侣"],
  ["Soulmate AU", "灵魂伴侣AU"],
  ["Time Travel", "时间旅行"],
  ["Time Loop", "时间循环"],
  ["Fix-It of Sorts", "某种意义上的修正原作"],
  ["Reader", "读者"],
  ["Reader-Insert", "读者插入"],
  ["You", "你"],
  ["Original Character(s)", "原创角色"],
  ["Original Character", "原创角色"],
  ["OC", "OC, keep as-is"],
  ["Self-Insert", "自我代入"],
  ["Age Difference", "年龄差"],
  ["Age Gap", "年龄差"],
  ["Character Death", "角色死亡"],
  ["Temporary Character Death", "临时角色死亡"],
  ["Past Character Death", "过去角色死亡"],
  ["Major Injuries", "重伤"],
  ["Minor Injuries", "轻伤"],
  ["Medical Procedures", "医疗处理"],
  ["Hospital", "医院"],
  ["Recovery", "恢复期"],
  ["Slow Build", "慢慢发展"],
  ["Tension", "张力"],
  ["Sexual Tension", "性张力"],
  ["Emotional Constipation", "情感便秘"],
  ["Feelings Realization", "意识到感情"],
  ["Idiots in Love", "恋爱笨蛋"]
];

function setStatus(text, isError = false) {
  els.statusText.textContent = text;
  els.statusText.classList.toggle("error", isError);
  const work = activeWork();
  if (work) {
    work.status = text;
    work.statusIsError = isError;
  }
}

function setProgress(done, total) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  els.progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  const work = activeWork();
  if (work) {
    work.progressDone = done;
    work.progressTotal = total;
  }
  scheduleWorkListRender();
}

function setBusy(value) {
  document.body.classList.toggle("busy", Boolean(value));
}

function handleRuntimeFault(error) {
  console.error("AO3 translator runtime fault", error);
  scheduleSessionSave(50);
  if (els.statusText) {
    setStatus("The page hit a small crash, but your work is being saved locally. Refresh once to restore.", true);
  }
}

window.addEventListener("error", (event) => {
  handleRuntimeFault(event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  handleRuntimeFault(event.reason || "Unhandled promise rejection.");
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    saveActiveSelection();
    void saveSessionNow();
  }
});

window.addEventListener("beforeunload", () => {
  saveActiveSelection();
  void saveSessionNow();
});

function updateAiSettings() {
  const provider = els.providerSelect.value;
  const defaults = providerDefaults[provider] || providerDefaults.deepseek;
  if (defaults.endpoint && (!els.endpointInput.value.trim() || els.endpointInput.dataset.provider !== provider)) {
    els.endpointInput.value = defaults.endpoint;
  }
  if (defaults.model && (!els.modelInput.value.trim() || els.modelInput.dataset.provider !== provider)) {
    els.modelInput.value = defaults.model;
  }
  els.endpointInput.dataset.provider = provider;
  els.modelInput.dataset.provider = provider;
  const hasTypedKey = Boolean(els.apiKeyInput.value.trim());
  if (provider === "google") {
    els.aiSettings.hidden = true;
    els.keyStatus.textContent = "";
    if (els.googleContextRow) els.googleContextRow.hidden = false;
  } else if (provider === "doubao") {
    if (els.googleContextRow) els.googleContextRow.hidden = true;
    els.aiSettings.hidden = hasServerDoubaoKey || hasTypedKey;
    els.keyStatus.textContent = hasServerDoubaoKey ? "Local Doubao key connected." : "Paste Doubao API Key here.";
  } else if (provider === "deepseek") {
    if (els.googleContextRow) els.googleContextRow.hidden = true;
    els.aiSettings.hidden = hasServerDeepSeekKey || hasTypedKey;
    els.keyStatus.textContent = hasServerDeepSeekKey ? "Local DeepSeek key connected." : "Paste DeepSeek API Key here.";
  }
}

function revealKeySettings(provider = "deepseek") {
  els.providerSelect.value = provider;
  updateAiSettings();
  els.aiSettings.hidden = false;
  els.apiKeyInput.focus();
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function textOnly(html = "") {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent.replace(/\s+/g, " ").trim();
}

function defaultGlossaryText() {
  return presets.map(([source, target]) => `${source}: ${target}`).join("\n");
}

function looksMojibake(value = "") {
  const text = String(value);
  return /�|锟|閲屾槀|鐟炶礉|鑹捐揪|闃夸粈|濞佹柉|浣滆|绔犺|娴ｇ唺|璀﹀憡/.test(text);
}

function textWithBreaks(html = "") {
  const div = document.createElement("div");
  div.innerHTML = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<\/div\s*>/gi, "\n");
  return div.textContent.replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
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

function splitLongHtmlPart(html) {
  const text = textOnly(html);
  if (text.length <= 1800 || /<[^>]+>/.test(html)) return [html];
  const sentences = html.match(/[^.!?。！？]+[.!?。！？]["'”’)]?\s*|[^.!?。！？]+$/g) || [html];
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
  ["Leon", "\u91cc\u6602"],
  ["Leon S. Kennedy", "\u91cc\u6602\u00b7S\u00b7\u80af\u5c3c\u8fea"],
  ["Leon Kennedy", "\u91cc\u6602\u00b7\u80af\u5c3c\u8fea"],
  ["Rebecca", "\u745e\u8d1d\u5361"],
  ["Rebecca Chambers", "\u745e\u8d1d\u5361\u00b7\u94b1\u4f2f\u65af"],
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
  const first = raw.split(/[?,;?]|\s+\/\s+/)[0].trim();
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
  return target ? "<" + (segment.tag || "span") + ">" + escapeHtml(target) + "</" + (segment.tag || "span") + ">" : "";
}

function localShortTextTranslation(segment) {
  if (segment.kind !== "body") return "";
  const normalized = String(segment.originalText || "").replace(/\s+/g, " ").trim();
  if (isReaderNamePlaceholder(normalized)) {
    const name = readerName();
    return name ? "<" + (segment.tag || "p") + ">" + escapeHtml(name) + "</" + (segment.tag || "p") + ">" : "";
  }
  const compact = normalized
    .toLowerCase()
    .replace(/\[\s*/g, "[ ")
    .replace(/\s*\]/g, " ]")
    .replace(/\s+/g, " ")
    .trim();
  const tight = compact.replace(/\s+/g, "");
  const map = new Map([
    ["yes", "\u662f"],
    ["no", "\u5426"],
    ["[ yes ] [ no ]", "[\u662f] [\u5426]"],
    ["[yes][no]", "[\u662f] [\u5426]"],
    ["do you want to restart?", "\u662f\u5426\u91cd\u65b0\u5f00\u59cb\uff1f"],
    ["doyouwanttorestart?", "\u662f\u5426\u91cd\u65b0\u5f00\u59cb\uff1f"],
    ["critical error", "\u4e25\u91cd\u9519\u8bef"],
    ["criticalerror", "\u4e25\u91cd\u9519\u8bef"],
    ["restart", "\u91cd\u65b0\u5f00\u59cb"],
    ["continue", "\u7ee7\u7eed"],
    ["game over", "\u6e38\u620f\u7ed3\u675f"],
    ["gameover", "\u6e38\u620f\u7ed3\u675f"],
    ["start", "\u5f00\u59cb"],
    ["stop", "\u505c\u6b62"],
    ["error", "\u9519\u8bef"],
    ["warning", "\u8b66\u544a"]
  ]);
  const target = map.get(compact) || map.get(tight);
  return target ? "<" + (segment.tag || "p") + ">" + escapeHtml(target) + "</" + (segment.tag || "p") + ">" : "";
}

function readerName() {
  return (els.readerNameInput?.value || "").replace(/\s+/g, " ").trim();
}

function isReaderNamePlaceholder(value = "") {
  return /^[\[(\s{]*y\s*[\/\\]\s*n[\])\s}]*$/i.test(String(value || "").trim());
}

function applyReaderNameToText(value = "") {
  const name = readerName();
  if (!name) return String(value || "");
  return String(value || "").replace(/[\[({]?\s*y\s*[\/\\]\s*n\s*[\])}]?/gi, name);
}

function applyReaderNameToHtml(html = "") {
  const name = readerName();
  if (!name || !html) return html || "";
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    node.nodeValue = applyReaderNameToText(node.nodeValue);
  });
  return doc.body.innerHTML;
}

function saveReaderName() {
  const name = readerName();
  if (name) localStorage.setItem(READER_NAME_STORAGE_KEY, name);
  else localStorage.removeItem(READER_NAME_STORAGE_KEY);
}

function loadReaderName() {
  if (!els.readerNameInput) return;
  els.readerNameInput.value = localStorage.getItem(READER_NAME_STORAGE_KEY) || "";
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
    output = output.replace(new RegExp(source, "g"), target);
  }
  return output;
}

function trustedNameGlossaryTerms() {
  const required = new Map(requiredGlossaryTerms.map(([source, target]) => [source.toLowerCase(), { source, target }]));
  const properNamePattern = /^[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*$/;
  for (const item of parseGlossary()) {
    const target = cleanGlossaryTarget(item.target);
    if (!item.source || !target) continue;
    if (required.has(item.source.toLowerCase()) || properNamePattern.test(item.source)) {
      required.set(item.source.toLowerCase(), { source: item.source, target });
    }
  }
  return [...required.values()].sort((a, b) => b.source.length - a.source.length);
}

function applyTrustedNameGlossary(html = "") {
  let output = String(html || "");
  for (const item of trustedNameGlossaryTerms()) {
    const source = item.source.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(`\\b${source}\\b`, "g"), item.target);
  }
  return normalizeReadableTerms(output);
}

function cleanNameArtifacts(html = "") {
  return normalizeReadableTerms(html);
}

function normalizeReadableTerms(html = "") {
  return String(html)
    .replace(/\u83b1\u6602/g, "\u91cc\u6602")
    .replace(/\u5229\u6602/g, "\u91cc\u6602")
    .replace(/\u674e\u6602/g, "\u91cc\u6602")
    .replace(/Leon/g, "\u91cc\u6602")
    .replace(/Rebecca/g, "\u745e\u8d1d\u5361")
    .replace(/\u4e3d\u8d1d\u5361/g, "\u745e\u8d1d\u5361")
    .replace(/\u745e\u4e3d\u8d1d\u5361/g, "\u745e\u8d1d\u5361")
    .replace(/Wesker/g, "\u5a01\u65af\u514b")
    .replace(/Ada/g, "\u827e\u8fbe")
    .replace(/Claire/g, "\u514b\u83b1\u5c14")
    .replace(/Chris/g, "\u514b\u91cc\u65af")
    .replace(/\u91cc\u6602\s*\u91cc\u6602+/g, "\u91cc\u6602")
    .replace(/\u745e\u8d1d\u5361\s*\u745e\u8d1d\u5361+/g, "\u745e\u8d1d\u5361")
    .replace(/\u5a01\u65af\u514b\s*\u5a01\u65af\u514b+/g, "\u5a01\u65af\u514b")
    .replace(/\u827e\u8fbe\s*\u827e\u8fbe+/g, "\u827e\u8fbe")
    .replace(/\u514b\u83b1\u5c14\s*\u514b\u83b1\u5c14+/g, "\u514b\u83b1\u5c14")
    .replace(/\u514b\u91cc\u65af\s*\u514b\u91cc\u65af+/g, "\u514b\u91cc\u65af")
    .replace(/\u4f60\s*(\u91cc\u6602|\u83b1\u6602|\u745e\u8d1d\u5361)(?=[\uff0c\u3002\uff01\uff1f\u3001\s<])/g, "\u4f60")
    .replace(/(\u4ed6|\u5979)\s*(\u91cc\u6602|\u83b1\u6602|\u745e\u8d1d\u5361|\u5a01\u65af\u514b|\u827e\u8fbe|\u514b\u83b1\u5c14|\u514b\u91cc\u65af)(?=[\uff0c\u3002\uff01\uff1f\u3001\s<])/g, "$1")
    .replace(/\u4e27\u5c38\s*\u4e27\u5c38+/g, "\u4e27\u5c38");
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
  const current = applyReaderNameToHtml(applyTrustedNameGlossary(html || ""));
  const currentText = textOnly(current);
  const local = localMetaTranslation(segment) || localShortTextTranslation(segment);
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

  state.metadata = { title, author };
  els.exportTitleInput.value = neatTitle(title);
  const keyCounters = new Map();
  state.segments = nodes.map((node, index) => ({
    id: `seg-${index + 1}`,
    index,
    key: segmentKeyForNode(node, keyCounters),
    tag: node.tagName.toLowerCase(),
    kind: segmentKind(node),
    scope: segmentScope(node),
    originalHtml: node.outerHTML,
    originalText: normalizedSegmentText(node),
    decorative: isDecorativeText(normalizedSegmentText(node)),
    translationHtml: "",
    failedReason: ""
  }));

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
      <button type="button" class="work-open" data-work-index="${index}" title="打开这篇">
        <span>${escapeHtml(title)}</span>
        <small>${done}/${total} · ${percent}%</small>
        <i><b style="width:${percent}%"></b></i>
      </button>
      <button type="button" class="work-delete" data-delete-work="${index}" title="从列表删除这篇">删除</button>
    </div>`;
  }).join("");
}

function updateReady() {
  const ready = state.segments.length > 0;
  const done = countTranslated();
  els.startButton.disabled = !ready;
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
    els.togglePreviewButton.textContent = state.previewAll ? "\u6536\u8d77\u9884\u89c8" : "\u663e\u793a\u5168\u6587\u9884\u89c8";
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
  const visibleCount = state.previewAll
    ? Math.min(state.previewVisibleCount || PREVIEW_LIMIT, sourceSegments.length)
    : Math.min(PREVIEW_LIMIT, sourceSegments.length);
  const visible = sourceSegments.slice(0, visibleCount);
  const hasMorePreview = state.previewAll && visibleCount < sourceSegments.length;
  const notice = state.segments.length > PREVIEW_LIMIT
    ? '<p class="preview-note">' + (state.previewMissingOnly ? '\u6b63\u5728\u53ea\u663e\u793a\u672a\u7ffb\u8bd1 / \u5931\u8d25\u6bb5\u843d\uff1a' + missingSegments.length + ' \u6bb5\u3002' : (state.previewAll ? '\u5df2\u663e\u793a ' + visibleCount + ' / ' + state.segments.length + ' \u6bb5\uff0c\u53ef\u7ee7\u7eed\u5c55\u5f00\u3002' : '\u5f53\u524d\u53ea\u663e\u793a\u524d ' + PREVIEW_LIMIT + ' \u6bb5\u3002')) + '\u7ffb\u8bd1\u548c\u5bfc\u51fa\u90fd\u4f1a\u5904\u7406\u5168\u6587\u3002</p>'
    : '';
  const missingButton = missingSegments.length
    ? '<button type="button" class="preview-more" data-preview-missing>' + (state.previewMissingOnly ? '\u8fd4\u56de\u666e\u901a\u9884\u89c8' : '\u53ea\u770b ' + missingSegments.length + ' \u6bb5\u672a\u7ffb\u8bd1 / \u5931\u8d25') + '</button>'
    : '';
  const moreButton = hasMorePreview
    ? '<button type="button" class="preview-more" data-preview-more>\u7ee7\u7eed\u663e\u793a\u66f4\u591a\u6bb5\u843d</button>'
    : '';
  els.preview.innerHTML = notice + missingButton + visible.map((segment) => {
    const failed = segment.failedReason ? ' failed' : '';
    const zh = isDecorativeSegment(segment)
      ? ""
      : (segment.translationHtml || '<' + segment.tag + '><span class="empty">' + (segment.failedReason ? '\u672a\u7ffb\u8bd1\uff0c\u70b9 Start translate \u4f1a\u53ea\u8865\u8fd9\u6bb5\u3002' : 'Not translated yet.') + '</span></' + segment.tag + '>');
    const selector = segment.kind === "body"
      ? '<label class="segment-tools" title="\u9009\u4e2d\u540e\u53ef\u91cd\u65b0\u7ffb\u8bd1"><input type="checkbox" class="segment-select" aria-label="\u9009\u4e2d\u8fd9\u6bb5\u91cd\u65b0\u7ffb\u8bd1" ' + (selectedSegmentIds.has(segment.id) ? 'checked' : '') + '><span></span></label>'
      : '';
    return '<div class="pair ' + (selectedSegmentIds.has(segment.id) ? 'selected ' : '') + failed + '" data-id="' + segment.id + '">' +
      selector +
      '<div class="en">' + applyReaderNameToHtml(segment.originalHtml) + '</div>' +
      '<div class="zh" contenteditable="true" spellcheck="false">' + applyReaderNameToHtml(zh) + '</div>' +
      '</div>';
  }).join("") + moreButton;
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
  for (let i = index + 1; i < state.segments.length && after.length < 1; i += 1) {
    if (state.segments[i].kind === "body") after.push(state.segments[i].originalText);
  }
  return {
    before: before.join("\n").slice(-600),
    after: after.join("\n").slice(0, 300)
  };
}

async function translateAll() {
  const provider = els.providerSelect.value;
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
    schedulePreviewRender(true);
    setStatus("No missing paragraphs. Preview and export are ready.");
    return;
  }

  const googleContext = provider === "google" && (!els.googleContextMode || els.googleContextMode.checked);
  const limits = provider === "google"
    ? (googleContext
      ? { maxItems: GOOGLE_CONTEXT_MAX_ITEMS, maxChars: GOOGLE_CONTEXT_MAX_CHARS }
      : { maxItems: GOOGLE_NORMAL_MAX_ITEMS, maxChars: GOOGLE_NORMAL_MAX_CHARS })
    : (AI_CHUNK_LIMITS[provider] || AI_CHUNK_LIMITS.deepseek);
  const chunks = chunkSegmentsByLoad(targetSegments, limits.maxItems, limits.maxChars);

  els.startButton.disabled = true;
  setBusy(true);
  let completed = state.segments.filter(isTranslatedSegment).length;
  let failedCount = 0;
  setProgress(completed, state.segments.length);

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
    setProgress(completed, state.segments.length);
    syncActiveWork();
    updateReady();
    schedulePreviewRender();
  };

  try {
    if (provider === "google") {
      let nextIndex = 0;
      let googleHadSplitError = false;
      const translateChunk = async (index) => {
        const chunk = chunks[index];
        setStatus("Google translate " + completed + "/" + state.segments.length + " ? batch " + (index + 1) + "/" + chunks.length);
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
        while (nextIndex < chunks.length && !googleHadSplitError) {
          const index = nextIndex;
          nextIndex += 1;
          await translateChunk(index);
        }
      }
      await Promise.all(Array.from({ length: Math.min(GOOGLE_FAST_CONCURRENCY, chunks.length) }, () => worker()));
      while (nextIndex < chunks.length) {
        const index = nextIndex;
        nextIndex += 1;
        await translateChunk(index);
      }
    } else {
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        setStatus("Translating batch " + (index + 1) + "/" + chunks.length + "...");
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
    els.startButton.disabled = false;
    setBusy(false);
    schedulePreviewRender(true);
  }

  const missing = state.segments.filter((segment) => !isTranslatedSegment(segment)).length;
  state.previewMissingOnly = Boolean(missing);
  if (missing) {
    state.previewAll = true;
    state.previewVisibleCount = PREVIEW_LIMIT;
  } else {
    state.previewMissingOnly = false;
  }
  schedulePreviewRender(true);
  setStatus(missing
    ? "Done with " + missing + " failed / untranslated. Click Start translate to retry only missing paragraphs."
    : "Done. Preview and export are ready.");
}

async function postTranslate(payload) {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data.translations || [];
}

async function postTranslateWithRetry(payload) {
  const isGoogle = payload.provider === "google";
  const delays = isGoogle ? [0, 450, 1100, 2200] : [0];
  let lastError;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) {
      setStatus(`Google 暂时没接住，等一下再试 ${attempt + 1}/${delays.length}...`);
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
      setStatus(`这一小批润色失败，已跳过继续：${error.message || error}`, true);
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
  if (!selected.length) return setStatus("先在右侧勾选要重翻的段落。", true);
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
    const ideas = raw.split(/[；;\n|]/)
      .map((item) => item.replace(/^[0-9一二三四五]\s*[.、:：-]?\s*/, "").trim())
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
  if (!source || !target) return setStatus("原文和译文都要填一下。", true);
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
  setStatus(existingIndex >= 0 ? `已更新词条：${source}` : `已加入词条：${source}`);
}

function addPresets() {
  mergePresetGlossary(false);
}

function applyGlossaryToPreview() {
  let changed = 0;
  for (const segment of state.segments) {
    const current = segment.translationHtml || "";
    const repaired = repairSegmentTranslation(segment, current);
    const next = segment.kind === "meta" ? applyGlossaryToString(repaired) : applyTrustedNameGlossary(repaired);
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
    ".ao3-zh em,.ao3-zh i{font-style:normal;font-weight:750;letter-spacing:.08em;}",
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
  const tag = segment?.tag || "p";
  if (isDecorativeSegment(segment)) return segment.originalHtml || "";
  return "<" + tag + "><span class=\"ao3-untranslated\">\u3010\u672a\u7ffb\u8bd1\uff1a\u56de\u5230\u7f51\u9875\u8865\u7ffb\u3011</span></" + tag + ">";
}

function exportTranslationHtml(segment) {
  if (isDecorativeSegment(segment)) return applyReaderNameToHtml(segment.originalHtml || "");
  return applyReaderNameToHtml(isTranslatedSegment(segment) ? segment.translationHtml : untranslatedExportHtml(segment));
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
    ".segpair{margin:0 0 1.2em;}",
    ".src{margin:0 0 .35em;}",
    ".zh{margin:0;}",
    ".untranslated{opacity:.75;}",
    type === "zh" ? ".src{display:none;}" : "",
    type === "en" ? ".zh{display:none;}" : ""
  ].filter(Boolean).join("\n");
}

function buildBooxChapters(segments, exportTitle) {
  const bodySegments = segments.filter((segment) => (
    segment.kind !== "meta"
    && !["summary", "notes"].includes(segment.scope)
    && (!["title", "chapter-title"].includes(segment.scope) || isChapterTitleSegment(segment, exportTitle))
  ));
  const explicitTitles = bodySegments.filter((segment) => isChapterTitleSegment(segment, exportTitle));
  const chapters = [];
  let current = null;

  const startChapter = (title) => {
    current = {
      id: "chapter-" + (chapters.length + 1),
      title: title || "",
      hasTitle: Boolean(title),
      segments: []
    };
    chapters.push(current);
  };

  if (!explicitTitles.length) startChapter("");

  for (const segment of bodySegments) {
    if (isChapterTitleSegment(segment, exportTitle)) {
      startChapter(cleanExportText(segment.originalText));
      continue;
    }
    if (!current) startChapter("");
    current.segments.push(segment);
  }

  if (!chapters.length) startChapter("");
  return chapters;
}

function buildSegPairHtml(segment, type) {
  const source = innerHtmlForExport(applyReaderNameToHtml(segment.originalHtml));
  if (isDecorativeSegment(segment)) {
    return "<section class=\"segpair decorative\" id=\"" + escapeHtml(segment.id) + "\"><p class=\"src\">" + source + "</p></section>";
  }
  const translated = isTranslatedSegment(segment)
    ? innerHtmlForExport(applyReaderNameToHtml(segment.translationHtml))
    : "\u3010\u672a\u7ffb\u8bd1\uff1a\u56de\u5230\u7f51\u9875\u8865\u7ffb\u3011";
  const zhClass = isTranslatedSegment(segment) ? "zh" : "zh untranslated";
  return [
    "<section class=\"segpair\" id=\"" + escapeHtml(segment.id) + "\">",
    type !== "zh" ? "<p class=\"src\">" + source + "</p>" : "",
    type !== "en" ? "<p class=\"" + zhClass + "\">" + translated + "</p>" : "",
    "</section>"
  ].filter(Boolean).join("\n");
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
  }).join("\n");
  return "<section class=\"frontmatter\">\n" + rows + "\n</section>";
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
  const chapters = buildBooxChapters(state.segments, exportTitle);
  const titledChapters = chapters.filter((chapter) => chapter.hasTitle);
  const toc = titledChapters.length ? [
    '<nav id="toc" class="toc" role="doc-toc">',
    "<h2>\u76ee\u5f55</h2>",
    "<ol>",
    ...titledChapters.map((chapter) => "<li><a href=\"#" + escapeHtml(chapter.id) + "\">" + escapeHtml(chapter.title) + "</a></li>"),
    "</ol>",
    "</nav>"
  ].join("\n") : "";
  const frontMatter = buildFrontMatterHtml(state.segments, type);
  const chapterHtml = chapters.map((chapter) => [
    "<section class=\"chapter\" id=\"" + escapeHtml(chapter.id) + "\">",
    chapter.hasTitle ? "<h1 class=\"chapter-title\">" + escapeHtml(chapter.title) + "</h1>" : "",
    chapter.segments.map((segment) => buildSegPairHtml(segment, type)).join("\n"),
    "</section>"
  ].filter(Boolean).join("\n")).join("\n");
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
    .zh em,.zh i{font-style:normal;font-weight:750;letter-spacing:.08em;}
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
    const wrapper = doc.createElement(segment.kind === "meta" ? "p" : "div");
    wrapper.className = segment.kind === "meta" ? "meta" : "pair";
    if (type === "en") {
      wrapper.innerHTML = applyReaderNameToHtml(segment.originalHtml);
    } else if (type === "zh") {
      wrapper.innerHTML = exportTranslationHtml(segment);
    } else if (segment.kind === "meta") {
      const translated = isTranslatedSegment(segment) ? textOnly(segment.translationHtml) : "";
      wrapper.textContent = translated && translated !== segment.originalText
        ? `${segment.originalText} / ${translated}`
        : segment.originalText;
    } else {
      wrapper.innerHTML = `<div class="en">${applyReaderNameToHtml(segment.originalHtml)}</div><div class="zh">${exportTranslationHtml(segment)}</div>`;
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName: file.name, base64: arrayBufferToBase64(buffer) })
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

async function handleFiles(files) {
  try {
    const incoming = [...(files || [])].filter(isImportableFile);
    if (!incoming.length) {
      setStatus("No HTML or EPUB file found. Please choose .html, .htm, .xhtml, or .epub.", true);
      return;
    }
    setStatus(`Importing ${incoming.length} file${incoming.length > 1 ? "s" : ""}...`);
    const firstNewIndex = state.works.length;
    for (const file of incoming) {
      const work = {
        fileName: file.name,
        rawHtml: await importableFileText(file),
        metadata: null,
        segments: [],
        exportTitle: "",
        selectedIds: [],
        sizeKb: (file.size / 1024).toFixed(1),
        progressDone: 0,
        progressTotal: 0,
        status: ""
      };
      state.works.push(work);
      state.currentWorkIndex = state.works.length - 1;
      selectedSegmentIds.clear();
      parseWork(work, { quiet: true });
    }
    setActiveWork(firstNewIndex);
    updateFileMeta();
  } catch (error) {
    setStatus(`Import failed: ${error.message || error}`, true);
  } finally {
    if (els.fileInput) els.fileInput.value = "";
  }
}

els.providerSelect.addEventListener("change", () => {
  updateAiSettings();
});
if (els.googleContextMode) {
  els.googleContextMode.checked = localStorage.getItem(GOOGLE_CONTEXT_STORAGE_KEY) !== "0";
  els.googleContextMode.addEventListener("change", () => {
    localStorage.setItem(GOOGLE_CONTEXT_STORAGE_KEY, els.googleContextMode.checked ? "1" : "0");
  });
}
els.apiKeyInput.addEventListener("input", () => {
  if (els.apiKeyInput.value.trim()) els.aiSettings.hidden = true;
});
els.fileInput.addEventListener("change", () => handleFiles(els.fileInput.files));
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
      ? "Google 还是没接住。先别刷新，等 30 秒再点 Start translate；我会只补没翻完的段落。若连续失败，多半是代理/Google 临时限流，不是文章丢了。"
      : message, true);
  }
});
els.polishButton.addEventListener("click", async () => {
  try {
    await polishChinese("deepseek");
  } catch (error) {
    els.polishButton.disabled = false;
    setBusy(false);
    setStatus(error.message || "Polish failed.", true);
  }
});
if (els.doubaoPolishButton) {
  els.doubaoPolishButton.addEventListener("click", async () => {
    try {
      await doubaoRewriteSelected();
    } catch (error) {
      els.doubaoPolishButton.disabled = false;
      setBusy(false);
      setStatus(error.message || "Doubao rewrite failed.", true);
    }
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
    setStatus(readerName() ? "Y/N name applied to preview and exports." : "Y/N name cleared.");
  });
}
if (els.readerNameInput) {
  els.readerNameInput.addEventListener("keydown", (event) => {
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
    syncActiveWork();
    setProgress(activeWork()?.progressDone || 0, activeWork()?.progressTotal || state.segments.length);
    updateReady();
  }
});
els.preview.addEventListener("click", (event) => {
  const missingButton = event.target.closest("[data-preview-missing]");
  if (missingButton) {
    state.previewMissingOnly = !state.previewMissingOnly;
    state.previewAll = state.previewMissingOnly ? true : state.previewAll;
    state.previewVisibleCount = PREVIEW_LIMIT;
    updateReady();
    schedulePreviewRender(true);
    return;
  }
  const moreButton = event.target.closest("[data-preview-more]");
  if (!moreButton) return;
  state.previewVisibleCount = Math.min(
    state.segments.length,
    (state.previewVisibleCount || PREVIEW_LIMIT) + PREVIEW_PAGE_SIZE
  );
  schedulePreviewRender(true);
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
  button.addEventListener("click", () => {
    const type = button.dataset.export;
    const suffix = type === "bilingual" ? "bilingual" : type === "zh" ? "zh" : "en";
    download(`${safeBase()} ${suffix}.html`, buildHtml(type));
  });
});
els.epubButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const type = button.dataset.epub;
    const suffix = type === "bilingual" ? "bilingual" : type === "zh" ? "zh" : "en";
    downloadBlob(`${safeBase()} ${suffix}.epub`, buildEpub(type));
  });
});
if (els.togglePreviewButton) {
  els.togglePreviewButton.addEventListener("click", () => {
    state.previewAll = !state.previewAll;
    state.previewVisibleCount = state.previewAll ? Math.max(state.previewVisibleCount || PREVIEW_LIMIT, PREVIEW_LIMIT) : PREVIEW_LIMIT;
    updateReady();
    schedulePreviewRender(true);
  });
}

loadSavedGlossary();
loadReaderName();
restoreSavedSession().then((restored) => {
  if (!restored) updateReady();
}).finally(() => {
  loadServerConfig();
});
