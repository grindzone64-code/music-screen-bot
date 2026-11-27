import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";

export const QUEUE_PAGE_SIZE = 10;

export function fmtDuration(seconds) {
  if (!seconds || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
}

export function fmtTrack(track) {
  const dur = track.duration ? ` (${fmtDuration(track.duration)})` : "";
  const req = track.requestedBy ? ` · <@${track.requestedBy}>` : "";
  return `**${track.title}**${dur}${req}`;
}

function renderBar(current, total, width = 18) {
  if (!total || total <= 0) {
    return "━".repeat(width) + "●";
  }
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * width);
  return "━".repeat(filled) + "●" + "─".repeat(width - filled);
}

function renderVolumeBar(volume, width = 10) {
  const pct = Math.min(200, Math.max(0, Math.round(volume * 100)));
  const filled = Math.round((pct / 200) * width);
  return `${"━".repeat(filled)}●${"─".repeat(width - filled)} \`${pct}%\``;
}

export function buildPlayerMessage(snap) {
  const track = snap.nowPlaying;
  const isEnded = snap.ended;
  const isPaused = snap.paused;

  const statusBadge = isEnded ? "`Ended`" : isPaused ? "`Paused`" : "`Playing`";
  const accentColor = isEnded ? 0x4e5058 : isPaused ? 0xf59e0b : 0x5865f2;

  const authorParts = [];
  if (track.author) authorParts.push(track.author);
  if (track.requestedBy) authorParts.push(`requested by <@${track.requestedBy}>`);
  const subtitle = authorParts.length ? authorParts.join(" · ") : "YouTube";

  const safeTitle = track.title.length > 120 ? `${track.title.slice(0, 117)}...` : track.title;
  const headerLines = [
    statusBadge,
    `## [${safeTitle}](${track.url})`,
    `-# ${subtitle}`,
  ].join("\n");

  const container = new ContainerBuilder().setAccentColor(accentColor);

  if (track.thumbnail && /^https?:\/\//i.test(track.thumbnail)) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(track.thumbnail)),
    );
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines));
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );

  const totalLabel = track.duration ? fmtDuration(track.duration) : "LIVE";
  const elapsedLabel = isEnded && track.duration ? totalLabel : fmtDuration(snap.elapsedSeconds);
  const progressBar = track.duration
    ? renderBar(isEnded ? track.duration : snap.elapsedSeconds, track.duration)
    : renderBar(1, 1);

  const metaBits = [`\`${elapsedLabel} / ${totalLabel}\``];
  if (snap.loop !== "off") metaBits.push(`Loop: **${snap.loop}**`);
  if (snap.queued > 0) metaBits.push(`${snap.queued} in queue`);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      [
        metaBits.join(" · "),
        progressBar,
        `🔊 ${renderVolumeBar(snap.volume)}`,
      ].join("\n"),
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music:shuffle")
      .setEmoji("🔀")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isEnded || snap.queued < 2),
    new ButtonBuilder()
      .setCustomId("music:previous")
      .setEmoji("⏮️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(snap.historyCount === 0),
    new ButtonBuilder()
      .setCustomId("music:pause_resume")
      .setEmoji(isPaused ? "▶️" : "⏸️")
      .setStyle(isPaused ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(isEnded),
    new ButtonBuilder()
      .setCustomId("music:skip")
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isEnded),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music:add")
      .setEmoji("➕")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music:loop")
      .setEmoji("🔁")
      .setStyle(snap.loop === "off" ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(isEnded),
    new ButtonBuilder()
      .setCustomId("music:replay")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music:stop")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isEnded),
  );

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("music:menu")
    .setPlaceholder("Select a control")
    .addOptions(
      { label: "View Queue", description: "Show upcoming tracks", value: "view_queue", emoji: "📜" },
      { label: "Volume -20%", description: "Decrease playback volume", value: "vol_down", emoji: "🔉" },
      { label: "Volume +20%", description: "Increase playback volume", value: "vol_up", emoji: "🔊" },
      { label: "Reset Volume (100%)", description: "Restore default volume", value: "vol_reset", emoji: "🎚️" },
      { label: "Cycle Loop Mode", description: "Off → Track → Queue", value: "loop_cycle", emoji: "🔁" },
      { label: "Clear Queue", description: "Remove upcoming tracks", value: "clear_queue", emoji: "🧹" },
      { label: "Disconnect", description: "Leave the voice channel", value: "leave", emoji: "👋" },
    );

  const row3 = new ActionRowBuilder().addComponents(selectMenu);

  container.addActionRowComponents(row1, row2, row3);

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function buildQueueMessage(st, requestedPage = 1) {
  const totalPages = Math.max(1, Math.ceil(st.tracks.length / QUEUE_PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (page - 1) * QUEUE_PAGE_SIZE;
  const slice = st.tracks.slice(start, start + QUEUE_PAGE_SIZE);

  const lines = slice.map((track, idx) => `${start + idx + 1}. ${fmtTrack(track)}`);
  const upcoming = lines.length ? lines.join("\n") : "_No upcoming tracks_";

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### Music Queue\n**${st.paused ? "Paused" : "Now Playing"}:** ${fmtTrack(st.nowPlaying)}`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Up Next**\n${upcoming}\n\n-# Page ${page}/${totalPages} · ${st.queued} queued · loop: ${st.loop} · vol: ${Math.round(st.volume * 100)}%`,
      ),
    );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function buildHelpMessage() {
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          "### Music Commands",
          "**Playback**",
          "`/play <query>` · `/playnext <query>` · `/pause` · `/resume` · `/replay` · `/skip` · `/previous` · `/stop`",
          "**Queue**",
          "`/nowplaying` · `/queue [page]` · `/loop <off|track|queue>` · `/shuffle` · `/clear` · `/remove <pos>` · `/move <from> <to>`",
          "**Voice & Info**",
          "`/join` · `/leave` · `/volume <0-200>` · `/status` · `/help`",
        ].join("\n"),
      ),
    );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}
