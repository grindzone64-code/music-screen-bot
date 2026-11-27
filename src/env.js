import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

process.env.FFMPEG_PATH = ffmpegPath;
process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH}`;

function stripWrappingQuotes(value) {
  const s = value.trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function jsonCookiesToNetscape(items) {
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of items) {
    if (!c?.domain || !c?.name) continue;
    const domain = String(c.domain);
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const cookiePath = String(c.path || "/");
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiry = Math.floor(Number(c.expirationDate ?? c.expires ?? 0)) || 0;
    const name = String(c.name);
    const value = String(c.value ?? "");
    lines.push([domain, includeSubdomains, cookiePath, secure, expiry, name, value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

function normalizeNetscapeText(text) {
  let t = stripWrappingQuotes(text);
  if (!t.includes("\n")) t = t.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");

  const lines = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith("#") && !line.startsWith("#HttpOnly_")) return line;
      if (line.includes("\t")) return line;
      // Tabs lost when pasted into web UI: rebuild 7 Netscape fields
      const parts = line.split(/\s+/);
      if (parts.length >= 7) {
        return [...parts.slice(0, 6), parts.slice(6).join(" ")].join("\t");
      }
      return line;
    });

  if (!lines.some((l) => l.startsWith("# Netscape") || l.startsWith("# HTTP Cookie File"))) {
    lines.unshift("# Netscape HTTP Cookie File");
  }
  return lines.join("\n") + "\n";
}

function normalizeCookies(raw) {
  let text = stripWrappingQuotes(raw);

  // Decode base64 if it looks like base64 without domains/tabs/JSON
  if (/^[A-Za-z0-9+/=\s]+$/.test(text) && !text.includes(".") && !text.startsWith("[")) {
    try {
      const decoded = Buffer.from(text, "base64").toString("utf8").trim();
      if (decoded.includes("\t") || decoded.includes("Netscape") || decoded.startsWith("[")) {
        text = decoded;
      }
    } catch {}
  }

  // Convert JSON cookie exports (e.g. Cookie-Editor / EditThisCookie) to Netscape format
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return jsonCookiesToNetscape(parsed);
      }
    } catch {}
  }

  return normalizeNetscapeText(text);
}

function writeNormalizedCookies(raw, label) {
  const normalized = normalizeCookies(raw);
  const entryCount = normalized
    .split("\n")
    .filter((l) => l.trim() && (!l.startsWith("#") || l.startsWith("#HttpOnly_"))).length;

  if (entryCount === 0) {
    console.warn(`[env] ${label} has no valid cookie entries — ignoring`);
    return "";
  }

  const cookiePath = path.join(os.tmpdir(), "music-screen-bot-yt-cookies.txt");
  fs.writeFileSync(cookiePath, normalized, { mode: 0o600 });
  console.log(`[env] loaded ${entryCount} YouTube cookie entries from ${label}`);
  return cookiePath;
}

function resolveCookiesFile() {
  const explicitPath = (process.env.YOUTUBE_COOKIES_FILE || process.env.YOUTUBE_COOKIES_PATH)?.trim();
  if (explicitPath && fs.existsSync(explicitPath)) {
    console.log(`[env] using YouTube cookies file: ${explicitPath}`);
    return explicitPath;
  }

  if (process.env.YOUTUBE_COOKIES?.trim()) {
    return writeNormalizedCookies(process.env.YOUTUBE_COOKIES, "YOUTUBE_COOKIES");
  }

  const localCookies = path.resolve("cookies.txt");
  if (fs.existsSync(localCookies)) {
    return writeNormalizedCookies(fs.readFileSync(localCookies, "utf8"), "cookies.txt");
  }

  console.log("[env] YOUTUBE_COOKIES not set (SoundCloud fallback active if YouTube blocks IP)");
  return "";
}

export const config = {
  token: process.env.DISCORD_TOKEN ?? "",
  ytCookiesFile: resolveCookiesFile(),
};
