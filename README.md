<img src="src/web/public/negev.png" alt="Negev" width="160">

# Negev

A self-hosted anime request app for series and films.

Browse anime, request a season or film, and follow new episodes as they air. Negev connects Prowlarr and qBittorrent for downloads, Shoko for identification, and Plex for playback availability.

## What it does

- Search anime and browse seasonal and airing titles.
- Pick releases yourself or let Negev choose.
- Track requests from download to playable in Plex.
- Invite users and manage accounts.

## Get started

Start with the [Docker setup](docs/setup.md#quick-start). The example runs search and requests with downloads off. Enable Plex availability and acquisition when your providers and storage paths are configured.

- [Setup and settings](docs/setup.md)
- [How it works](docs/how-it-works.md)
- [Recovery and troubleshooting](docs/acquisition-recovery.md)
- [Release notes](docs/releases)

## Development

Use Node.js 24 and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm test
```

Keep credentials, databases and media outside Git. See the [development notes](docs/how-it-works.md#development) for more detail.
