# Conservative AniDB release-state inference

**Goal:** Derive an explicit, testable Airing/Completed/Upcoming/Unknown signal from AniDB anime and regular-episode dates. The installed Shoko API date shape still needs a read-only check; do not wire this into request creation yet.

**Source:** Shoko's [AniDB anime v3 model](https://github.com/ShokoAnime/ShokoServer/blob/b06f99922b14b84765a743379b02bdd97ab39817/Shoko.Server/API/v3/Models/AniDB/AnidbAnime.cs) documents `AirDate` and `EndDate` as `yyyy`, `yyyy-MM`, `yyyy-MM-dd`, or null; [regular episodes](https://github.com/ShokoAnime/ShokoServer/blob/b06f99922b14b84765a743379b02bdd97ab39817/Shoko.Server/API/v3/Models/AniDB/AnidbEpisode.cs) expose `AirDate`. Shoko's [release-status source](https://github.com/ShokoAnime/ShokoServer/blob/b06f99922b14b84765a743379b02bdd97ab39817/Shoko.Server/Providers/AniDB/AnidbReleaseStatus.cs) infers finished/releasing from these fields and admits that hiatus and cancellation cannot be distinguished from active release.

**Policy:** Require a valid start date and exact fully enumerated detail. Use the last possible day of a partial date. A future start is upcoming; a past end is completed. A started movie or single-episode work is completed. With a known expected normal-episode count, all listed normal episodes aired means completed. Otherwise treat a started work as airing and mark the result inferred. Invalid or contradictory dates are unknown. The caller supplies the local current date explicitly.

**Tests:** Date precision and calendar validity, past/future end dates, aired episode count, missing start, movie, and malformed inputs. No live requests or production changes.
