import "./env.js";
import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { config } from "./env.js";
import * as music from "./music.js";

const QUEUE_PAGE_SIZE = 10;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Queue a track from YouTube search or URL")
    .addStringOption((opt) =>
      opt.setName("query").setDescription("Song name or URL").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("playnext")
    .setDescription("Add a track to the front of the queue")
    .addStringOption((opt) =>
      opt.setName("query").setDescription("Song name or URL").setRequired(true),
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current track"),
  new SlashCommandBuilder().setName("previous").setDescription("Play the previous track"),
  new SlashCommandBuilder().setName("replay").setDescription("Restart the current track"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop playback and clear the queue"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Show the currently playing track"),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current track and upcoming queue")
    .addIntegerOption((opt) =>
      opt.setName("page").setDescription("Queue page number").setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Set repeat mode")
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("Loop mode")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Track", value: "track" },
          { name: "Queue", value: "queue" },
        ),
    ),
  new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the upcoming queue"),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a track from the queue")
    .addIntegerOption((opt) =>
      opt.setName("position").setDescription("1-based queue position").setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName("move")
    .setDescription("Move a track to another position in the queue")
    .addIntegerOption((opt) =>
      opt.setName("from").setDescription("Current 1-based position").setRequired(true).setMinValue(1),
    )
    .addIntegerOption((opt) =>
      opt.setName("to").setDescription("New 1-based position").setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder().setName("clear").setDescription("Clear upcoming tracks in the queue"),
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set playback volume (0-200%)")
    .addIntegerOption((opt) =>
      opt
        .setName("percent")
        .setDescription("Volume percentage (0-200)")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(200),
    ),
  new SlashCommandBuilder().setName("join").setDescription("Join your voice channel"),
  new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel"),
  new SlashCommandBuilder().setName("status").setDescription("Show player status"),
  new SlashCommandBuilder().setName("help").setDescription("List all music commands"),
];

function fmtDuration(seconds) {
  if (!seconds || seconds <= 0) return "live/unknown";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function fmtTrack(track) {
  const dur = track.duration ? ` (${fmtDuration(track.duration)})` : "";
  const req = track.requestedBy ? ` · <@${track.requestedBy}>` : "";
  return `**${track.title}**${dur}${req}`;
}

async function requireVoiceChannel(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: "Join a voice channel first.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return voiceChannel;
}

async function handleEnqueue(interaction, next) {
  const voiceChannel = await requireVoiceChannel(interaction);
  if (!voiceChannel) return;

  await interaction.deferReply();
  const query = interaction.options.getString("query", true);
  const result = await music.play(interaction.guild, voiceChannel, query, interaction.user.id, {
    next,
  });

  if (result.playingNow) {
    await interaction.editReply(`Playing ${fmtTrack(result.track)}`);
  } else {
    await interaction.editReply(`Queued (#${result.position}) ${fmtTrack(result.track)}`);
  }
}

function buildNowPlayingEmbed(st) {
  const { nowPlaying, elapsedSeconds, volume, loop, paused, queued } = st;
  const progress = nowPlaying.duration
    ? `${fmtDuration(elapsedSeconds)} / ${fmtDuration(nowPlaying.duration)}`
    : fmtDuration(elapsedSeconds);

  const embed = new EmbedBuilder()
    .setColor(paused ? 0xf59e0b : 0x5865f2)
    .setTitle(paused ? "Paused" : "Now Playing")
    .setDescription(`[${nowPlaying.title}](${nowPlaying.url})`)
    .addFields(
      { name: "Progress", value: progress, inline: true },
      { name: "Volume", value: `${Math.round(volume * 100)}%`, inline: true },
      { name: "Loop", value: loop, inline: true },
      { name: "Queued", value: String(queued), inline: true },
    );

  if (nowPlaying.requestedBy) {
    embed.addFields({ name: "Requested by", value: `<@${nowPlaying.requestedBy}>`, inline: true });
  }
  if (nowPlaying.thumbnail) {
    embed.setThumbnail(nowPlaying.thumbnail);
  }
  return embed;
}

function buildQueueEmbed(st, requestedPage) {
  const totalPages = Math.max(1, Math.ceil(st.tracks.length / QUEUE_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * QUEUE_PAGE_SIZE;
  const slice = st.tracks.slice(start, start + QUEUE_PAGE_SIZE);

  const lines = slice.map((track, idx) => `${start + idx + 1}. ${fmtTrack(track)}`);
  const upcoming = lines.length ? lines.join("\n") : "_No upcoming tracks_";

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Music Queue")
    .addFields({
      name: st.paused ? "Now Playing (Paused)" : "Now Playing",
      value: fmtTrack(st.nowPlaying),
    })
    .setDescription(`**Up Next**\n${upcoming}`)
    .setFooter({
      text: `Page ${page}/${totalPages} · ${st.queued} queued · loop: ${st.loop} · vol: ${Math.round(st.volume * 100)}%`,
    });
}

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Music Commands")
    .addFields(
      {
        name: "Playback",
        value: [
          "`/play <query>` — queue a track",
          "`/playnext <query>` — queue a track next",
          "`/pause` · `/resume` · `/replay`",
          "`/skip` · `/previous` · `/stop`",
        ].join("\n"),
      },
      {
        name: "Queue",
        value: [
          "`/nowplaying` — current track details",
          "`/queue [page]` — view upcoming tracks",
          "`/loop <off|track|queue>` — repeat mode",
          "`/shuffle` · `/clear`",
          "`/remove <position>` · `/move <from> <to>`",
        ].join("\n"),
      },
      {
        name: "Voice & Info",
        value: "`/join` · `/leave` · `/volume <0-200>` · `/status` · `/help`",
      },
    );
}

const handlers = {
  async help(interaction) {
    await interaction.reply({ embeds: [buildHelpEmbed()] });
  },

  async join(interaction) {
    const voiceChannel = await requireVoiceChannel(interaction);
    if (!voiceChannel) return;
    music.join(interaction.guild, voiceChannel);
    await interaction.reply(`Joined **${voiceChannel.name}**.`);
  },

  async leave(interaction) {
    const left = music.leave(interaction.guildId);
    await interaction.reply(left ? "Left voice channel." : "Not connected to a voice channel.");
  },

  async play(interaction) {
    await handleEnqueue(interaction, false);
  },

  async playnext(interaction) {
    await handleEnqueue(interaction, true);
  },

  async skip(interaction) {
    const skipped = music.skip(interaction.guildId);
    await interaction.reply(skipped ? `Skipped **${skipped.title}**.` : "Nothing is playing.");
  },

  async previous(interaction) {
    const prev = music.previous(interaction.guildId);
    await interaction.reply(prev ? `Playing previous: ${fmtTrack(prev)}` : "No previous track in history.");
  },

  async replay(interaction) {
    const current = music.replay(interaction.guildId);
    await interaction.reply(current ? `Replaying **${current.title}**.` : "Nothing is playing.");
  },

  async pause(interaction) {
    await interaction.reply(music.pause(interaction.guildId) ? "Paused." : "Nothing is playing.");
  },

  async resume(interaction) {
    await interaction.reply(music.resume(interaction.guildId) ? "Resumed." : "Nothing is paused.");
  },

  async stop(interaction) {
    const stopped = music.stop(interaction.guildId);
    await interaction.reply(stopped ? "Stopped playback and cleared the queue." : "Nothing is playing.");
  },

  async nowplaying(interaction) {
    const st = music.status(interaction.guildId);
    if (!st) return interaction.reply("Nothing is playing.");
    await interaction.reply({ embeds: [buildNowPlayingEmbed(st)] });
  },

  async queue(interaction) {
    const st = music.status(interaction.guildId);
    if (!st) return interaction.reply("Queue is empty.");
    const page = interaction.options.getInteger("page") ?? 1;
    await interaction.reply({ embeds: [buildQueueEmbed(st, page)] });
  },

  async loop(interaction) {
    const mode = interaction.options.getString("mode", true);
    const updated = music.setLoop(interaction.guildId, mode);
    if (!updated) return interaction.reply("Join or play a track first.");
    await interaction.reply(`Loop mode set to **${updated}**.`);
  },

  async shuffle(interaction) {
    const count = music.shuffle(interaction.guildId);
    await interaction.reply(
      count ? `Shuffled **${count}** upcoming tracks.` : "Need at least 2 queued tracks to shuffle.",
    );
  },

  async remove(interaction) {
    const pos = interaction.options.getInteger("position", true);
    const removed = music.removeTrack(interaction.guildId, pos);
    await interaction.reply(
      removed ? `Removed #${pos}: **${removed.title}**.` : `Invalid queue position: ${pos}.`,
    );
  },

  async move(interaction) {
    const from = interaction.options.getInteger("from", true);
    const to = interaction.options.getInteger("to", true);
    const moved = music.moveTrack(interaction.guildId, from, to);
    await interaction.reply(
      moved ? `Moved **${moved.title}** from #${from} to #${to}.` : "Invalid queue positions.",
    );
  },

  async clear(interaction) {
    const count = music.clearQueue(interaction.guildId);
    await interaction.reply(count ? `Cleared **${count}** upcoming tracks.` : "Upcoming queue is already empty.");
  },

  async volume(interaction) {
    const percent = interaction.options.getInteger("percent", true);
    const updated = music.setVolume(interaction.guildId, percent);
    if (updated === null) return interaction.reply("Join or play a track first.");
    await interaction.reply(`Volume set to **${updated}%**.`);
  },

  async status(interaction) {
    const st = music.status(interaction.guildId);
    if (!st) return interaction.reply("Music: idle");
    const stateLabel = st.paused ? "paused" : "playing";
    const channel = st.channelId ? ` in <#${st.channelId}>` : "";
    await interaction.reply(
      `Music (${stateLabel}${channel}): **${st.nowPlaying.title}** · queued: ${st.queued} · loop: ${st.loop} · vol: ${Math.round(st.volume * 100)}%`,
    );
  },
};

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;

  const handler = handlers[interaction.commandName];
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (err) {
    console.error(`[cmd:${interaction.commandName}] ${err.message}`);
    const payload = { content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: `Error: ${err.message}` }).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.once(Events.ClientReady, async (readyClient) => {
  try {
    await readyClient.application.commands.set(commands.map((c) => c.toJSON()));
    console.log(`[bot] ${readyClient.user.tag} online — ${commands.length} slash commands registered`);
  } catch (err) {
    console.error(`[bot] failed to register slash commands: ${err.message}`);
  }
});

if (!config.token) {
  console.error("DISCORD_TOKEN missing in .env");
  process.exit(1);
}

client.login(config.token);
