import "dotenv/config";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

process.env.FFMPEG_PATH = ffmpegPath;
process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH}`;

export const config = {
  token: process.env.DISCORD_TOKEN ?? "",
};
