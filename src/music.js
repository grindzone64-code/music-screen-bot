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
import { config } from "./env.js";

const queues = new Map();
const MAX_HISTORY = 50;
let stateListener = null;

const BASE_YT_FLAGS = {
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
  jsRuntimes: "node",
  remoteComponents: "ejs:github",
};

function buildYtFlags({ useCookies = true, playerClient } = {}) {
  return {
    ...BASE_YT_FLAGS,
    ...(useCookies && config.ytCookiesFile ? { cookies: config.ytCookiesFile } : {}),
    ...(playerClient ? { extractorArgs: `youtube:player_client=${playerClient}` } : {}),
  };
}

export function onStateChange(fn) {
  stateListener = fn;
}

function notify(guildId) {
  if (stateListener) {
    Promise.resolve(stateListener(guildId)).catch((err) => {
      console.error(`[music] state listener: ${err.message}`);
    });
  }
}

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
    lastTrack: null,
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

function parseTrackJson(raw, requestedBy, fallbackSource) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  let info = parsed;
  if (info.entries?.length) info = info.entries[0];
  if (!info?.webpage_url && !info?.url) throw new Error("no result");

  return {
    title: info.title ?? "unknown",
    author: info.uploader ?? info.channel ?? info.artist ?? null,
    url: info.webpage_url ?? info.original_url ?? info.url,
    duration: info.duration ?? 0,
    thumbnail: info.thumbnail ?? null,
    source: info.extractor_key?.toLowerCase().includes("soundcloud") ? "soundcloud" : fallbackSource,
    requestedBy: requestedBy ?? null,
  };
}

function isBotOrCookieError(err) {
  const msg = `${err?.stderr ?? ""} ${err?.message ?? ""}`.toLowerCase();
  return (
    msg.includes("sign in to confirm") ||
    msg.includes("not a bot") ||
    msg.includes("cookies") ||
    msg.includes("http error 403") ||
    msg.includes("429")
  );
}

async function resolveWithTarget(target, flags) {
  return youtubeDl(target, {
    ...flags,
    dumpSingleJson: true,
    skipDownload: true,
  });
}

async function resolveTrack(query, requestedBy) {
  const isUrl = /^https?:\/\//i.test(query);
  const ytTarget = isUrl ? query : `ytsearch1:${query}`;

  try {
    const raw = await resolveWithTarget(ytTarget, buildYtFlags({ useCookies: true }));
    return parseTrackJson(raw, requestedBy, "youtube");
  } catch (err) {
    // If cookies were configured and failed (e.g. expired), retry without cookies using alternate YT client
    if (config.ytCookiesFile && isBotOrCookieError(err)) {
      console.warn("[music] YouTube failed with cookies, retrying without cookies...");
      try {
        const raw = await resolveWithTarget(
          ytTarget,
          buildYtFlags({ useCookies: false, playerClient: "tv_simply,android_vr" }),
        );
        return parseTrackJson(raw, requestedBy, "youtube");
      } catch {}
    }

    // For search queries, fall back to SoundCloud (works on datacenter IPs without cookies)
    if (!isUrl) {
      console.warn(`[music] YouTube resolve failed (${err.message.split("\n")[0]}), falling back to SoundCloud`);
      const raw = await resolveWithTarget(`scsearch1:${query}`, buildYtFlags({ useCookies: false }));
      return parseTrackJson(raw, requestedBy, "soundcloud");
    }

    if (isBotOrCookieError(err)) {
      throw new Error(
        "YouTube blocked this server IP — add/refresh YOUTUBE_COOKIES, or search by song name to use SoundCloud.",
      );
    }
    throw err;
  }
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
    if (q.nowPlaying) q.lastTrack = q.nowPlaying;
    q.nowPlaying = null;
    notify(guildId);
    return;
  }

  const streamFlags = buildYtFlags({ useCookies: nextTrack.source !== "soundcloud" });
  const child = youtubeDl.exec(nextTrack.url, {
    ...streamFlags,
    output: "-",
    format: "bestaudio[acodec=opus]/bestaudio/best",
    quiet: true,
  });

  child.on("error", (err) => console.error(`[music] yt-dlp: ${err.message}`));
  // tinyspawn's child is also a promise; it rejects when we kill it (skip/stop).
  child.catch((err) => {
    if (err?.signalCode === "SIGTERM" || err?.killed) return;
    console.error(`[music] yt-dlp exited: ${err?.exitCode ?? err?.message}`);
  });
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
  q.lastTrack = nextTrack;
  q.lastChild = child;

  const st = q.player.state.status;
  if (st === AudioPlayerStatus.Paused || st === AudioPlayerStatus.AutoPaused) {
    q.player.unpause();
  }

  q.player.play(resource);
  notify(guildId);
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
  } else {
    notify(guild.id);
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
  const target = q?.nowPlaying ?? q?.lastTrack;
  if (!q || !target) return null;

  q.tracks.unshift(target);
  q.nowPlaying = null;
  q.skipping = true;
  triggerNext(q, guildId);
  return target;
}

export function stop(guildId) {
  const q = queues.get(guildId);
  if (!q) return false;
  const hadActivity = Boolean(q.nowPlaying || q.tracks.length);
  if (q.nowPlaying) q.lastTrack = q.nowPlaying;
  q.tracks.length = 0;
  q.nowPlaying = null;
  killChild(q);
  if (q.player.state.status !== AudioPlayerStatus.Idle) {
    q.player.stop(true);
  } else if (hadActivity) {
    notify(guildId);
  }
  return hadActivity;
}

export function pause(guildId) {
  const ok = queues.get(guildId)?.player.pause(true) ?? false;
  if (ok) notify(guildId);
  return ok;
}

export function resume(guildId) {
  const ok = queues.get(guildId)?.player.unpause() ?? false;
  if (ok) notify(guildId);
  return ok;
}

export function togglePause(guildId) {
  const q = queues.get(guildId);
  if (!q?.nowPlaying) return null;
  const st = q.player.state.status;
  if (st === AudioPlayerStatus.Paused || st === AudioPlayerStatus.AutoPaused) {
    q.player.unpause();
    notify(guildId);
    return false;
  }
  q.player.pause(true);
  notify(guildId);
  return true;
}

export function setVolume(guildId, percent) {
  const q = queues.get(guildId);
  if (!q) return null;
  const clamped = Math.round(Math.min(200, Math.max(0, percent)));
  q.volume = clamped / 100;
  const resource = q.player.state.resource;
  resource?.volume?.setVolume(q.volume);
  notify(guildId);
  return clamped;
}

export function setLoop(guildId, mode) {
  const q = queues.get(guildId);
  if (!q) return null;
  if (!["off", "track", "queue"].includes(mode)) return null;
  q.loop = mode;
  notify(guildId);
  return mode;
}

export function cycleLoop(guildId) {
  const q = queues.get(guildId);
  if (!q) return null;
  const order = ["off", "track", "queue"];
  const nextMode = order[(order.indexOf(q.loop) + 1) % order.length];
  q.loop = nextMode;
  notify(guildId);
  return nextMode;
}

export function shuffle(guildId) {
  const q = queues.get(guildId);
  if (!q || q.tracks.length < 2) return 0;
  for (let i = q.tracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [q.tracks[i], q.tracks[j]] = [q.tracks[j], q.tracks[i]];
  }
  notify(guildId);
  return q.tracks.length;
}

export function removeTrack(guildId, position) {
  const q = queues.get(guildId);
  if (!q || position < 1 || position > q.tracks.length) return null;
  const removed = q.tracks.splice(position - 1, 1)[0];
  notify(guildId);
  return removed;
}

export function moveTrack(guildId, from, to) {
  const q = queues.get(guildId);
  if (!q || from < 1 || from > q.tracks.length || to < 1 || to > q.tracks.length) {
    return null;
  }
  const [track] = q.tracks.splice(from - 1, 1);
  q.tracks.splice(to - 1, 0, track);
  notify(guildId);
  return track;
}

export function clearQueue(guildId) {
  const q = queues.get(guildId);
  if (!q) return 0;
  const count = q.tracks.length;
  q.tracks.length = 0;
  if (count) notify(guildId);
  return count;
}

export function leave(guildId) {
  const connection = getVoiceConnection(guildId);
  connection?.destroy();
  const q = queues.get(guildId);
  if (q) {
    if (q.nowPlaying) q.lastTrack = q.nowPlaying;
    q.tracks.length = 0;
    q.nowPlaying = null;
    q.player.stop(true);
    killChild(q);
    notify(guildId);
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
    lastTrack: q.lastTrack,
    tracks: [...q.tracks],
    queued: q.tracks.length,
    historyCount: q.history.length,
    volume: q.volume,
    loop: q.loop,
    paused: state.status === AudioPlayerStatus.Paused || state.status === AudioPlayerStatus.AutoPaused,
    elapsedSeconds: Math.floor(elapsedMs / 1000),
    channelId: q.connection?.joinConfig?.channelId ?? null,
    ended: false,
  };
}

export function playerSnapshot(guildId) {
  const active = status(guildId);
  if (active) return active;

  const q = queues.get(guildId);
  if (!q?.lastTrack) return null;
  return {
    nowPlaying: q.lastTrack,
    lastTrack: q.lastTrack,
    tracks: [],
    queued: 0,
    historyCount: q.history.length,
    volume: q.volume,
    loop: q.loop,
    paused: false,
    elapsedSeconds: q.lastTrack.duration ?? 0,
    channelId: q.connection?.joinConfig?.channelId ?? null,
    ended: true,
  };
}
