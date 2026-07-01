import http from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const appRoot = fileURLToPath(new URL("./", import.meta.url));
const root = fileURLToPath(new URL("./public", import.meta.url));
const port = Number(process.env.PORT || 4191);
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "http://127.0.0.1:7897";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

let googleAuth = { key: "", fetchedAt: 0 };
let localEnvCache = null;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function safeErrorMessage(error) {
  const raw = String(error?.message || error || "Request failed.");
  return raw
    .replace(/AIza[\w-]{35}/g, "[google-key-hidden]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[api-key-hidden]")
    .replace(/C:\\Users\\[^"'`\s]+/g, "[local-temp-file]")
    .replace(/--data-binary\s+@\S+/g, "--data-binary [hidden]")
    .slice(0, 500);
}

function networkErrorFor(url, error) {
  const host = new URL(url).hostname;
  const detail = String(error?.stderr || error?.stdout || "").trim();
  if (host.includes("google")) {
    return new Error(detail
      ? `Google Translate request failed. Check proxy 127.0.0.1:7897, then retry. ${detail}`
      : "Google Translate request failed. Check proxy 127.0.0.1:7897, then retry.");
  }
  if (host.includes("deepseek")) {
    return new Error(detail
      ? `DeepSeek request failed. Please retry in a moment. ${detail}`
      : "DeepSeek request failed. Please retry in a moment.");
  }
  if (host.includes("volces.com")) {
    return new Error(detail
      ? `Doubao request failed. It may be busy or the request is too large. ${detail}`
      : "Doubao request failed. It may be busy or the request is too large.");
  }
  return new Error(`Network request failed for ${host}.`);
}

function shouldUseProxy(url, options = {}) {
  const host = new URL(url).hostname;
  if (options.proxy === false) return false;
  if (host.includes("deepseek")) return false;
  if (host.includes("volces.com")) return false;
  return true;
}

function sendText(res, status, value) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(value);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 80 * 1024 * 1024) {
        reject(new Error("File is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid request body."));
      }
    });
    req.on("error", reject);
  });
}

async function curlText(url, options = {}) {
  const args = ["-L", "--max-time", String(options.timeout || 60), "-s", url];
  if (shouldUseProxy(url, options)) args.splice(1, 0, "--proxy", proxyUrl);
  for (const [name, value] of Object.entries(options.headers || {})) {
    args.push("-H", `${name}: ${value}`);
  }

  let bodyPath = "";
  if (options.body !== undefined) {
    bodyPath = join(tmpdir(), `ao3-curl-${randomUUID()}.txt`);
    await writeFile(bodyPath, options.body, "utf8");
    args.push("--data-binary", `@${bodyPath}`);
  }

  try {
    const { stdout } = await execFileAsync("curl.exe", args, {
      windowsHide: true,
      timeout: (options.timeout || 60) * 1000 + 5000,
      maxBuffer: 64 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    throw networkErrorFor(url, error);
  } finally {
    if (bodyPath) await unlink(bodyPath).catch(() => {});
  }
}

async function getGoogleApiKey(forceRefresh = false) {
  if (!forceRefresh && googleAuth.key && Date.now() - googleAuth.fetchedAt < 20 * 60 * 1000) return googleAuth.key;
  const authUrl = "https://translate.googleapis.com/_/translate_http/_/js/k=translate_http.tr.en_US.YusFYy3P_ro.O/am=AAg/d=1/exm=el_conf/ed=1/rs=AN8SPfq1Hb8iJRleQqQc8zhdzXmF9E56eQ/m=el_main";
  const text = await curlText(authUrl, { timeout: 25 });
  const key = text.match(/X-goog-api-key\\":\\"(\w{39})\\"/)?.[1] || text.match(/AIza[\w-]{35}/)?.[0];
  if (!key) throw new Error("Could not get Google Translate key.");
  googleAuth = { key, fetchedAt: Date.now() };
  return key;
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

function readU16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readU32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function unzipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i -= 1) {
    if (readU32(buffer, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid EPUB zip.");
  const count = readU16(buffer, eocd + 10);
  let offset = readU32(buffer, eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (readU32(buffer, offset) !== 0x02014b50) break;
    const method = readU16(buffer, offset + 10);
    const compressedSize = readU32(buffer, offset + 20);
    const nameLength = readU16(buffer, offset + 28);
    const extraLength = readU16(buffer, offset + 30);
    const commentLength = readU16(buffer, offset + 32);
    const localOffset = readU32(buffer, offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = readU16(buffer, localOffset + 26);
    const localExtraLength = readU16(buffer, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, data);
    else if (method === 8) entries.set(name, inflateRawSync(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xmlAttr(text = "", tagPattern = "", attr = "") {
  const match = String(text).match(new RegExp("<" + tagPattern + "\\b[^>]*\\s" + attr + "=[\"']([^\"']+)[\"']", "i"));
  return match?.[1] || "";
}

function xmlText(text = "", tag = "") {
  const match = String(text).match(new RegExp("<(?:[\\w.-]+:)?" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?" + tag + ">", "i"));
  return match ? match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
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

function stripUnsafeHtml(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+=("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|src)=["']javascript:[^"']*["']/gi, "");
}

function bodyInnerHtml(html = "") {
  const match = String(html).match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return match ? match[1] : html;
}

function extractHeading(html = "") {
  const match = String(html).match(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (!match) return { title: "", html };
  const title = match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return { title, html: html.replace(match[0], "") };
}

function epubBufferToHtml(buffer, fileName = "AO3 Work") {
  const entries = unzipEntries(buffer);
  const container = entries.get("META-INF/container.xml")?.toString("utf8") || "";
  const opfPath = xmlAttr(container, "rootfile", "full-path");
  if (!opfPath || !entries.has(opfPath)) throw new Error("EPUB missing package file.");
  const opf = entries.get(opfPath).toString("utf8");
  const title = xmlText(opf, "title") || fileName.replace(/\.epub$/i, "");
  const author = xmlText(opf, "creator");
  const manifest = new Map();
  for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = match[0];
    const id = tag.match(/\bid=["']([^"']+)["']/i)?.[1] || "";
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1] || "";
    if (id && href) manifest.set(id, resolveEpubPath(opfPath, href));
  }
  let chapterPaths = [...opf.matchAll(/<itemref\b[^>]*\bidref=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => manifest.get(match[1]))
    .filter(Boolean);
  if (!chapterPaths.length) {
    chapterPaths = [...entries.keys()].filter((name) => /\.(xhtml|html|htm)$/i.test(name) && !/nav|toc/i.test(name));
  }

  const chapters = [];
  for (const path of chapterPaths) {
    const raw = entries.get(path);
    if (!raw) continue;
    let content = stripUnsafeHtml(bodyInnerHtml(raw.toString("utf8")));
    const heading = extractHeading(content);
    content = heading.html;
    const chapterTitle = heading.title || xmlText(raw.toString("utf8"), "title");
    if (!content.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()) continue;
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

function applyGlossaryText(text, glossary = []) {
  let output = text;
  for (const item of sortedGlossary(glossary)) {
    if (!item?.source || !item?.target) continue;
    if (/keep as-is|\u4e0d\u7ffb\u8bd1/i.test(item.target)) continue;
    const target = String(item.target).split(/[\uFF0C,;\uFF1B]|\s+\/\s+/)[0].trim();
    if (!target || /context|voice|tone|\u6309\u8bed\u5883|\u6309\u89d2\u8272/i.test(target)) continue;
    const source = String(item.source).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(source, "g"), target);
  }
  return output;
}

function sortedGlossary(glossary = []) {
  return [...glossary]
    .filter((item) => item?.source && item?.target)
    .sort((a, b) => String(b.source).length - String(a.source).length);
}

function usableGlossaryTarget(item) {
  if (!item?.source || !item?.target) return "";
  const rawTarget = String(item.target || "").trim();
  if (/keep as-is|\u4e0d\u7ffb\u8bd1/i.test(rawTarget)) return "";
  const target = rawTarget.split(/[\uFF0C,;\uFF1B]|\s+\/\s+/)[0].trim();
  if (!target || /context|voice|tone|\u6309\u8bed\u5883|\u6309\u89d2\u8272|by /i.test(target)) return "";
  return target;
}

function exactGlossaryTarget(text = "", glossary = []) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  for (const item of sortedGlossary(glossary)) {
    const source = String(item.source || "").replace(/\s+/g, " ").trim();
    if (!source || source !== normalized) continue;
    if (/keep as-is|\u4e0d\u7ffb\u8bd1/i.test(item.target || "")) return source;
    const target = usableGlossaryTarget(item);
    if (target) return target;
  }
  return "";
}

function shouldProtectGlossaryItem(item, mode = "body") {
  const source = String(item?.source || "").trim();
  const target = usableGlossaryTarget(item);
  if (!source || !target) return false;
  if (mode === "meta") return true;
  if (/^(Alpha|Beta|Omega|Heat|Rut|Reader|You|POV|Plot|Praise|Comfort|Blood|Injury|Violence|English|Words|Chapters|Comments|Kudos|Bookmarks|Hits)$/i.test(source)) return false;
  if (/^[A-Za-z][A-Za-z.'-]{2,}(?:\s+[A-Za-z][A-Za-z.'-]*)*$/.test(source)) return true;
  return source.length >= 5;
}

function protectGlossaryHtml(html, glossary = [], index = 0, mode = "body") {
  let output = html;
  const protectedTerms = [];
  for (const item of sortedGlossary(glossary)) {
    if (!shouldProtectGlossaryItem(item, mode)) continue;
    const target = usableGlossaryTarget(item);
    const source = String(item.source).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const token = `AO3TERM${index}X${protectedTerms.length}`;
    const next = output.replace(new RegExp(`\\b${source}\\b`, "g"), `<span class="notranslate" translate="no">${token}</span>`);
    if (next !== output) {
      protectedTerms.push({ token, target });
      output = next;
    }
  }
  return { html: output, protectedTerms };
}

function restoreGlossaryHtml(html, protectedTerms = []) {
  let output = html;
  for (const item of protectedTerms) {
    const spanPattern = new RegExp(`<span[^>]*>${item.token}</span>`, "g");
    output = output.replace(spanPattern, item.target).replace(new RegExp(item.token, "g"), item.target);
  }
  return output;
}

async function translateWithGoogleHtmlAttempt(items, from = "en", to = "zh-CN", glossary = [], forceKeyRefresh = false) {
  const key = await getGoogleApiKey(forceKeyRefresh);
  const direct = new Map();
  const remoteItems = [];
  for (const item of items) {
    const exact = item.kind === "meta" ? exactGlossaryTarget(item.text || "", glossary) : "";
    if (exact) direct.set(item.id, { id: item.id, html: `<${item.tag || "span"}>${escapeHtml(exact)}</${item.tag || "span"}>` });
    else remoteItems.push(item);
  }
  if (!remoteItems.length) return items.map((item) => direct.get(item.id));

  const protectedItems = remoteItems.map((item, index) => protectGlossaryHtml(
    item.html || `<${item.tag || "p"}>${escapeHtml(item.text || "")}</${item.tag || "p"}>`,
    glossary,
    index,
    item.kind === "meta" ? "meta" : "body"
  ));
  const sourceTexts = protectedItems.map((item) => item.html);
  const payload = JSON.stringify([[sourceTexts, from, to], "te"]);
  const raw = await curlText("https://translate-pa.googleapis.com/v1/translateHtml", {
    timeout: 60,
    headers: {
      "X-goog-api-key": key,
      "Content-Type": "application/json+protobuf",
      "Origin": "https://translate.google.com",
      "Referer": "https://translate.google.com/",
      "User-Agent": "Mozilla/5.0"
    },
    body: payload
  });

  const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const snippets = data?.[0];
  if (!Array.isArray(snippets)) throw new Error("Google returned a temporary invalid response.");
  if (snippets.length !== remoteItems.length) {
    throw new Error(`Google returned ${snippets.length} snippets for ${remoteItems.length} segments.`);
  }
  const translated = new Map(remoteItems.map((item, index) => [item.id, {
    id: item.id,
    html: restoreGlossaryHtml(snippets[index] || "", protectedItems[index]?.protectedTerms || [])
  }]));
  return items.map((item) => direct.get(item.id) || translated.get(item.id));
}

async function translateWithGoogleHtml(items, from = "en", to = "zh-CN", glossary = []) {
  try {
    return await translateWithGoogleHtmlAttempt(items, from, to, glossary, false);
  } catch (error) {
    googleAuth = { key: "", fetchedAt: 0 };
    try {
      return await translateWithGoogleHtmlAttempt(items, from, to, glossary, true);
    } catch (retryError) {
      const detail = String(retryError?.message || "").slice(0, 160);
      throw new Error(detail
        ? `Google Translate failed this batch after retry. ${detail}`
        : "Google Translate failed this batch after retry.");
    }
  }
}

function decodeHtmlAttr(value = "") {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractGoogleSegmentWrappers(html = "", expectedIds = []) {
  const expected = new Set(expectedIds.map(String));
  const found = new Map();
  const openPattern = /<div\b[^>]*\bdata-ao3-seg=(["'])(.*?)\1[^>]*>/gi;
  let match;
  while ((match = openPattern.exec(html))) {
    const id = decodeHtmlAttr(match[2]);
    if (!expected.has(id)) continue;
    if (found.has(id)) throw new Error("Google context marker duplicated: " + id);
    const innerStart = openPattern.lastIndex;
    const divPattern = /<\/?div\b[^>]*>/gi;
    divPattern.lastIndex = innerStart;
    let depth = 1;
    let closeStart = -1;
    let closeEnd = -1;
    let divMatch;
    while ((divMatch = divPattern.exec(html))) {
      if (/^<\/div/i.test(divMatch[0])) {
        depth -= 1;
        if (depth === 0) {
          closeStart = divMatch.index;
          closeEnd = divPattern.lastIndex;
          break;
        }
      } else {
        depth += 1;
      }
    }
    if (closeStart < 0) throw new Error("Google context marker could not be closed: " + id);
    found.set(id, html.slice(innerStart, closeStart));
    openPattern.lastIndex = closeEnd;
  }
  for (const id of expected) {
    if (!found.has(id)) throw new Error("Google context marker missing: " + id);
  }
  return found;
}

async function translateWithGoogleHtmlDocumentChunk(items, from = "en", to = "zh-CN", glossary = []) {
  const key = await getGoogleApiKey(false);
  const direct = new Map();
  const remoteItems = [];
  for (const item of items) {
    const exact = item.kind === "meta" ? exactGlossaryTarget(item.text || "", glossary) : "";
    if (exact) direct.set(item.id, { id: item.id, html: "<" + (item.tag || "span") + ">" + escapeHtml(exact) + "</" + (item.tag || "span") + ">" });
    else remoteItems.push(item);
  }
  if (!remoteItems.length) return items.map((item) => direct.get(item.id));

  const protectedItems = remoteItems.map((item, index) => protectGlossaryHtml(
    item.html || ("<" + (item.tag || "p") + ">" + escapeHtml(item.text || "") + "</" + (item.tag || "p") + ">"),
    glossary,
    index,
    item.kind === "meta" ? "meta" : "body"
  ));
  const combinedHtml = protectedItems.map((item, index) => {
    const id = escapeHtml(remoteItems[index].id);
    return '<div class="ao3-trans-seg" data-ao3-seg="' + id + '" translate="yes">' + item.html + "</div>";
  }).join("\n");
  const payload = JSON.stringify([[[combinedHtml], from, to], "te"]);
  const raw = await curlText("https://translate-pa.googleapis.com/v1/translateHtml", {
    timeout: 70,
    headers: {
      "X-goog-api-key": key,
      "Content-Type": "application/json+protobuf",
      "Origin": "https://translate.google.com",
      "Referer": "https://translate.google.com/",
      "User-Agent": "Mozilla/5.0"
    },
    body: payload
  });
  const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const snippets = data?.[0];
  if (!Array.isArray(snippets) || snippets.length !== 1) throw new Error("Google context returned an invalid response.");
  const translatedById = extractGoogleSegmentWrappers(snippets[0] || "", remoteItems.map((item) => item.id));
  const translated = new Map(remoteItems.map((item, index) => [item.id, {
    id: item.id,
    html: restoreGlossaryHtml(translatedById.get(item.id) || "", protectedItems[index]?.protectedTerms || [])
  }]));
  return items.map((item) => direct.get(item.id) || translated.get(item.id));
}

function safeJsonFromText(text = "") {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
  return JSON.parse(candidate);
}

function glossaryPrompt(glossary = []) {
  const rows = glossary.filter((item) => item.source || item.target).map((item) => `- ${item.source || ""} => ${item.target || ""}`).join("\n");
  return rows || "None";
}

function restoreSimpleGlossaryTerms(html = "", glossary = []) {
  let output = String(html || "");
  for (const item of sortedGlossary(glossary)) {
    const source = String(item.source || "").trim();
    const target = String(item.target || "").split(/[\uFF0C,;\uFF1B]|\s+\/\s+/)[0].trim();
    if (!source || !target) continue;
    if (/keep as-is|\u4e0d\u7ffb\u8bd1|context|voice|tone|by /i.test(target)) continue;
    if (!/[A-Za-z]/.test(source)) continue;
    if (/^(You|Reader|Alpha|Beta|Omega|Heat|Rut|Plot|Blood|Injury|Violence)$/i.test(source)) continue;
    const pattern = new RegExp(`\\b${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    output = output.replace(pattern, target);
  }
  return output;
}

async function readLocalEnv() {
  if (localEnvCache) return localEnvCache;
  localEnvCache = {};
  for (const name of [".env.local", ".env"]) {
    try {
      const text = await readFile(join(appRoot, name), "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (!match) continue;
        const value = match[2].replace(/^["']|["']$/g, "");
        localEnvCache[match[1]] = value;
      }
    } catch {}
  }
  return localEnvCache;
}

async function deepSeekApiKey(inputKey = "") {
  if (inputKey.trim()) return inputKey.trim();
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const localEnv = await readLocalEnv();
  return localEnv.DEEPSEEK_API_KEY || "";
}

async function doubaoApiKey(inputKey = "") {
  if (inputKey.trim()) return inputKey.trim();
  if (process.env.DOUBAO_API_KEY) return process.env.DOUBAO_API_KEY;
  if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY;
  const localEnv = await readLocalEnv();
  return localEnv.DOUBAO_API_KEY || localEnv.ARK_API_KEY || "";
}

function aiSystemPrompt(task = "translate") {
  if (task === "title") {
    return [
      "你是熟悉 AO3 同人标题风格的英译中标题助手。",
      "只根据英文标题本身给出 5 个中文标题候选；不要参考正文，不要脑补剧情。",
      "候选要短、有留白、有暧昧感或文学感；不要露骨低俗，不要网文营销腔。",
      "只返回 JSON 数组：[{\"id\":\"title\",\"html\":\"<p>候选一\\n候选二\\n候选三\\n候选四\\n候选五</p>\"}]。"
    ].join("\n");
  }
  if (task === "rewrite") {
    return [
      "你是熟悉 AO3 同人语境的英文小说译者，负责把选中段落重新英译中。",
      "以英文原文为准，before/after 只作上下文参考，不要翻译进当前段落。",
      "忠于情节、动作、心理和对话；不增删、不脑补、不改剧情。",
      "中文要像同人小说正文，人物语气自然；只做必要顺句，不要大幅美化或扩写。",
      "保留段落边界和简单 HTML 标签。严格遵守术语表。",
      "只返回 JSON 数组：[{\"id\":\"...\",\"html\":\"...\"}]，html 只包含重翻后的中文 HTML。"
    ].join("\n");
  }
  if (task === "polish") {
    return [
      "你是克制的中文小说译文校对，不是改写作者。",
      "只对已有中文译文做轻微润色：能不改就不改，只修错译、漏译、人称代词、术语、语病和明显翻译腔。",
      "参考英文原文判断语气和含义；before/after 只作上下文参考，不要写进当前段落。",
      "保持原段落边界、亲密程度、节奏、标点风格和简单 HTML 标签。禁止扩写、删减、总结、审查或新增描写。",
      "严格遵守术语表。只返回 JSON 数组：[{\"id\":\"...\",\"html\":\"...\"}]，html 只包含润色后的中文 HTML。"
    ].join("\n");
  }
  return [
    "你是熟悉 AO3 同人语境的英文小说译者，负责英译中。",
    "把英文小说翻成自然的简体中文正文；每个数组项只翻译它自己的 text/html，before/after 只作上下文参考，绝对不要翻译进当前段落。",
    "必须保持 id 一一对应：不得合并段落、拆分段落、移动段落、交换段落内容或改写 id。",
    "忠于原文意思、动作、心理、对话、句序、段落边界和简单 HTML 标签；不要改写、美化、扩写、总结、删减、审查或新增细节。",
    "中文要像同人小说正文，不要说明书腔、字幕腔、报告腔。严格遵守术语表。",
    "只返回 JSON 数组：[{\"id\":\"...\",\"html\":\"...\"}]，html 只包含该 id 对应段落的中文 HTML。"
  ].join("\n");
}

async function translateWithAICompatibleClean(items, options = {}) {
  const isDoubao = options.provider === "doubao";
  const endpoint = options.endpoint || (isDoubao
    ? "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
    : "https://api.deepseek.com/chat/completions");
  const apiKey = isDoubao ? await doubaoApiKey(options.apiKey || "") : await deepSeekApiKey(options.apiKey || "");
  const model = options.model || (isDoubao ? "doubao-seed-2-1-pro-260628" : "deepseek-v4-flash");
  if (!apiKey) throw new Error("API key is required.");

  const task = options.task || "translate";
  const promptItems = items.map((item) => {
    const entry = task === "polish" || task === "rewrite"
      ? { id: item.id, source: item.source || "", current: item.current || item.html || "" }
      : { id: item.id, text: item.text || "", html: item.html };
    if (item.before) entry.before = String(item.before).slice(-900);
    if (item.after) entry.after = String(item.after).slice(0, 500);
    return entry;
  });

  const payload = {
    model,
    temperature: Number(options.temperature ?? (task === "polish" ? 0.12 : 0.25)),
    messages: [
      { role: "system", content: aiSystemPrompt(task) },
      {
        role: "user",
        content: [
          `Glossary:\n${glossaryPrompt(options.glossary)}`,
          "Segments:",
          JSON.stringify(promptItems)
        ].join("\n\n")
      }
    ]
  };
  if (!isDoubao) payload.thinking = { type: "disabled" };

  const raw = await curlText(endpoint, {
    timeout: isDoubao ? 90 : 55,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });
  const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (data?.error) {
    const message = data.error.message || data.error.code || "Provider returned an error.";
    throw new Error(`${isDoubao ? "Doubao" : "DeepSeek"} API error: ${message}`);
  }
  const content = data?.choices?.[0]?.message?.content || "";
  if (task === "title") {
    try {
      const parsedTitle = safeJsonFromText(content);
      if (Array.isArray(parsedTitle)) return parsedTitle.map((item) => ({ id: String(item.id || "title"), html: String(item.html || "") }));
    } catch {}
    return [{ id: "title", html: `<p>${escapeHtml(content.trim())}</p>` }];
  }
  if (!content.trim()) throw new Error(`${isDoubao ? "Doubao" : "DeepSeek"} returned no text.`);
  const parsed = safeJsonFromText(content);
  if (!Array.isArray(parsed)) throw new Error("Model did not return a segment array.");
  return parsed.map((item) => ({
    id: String(item.id || ""),
    html: restoreSimpleGlossaryTerms(String(item.html || ""), options.glossary || [])
  }));
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  let path = decodeURIComponent(requestUrl.pathname);
  if (path === "/") path = "/index.html";
  const normalized = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, normalized);
  if (!filePath.startsWith(root)) return sendText(res, 403, "Forbidden");
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(body);
  } catch {
    sendText(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    res.end();
    return;
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, 200, {
        hasDeepSeekKey: Boolean(await deepSeekApiKey("")),
        hasDoubaoKey: Boolean(await doubaoApiKey(""))
      });
    }
    if (req.method === "POST" && url.pathname === "/api/epub-to-html") {
      const body = await readJsonBody(req);
      const base64 = String(body.base64 || "");
      if (!base64) return sendJson(res, 400, { error: "No EPUB file received." });
      const html = epubBufferToHtml(Buffer.from(base64, "base64"), String(body.fileName || "AO3 Work"));
      return sendJson(res, 200, { html });
    }
    if (req.method === "POST" && url.pathname === "/api/translate") {
      const body = await readJsonBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return sendJson(res, 400, { error: "No segments to translate." });
      const provider = body.provider || "google";
      let translations;
      if (provider === "deepseek" || provider === "doubao" || provider === "openai-compatible") {
        translations = await translateWithAICompatibleClean(items, body);
      } else if (body.googleMode === "context" || body.contextualGoogle === true) {
        try {
          translations = await translateWithGoogleHtmlDocumentChunk(items, body.from || "en", body.to || "zh-CN", body.glossary || []);
        } catch {
          translations = await translateWithGoogleHtml(items, body.from || "en", body.to || "zh-CN", body.glossary || []);
        }
      } else {
        translations = await translateWithGoogleHtml(items, body.from || "en", body.to || "zh-CN", body.glossary || []);
      }
      return sendJson(res, 200, { translations });
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: safeErrorMessage(error) });
  }
});

server.listen(port, () => {
  console.log(`AO3 bilingual HTML translator: http://localhost:${port}`);
});
