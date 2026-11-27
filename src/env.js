import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

process.env.FFMPEG_PATH = ffmpegPath;
process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH}`;

function normalizeCookies(text) {
  let t = text.trim().replace(/^["']|["']$/g, "");
  if (!t.includes("\n")) t = t.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    if (line.startsWith("#") && !line.startsWith("#HttpOnly_")) return line;
    if (line.includes("\t")) return line;
    // tabs lost (pasted as spaces): rebuild 7 fields
    const parts = line.split(/\s+/);
    if (parts.length >= 7) return [...parts.slice(0, 6), parts.slice(6).join(" ")].join("\t");
    return line;
  });
  if (!lines.some((l) => l.startsWith("# Netscape") || l.startsWith("# HTTP Cookie File"))) {
    lines.unshift("# Netscape HTTP Cookie File");
  }
  return lines.join("\n") + "\n";
}

function decodeCookies(raw) {
  const trimmed = raw.trim();
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && !trimmed.includes(".")) {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.includes("\t") || decoded.includes("Netscape")) return normalizeCookies(decoded);
  }
  return normalizeCookies(trimmed);
}

function resolveCookiesFile() {
  const explicitPath = (process.env.YOUTUBE_COOKIES_FILE || process.env.YOUTUBE_COOKIES_PATH)?.trim();
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;

  const raw = process.env.YOUTUBE_COOKIES;
  if (!raw?.trim()) return "";

  const cookiePath = path.join(os.tmpdir(), "music-screen-bot-yt-cookies.txt");
  fs.writeFileSync(cookiePath, decodeCookies(raw), { mode: 0o600 });
  return cookiePath;
}

export const config = {
  token: process.env.DISCORD_TOKEN ?? "",
  ytCookiesFile: resolveCookiesFile(),
};
