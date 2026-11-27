import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

process.env.FFMPEG_PATH = ffmpegPath;
process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH}`;

function decodeCookies(raw) {
  const trimmed = raw.trim();
  if (trimmed.includes("\t") || trimmed.includes("# Netscape")) {
    return trimmed.includes("\n") ? trimmed : trimmed.replace(/\\n/g, "\n");
  }
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  return decoded.includes("\t") ? decoded : trimmed;
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
