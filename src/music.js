import "./env.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} from "@discordjs/voice";
import youtubeDl from "youtube-dl-exec";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

const queues = new Map();
const MAX_HISTORY = 50;

// YouTube blocks datacenter IPs unless requests carry cookies. Paste a Netscape-format
// cookies.txt into the YOUTUBE_COOKIES variable (or point YOUTUBE_COOKIES_FILE at one).
function resolveCookiesFile() {
  if (process.env.YOUTUBE_COOKIES_FILE) return process.env.YOUTUBE_COOKIES_FILE;
  const text = process.env.YOUTUBE_COOKIES;
  if (!text) return undefined;
  const file = joinPath(tmpdir(), "yt-cookies.txt");
  writeFileSync(file, text.replace(/\\n/g, "\n"), { mode: 0o600 });
  return file;
}
const COOKIES_FILE = resolveCookiesFile();

const YT_FLAGS = {
  ...(COOKIES_FILE ? { cookies: COOKIES_FILE } : {}),
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
  preferFreeFormats: true,
  referer: "https://www.youtube.com/",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

function killChild(q) {
  if (q.lastChild && !q.lastChild.killed) {
    try {
      q.lastChild.kill();
    } catch {}
  }
  q.lastChild = null;
}

function pushHistory(q, track) {
  if (!track) return;
  q.history.push(track);
  if (q.history.length > MAX_HISTORY) {
    q.history.shift();
  }
}

function getQueue(guildId) {
  let q = queues.get(guildId);
  if (q) return q;

  q = {
    player: createAudioPlayer(),
    tracks: [],
    history: [],
    nowPlaying: null,
    loop: "off",
    volume: 1,
    connection: null,
    lastChild: null,
    skipping: false,
  };

  q.player.on(AudioPlayerStatus.Idle, () => advance(guildId));
  q.player.on("error", (err) => {
    console.error(`[music] player error: ${err.message}`);
    advance(guildId);
  });

  queues.set(guildId, q);
  return q;
}

function ensureConnection(guild, voiceChannel) {
  const q = getQueue(guild.id);
  const existing = getVoiceConnection(guild.id);

  if (existing && existing.joinConfig.channelId === voiceChannel.id) {
    q.connection = existing;
    return existing;
  }

  if (existing) existing.destroy();

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  connection.subscribe(q.player);
  q.connection = connection;

  connection.on("stateChange", (_, next) => {
    if (next.status === "disconnected") {
      console.warn(`[music] voice disconnected in ${guild.id}`);
    }
  });

  return connection;
}

async function resolveTrack(query, requestedBy) {
  const target = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  const raw = await youtubeDl(target, {
    ...YT_FLAGS,
    dumpSingleJson: true,
    skipDownload: true,
  });

  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  let info = parsed;
  if (info.entries?.length) info = info.entries[0];
  if (!info?.webpage_url && !info?.url) throw new Error("no result");

  return {
    title: info.title ?? "unknown",
    url: info.webpage_url ?? info.original_url ?? info.url,
    duration: info.duration ?? 0,
    thumbnail: info.thumbnail ?? null,
    requestedBy: requestedBy ?? null,
  };
}

function advance(guildId) {
  const q = queues.get(guildId);
  if (!q) return;

  killChild(q);

  const wasSkipped = q.skipping;
  q.skipping = false;

  let nextTrack = null;
  if (q.nowPlaying && q.loop === "track" && !wasSkipped) {
    nextTrack = q.nowPlaying;
  } else {
    if (q.nowPlaying) {
      pushHistory(q, q.nowPlaying);
      if (q.loop === "queue") {
        q.tracks.push(q.nowPlaying);
      }
    }
    nextTrack = q.tracks.shift() ?? null;
  }

  if (!nextTrack) {
    q.nowPlaying = null;
    return;
  }

  const child = youtubeDl.exec(nextTrack.url, {
    ...YT_FLAGS,
    output: "-",
    format: "bestaudio/best",
    quiet: true,
  });

  child.on("error", (err) => console.error(`[music] yt-dlp: ${err.message}`));
  child.stderr?.on("data", (d) => {
    const line = d.toString().trim();
    if (line) console.error(`[music] yt-dlp: ${line}`);
  });

  const resource = createAudioResource(child.stdout, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
    metadata: { track: nextTrack },
  });

  resource.volume?.setVolume(q.volume);
  q.nowPlaying = nextTrack;
  q.lastChild = child;

  const st = q.player.state.status;
  if (st === AudioPlayerStatus.Paused || st === AudioPlayerStatus.AutoPaused) {
    q.player.unpause();
  }

  q.player.play(resource);
}

function triggerNext(q, guildId) {
  if (q.player.state.status === AudioPlayerStatus.Idle) {
    advance(guildId);
  } else {
    q.player.stop(true);
  }
}

export function join(guild, voiceChannel) {
  ensureConnection(guild, voiceChannel);
}

export async function play(guild, voiceChannel, query, requestedBy, { next = false } = {}) {
  ensureConnection(guild, voiceChannel);
  const q = getQueue(guild.id);

  const track = await resolveTrack(query, requestedBy);
  if (next) {
    q.tracks.unshift(track);
  } else {
    q.tracks.push(track);
  }

  if (q.player.state.status === AudioPlayerStatus.Idle) {
    advance(guild.id);
  }

  return { track, position: next ? 1 : q.tracks.length, playingNow: q.nowPlaying === track };
}

export function skip(guildId) {
  const q = queues.get(guildId);
  if (!q?.nowPlaying) return null;
  const skipped = q.nowPlaying;
  q.skipping = true;
  triggerNext(q, guildId);
  return skipped;
}

export function previous(guildId) {
  const q = queues.get(guildId);
  if (!q || !q.history.length) return null;

  const prev = q.history.pop();
  if (q.nowPlaying) {
    q.tracks.unshift(q.nowPlaying);
    q.nowPlaying = null;
  }
  q.tracks.unshift(prev);
  q.skipping = true;
  triggerNext(q, guildId);
  return prev;
}

export function replay(guildId) {
  const q = queues.get(guildId);
  if (!q?.nowPlaying) return null;

  const current = q.nowPlaying;
  q.tracks.unshift(current);
  q.nowPlaying = null;
  q.skipping = true;
  triggerNext(q, guildId);
  return current;
}

export function stop(guildId) {
  const q = queues.get(guildId);
  if (!q) return false;
  const hadActivity = Boolean(q.nowPlaying || q.tracks.length);
  q.tracks.length = 0;
  q.nowPlaying = null;
  killChild(q);
  if (q.player.state.status !== AudioPlayerStatus.Idle) {
    q.player.stop(true);
  }
  return hadActivity;
}

export function pause(guildId) {
  return queues.get(guildId)?.player.pause(true) ?? false;
}

export function resume(guildId) {
  return queues.get(guildId)?.player.unpause() ?? false;
}

export function setVolume(guildId, percent) {
  const q = queues.get(guildId);
  if (!q) return null;
  const clamped = Math.round(Math.min(200, Math.max(0, percent)));
  q.volume = clamped / 100;
  const resource = q.player.state.resource;
  resource?.volume?.setVolume(q.volume);
  return clamped;
}

export function setLoop(guildId, mode) {
  const q = queues.get(guildId);
  if (!q) return null;
  if (!["off", "track", "queue"].includes(mode)) return null;
  q.loop = mode;
  return mode;
}

export function shuffle(guildId) {
  const q = queues.get(guildId);
  if (!q || q.tracks.length < 2) return 0;
  for (let i = q.tracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [q.tracks[i], q.tracks[j]] = [q.tracks[j], q.tracks[i]];
  }
  return q.tracks.length;
}

export function removeTrack(guildId, position) {
  const q = queues.get(guildId);
  if (!q || position < 1 || position > q.tracks.length) return null;
  return q.tracks.splice(position - 1, 1)[0];
}

export function moveTrack(guildId, from, to) {
  const q = queues.get(guildId);
  if (!q || from < 1 || from > q.tracks.length || to < 1 || to > q.tracks.length) {
    return null;
  }
  const [track] = q.tracks.splice(from - 1, 1);
  q.tracks.splice(to - 1, 0, track);
  return track;
}

export function clearQueue(guildId) {
  const q = queues.get(guildId);
  if (!q) return 0;
  const count = q.tracks.length;
  q.tracks.length = 0;
  return count;
}

export function leave(guildId) {
  const connection = getVoiceConnection(guildId);
  connection?.destroy();
  const q = queues.get(guildId);
  if (q) {
    q.tracks.length = 0;
    q.nowPlaying = null;
    q.player.stop(true);
    killChild(q);
    queues.delete(guildId);
  }
  return Boolean(connection || q);
}

export function status(guildId) {
  const q = queues.get(guildId);
  if (!q?.nowPlaying) return null;
  const state = q.player.state;
  const elapsedMs = "playbackDuration" in state ? state.playbackDuration : 0;
  return {
    nowPlaying: q.nowPlaying,
    tracks: [...q.tracks],
    queued: q.tracks.length,
    historyCount: q.history.length,
    volume: q.volume,
    loop: q.loop,
    paused: state.status === AudioPlayerStatus.Paused || state.status === AudioPlayerStatus.AutoPaused,
    elapsedSeconds: Math.floor(elapsedMs / 1000),
    channelId: q.connection?.joinConfig?.channelId ?? null,
  };
}
