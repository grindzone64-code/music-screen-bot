# music-screen-bot

Discord music bot with slash commands (`discord.js` + `@discordjs/voice` + `yt-dlp`).

## Requirements

- Node.js >= 22.12
- FFmpeg — bundled via `ffmpeg-static`
- yt-dlp — downloaded automatically by `youtube-dl-exec` at install
- A Discord bot token (Discord Developer Portal, with `applications.commands` + `bot` scopes and Connect + Speak voice permissions)

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and set `DISCORD_TOKEN` (and optionally `YOUTUBE_COOKIES` if hosting on a cloud provider like Railway where YouTube blocks server IPs)
3. Invite the bot to your server with `bot` and `applications.commands` scopes
4. `npm start`
5. In a voice channel, run `/play <query>`

## Commands

| Command | Action |
|---|---|
| `/play <query>` | Queue a track (YouTube search or URL) |
| `/playnext <query>` | Add a track to the front of the queue |
| `/skip` / `/previous` | Skip current track / play previous track |
| `/replay` | Restart the current track |
| `/pause` / `/resume` / `/stop` | Pause, resume, or stop and clear queue |
| `/nowplaying` | Show details and progress for the current track |
| `/queue [page]` | Show the current track and upcoming queue |
| `/loop <off\|track\|queue>` | Set repeat mode |
| `/shuffle` / `/clear` | Shuffle or clear upcoming tracks |
| `/remove <position>` / `/move <from> <to>` | Remove or reorder a queued track |
| `/volume <0-200>` | Adjust playback volume |
| `/join` / `/leave` | Join or leave your voice channel |
| `/status` / `/help` | Show player status or command list |
