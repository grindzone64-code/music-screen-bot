import "./env.js";
import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { config } from "./env.js";
import * as music from "./music.js";
import {
  buildHelpMessage,
  buildPlayerMessage,
  buildQueueMessage,
  fmtTrack,
} from "./ui.js";

const PROGRESS_INTERVAL_MS = 5000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Active live player controller message + refresh timer per guild
const controllers = new Map();

function stopTimer(ctrl) {
  if (ctrl?.timer) {
    clearInterval(ctrl.timer);
    ctrl.timer = null;
  }
}

function syncTimer(guildId, snap) {
  const ctrl = controllers.get(guildId);
  if (!ctrl) return;
  if (!snap || snap.ended || snap.paused) {
    stopTimer(ctrl);
    return;
  }
  if (!ctrl.timer) {
    ctrl.timer = setInterval(() => {
      refreshPlayer(guildId).catch(() => {});
    }, PROGRESS_INTERVAL_MS);
  }
}

function setController(guildId, message, snap) {
  const prev = controllers.get(guildId);
  stopTimer(prev);
  const ctrl = { message, timer: null };
  controllers.set(guildId, ctrl);
  syncTimer(guildId, snap);
}

async function refreshPlayer(guildId) {
  const ctrl = controllers.get(guildId);
  if (!ctrl?.message) return;

  const snap = music.playerSnapshot(guildId);
  if (!snap) {
    stopTimer(ctrl);
    return;
  }

  syncTimer(guildId, snap);
  try {
    await ctrl.message.edit(buildPlayerMessage(snap));
  } catch {
    stopTimer(ctrl);
    controllers.delete(guildId);
  }
}

music.onStateChange((guildId) => refreshPlayer(guildId));

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
  new SlashCommandBuilder().setName("nowplaying").setDescription("Show the interactive player card"),
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
    const snap = music.playerSnapshot(interaction.guildId);
    const msg = await interaction.editReply(buildPlayerMessage(snap));
    setController(interaction.guildId, msg, snap);
  } else {
    await interaction.editReply(`Queued (#${result.position}) ${fmtTrack(result.track)}`);
  }
}

const commandHandlers = {
  async help(interaction) {
    await interaction.reply(buildHelpMessage());
  },

  async join(interaction) {
    const voiceChannel = await requireVoiceChannel(interaction);
    if (!voiceChannel) return;
    music.join(interaction.guild, voiceChannel);
    await interaction.reply(`Joined **${voiceChannel.name}**.`);
  },

  async leave(interaction) {
    const before = music.playerSnapshot(interaction.guildId);
    const left = music.leave(interaction.guildId);
    const ctrl = controllers.get(interaction.guildId);
    if (ctrl?.message && before) {
      stopTimer(ctrl);
      await ctrl.message
        .edit(buildPlayerMessage({ ...before, ended: true, paused: false, queued: 0, tracks: [] }))
        .catch(() => {});
      controllers.delete(interaction.guildId);
    }
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
    const snap = music.playerSnapshot(interaction.guildId);
    if (!snap) return interaction.reply("Nothing is playing.");
    await interaction.reply(buildPlayerMessage(snap));
    const msg = await interaction.fetchReply();
    setController(interaction.guildId, msg, snap);
  },

  async queue(interaction) {
    const st = music.status(interaction.guildId);
    if (!st) return interaction.reply("Queue is empty.");
    const page = interaction.options.getInteger("page") ?? 1;
    await interaction.reply(buildQueueMessage(st, page));
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

async function handleButton(interaction) {
  const guildId = interaction.guildId;
  if (interaction.customId === "music:queue") {
    const st = music.status(guildId);
    if (!st) {
      await interaction.reply({ content: "Queue is empty.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({
      ...buildQueueMessage(st, 1),
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  const voiceChannel = await requireVoiceChannel(interaction);
  if (!voiceChannel) return;

  if (interaction.customId === "music:add") {
    const modal = new ModalBuilder()
      .setCustomId("music:add_modal")
      .setTitle("Add Track to Queue")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("query")
            .setLabel("Song name or YouTube URL")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. Radhimaa")
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  switch (interaction.customId) {
    case "music:shuffle":
      music.shuffle(guildId);
      break;
    case "music:previous":
      music.previous(guildId);
      break;
    case "music:pause_resume":
      music.togglePause(guildId);
      break;
    case "music:skip":
      music.skip(guildId);
      break;
    case "music:loop":
      music.cycleLoop(guildId);
      break;
    case "music:replay":
      music.replay(guildId);
      break;
    case "music:stop":
      music.stop(guildId);
      break;
    default:
      return;
  }

  const snap = music.playerSnapshot(guildId);
  if (!snap) {
    await interaction.reply({ content: "No active track.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.update(buildPlayerMessage(snap));
  setController(guildId, interaction.message, snap);
}

async function handleSelectMenu(interaction) {
  if (interaction.customId !== "music:menu") return;
  const choice = interaction.values[0];
  const guildId = interaction.guildId;

  if (choice === "view_queue") {
    const st = music.status(guildId);
    if (!st) {
      await interaction.reply({ content: "Queue is empty.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ ...buildQueueMessage(st, 1), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  const voiceChannel = await requireVoiceChannel(interaction);
  if (!voiceChannel) return;

  const currentSt = music.status(guildId);
  if (choice === "leave") {
    const before = music.playerSnapshot(guildId);
    music.leave(guildId);
    const ctrl = controllers.get(guildId);
    stopTimer(ctrl);
    controllers.delete(guildId);
    if (before) {
      await interaction.update(
        buildPlayerMessage({ ...before, ended: true, paused: false, queued: 0, tracks: [] }),
      );
    } else {
      await interaction.reply({ content: "Disconnected.", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (choice === "vol_down") {
    const pct = Math.round((currentSt?.volume ?? 1) * 100) - 20;
    music.setVolume(guildId, pct);
  } else if (choice === "vol_up") {
    const pct = Math.round((currentSt?.volume ?? 1) * 100) + 20;
    music.setVolume(guildId, pct);
  } else if (choice === "vol_reset") {
    music.setVolume(guildId, 100);
  } else if (choice === "loop_cycle") {
    music.cycleLoop(guildId);
  } else if (choice === "clear_queue") {
    music.clearQueue(guildId);
  }

  const snap = music.playerSnapshot(guildId);
  if (!snap) {
    await interaction.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.update(buildPlayerMessage(snap));
  setController(guildId, interaction.message, snap);
}

async function handleModal(interaction) {
  if (interaction.customId !== "music:add_modal") return;
  const voiceChannel = await requireVoiceChannel(interaction);
  if (!voiceChannel) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const query = interaction.fields.getTextInputValue("query");
  const result = await music.play(interaction.guild, voiceChannel, query, interaction.user.id);
  await interaction.editReply(
    result.playingNow
      ? `Playing ${fmtTrack(result.track)}`
      : `Queued (#${result.position}) ${fmtTrack(result.track)}`,
  );
  await refreshPlayer(interaction.guildId);
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inGuild()) return;

  try {
    if (interaction.isChatInputCommand()) {
      const handler = commandHandlers[interaction.commandName];
      if (handler) await handler(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith("music:")) {
      await handleButton(interaction);
    } else if (interaction.isStringSelectMenu() && interaction.customId === "music:menu") {
      await handleSelectMenu(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId === "music:add_modal") {
      await handleModal(interaction);
    }
  } catch (err) {
    console.error(`[interaction] ${err.message}`);
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
