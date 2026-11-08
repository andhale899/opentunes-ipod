# AI assistant

An optional tab (Assistant, on a real or practice iPod) where a language model proposes tidy-ups for the library: fix spelling and casing, change a track's kind, or build a new playlist. It is off until you turn it on, and it is the only part of OpenTunes that sends anything off your computer.

The model only proposes. It has no access to the iPod, and nothing it says is applied until you tick it and press Apply.

The same key, provider and opt-in are also used by "Ask AI to review" in Library, Find duplicates (see [Reviewing duplicates](#reviewing-duplicates)). Those are the only two places OpenTunes sends anything off your computer.

## What is sent

Only when you press Ask, and only after you tick the box that says: "Send my library's titles, artists, albums and genres (no audio, no file paths) to `<host>` when I ask the assistant something." The host is shown in the sentence: `api.anthropic.com`, or the host of the address you typed.

What goes in the request:

- The assistant's instructions (`app/src/ai/prompt.ts`) and the tool definitions (`app/src/ai/schema.ts`).
- One line per track: a number the app made up, the kind (music, podcast, audiobook, movie ...), title, artist, album, genre, year and track number. For example `17|music|Title|Artist|Album|Genre|2011|track 3`. Fields are cut at 60 characters.
- What you typed, and the last four things you asked in this tab, each with a one-line note of what came of it (for example "I proposed 3 edits."). Earlier library lists are not sent again.
- The model name.

What is never sent: audio, artwork, file paths, file sizes, durations, play counts, the iPod's name, serial number or FireWire ID, the names of your playlists, or anything else on your computer. A test (`app/test/ai/digest.test.ts`) checks the digest holds no path or size.

The line "This request would send N tracks (about T tokens ...)" above the Ask button tells you the size before you send. Tokens are estimated as one per four characters, so it is a guide, not what the service counts or bills.

A library of more than 1,500 tracks is not sent in one go. The tab says so and asks you to either filter by a word (artist, album, genre) or ask one part of 1,500 at a time. The assistant only sees what you picked.

The text of your library goes to a service you choose, under that service's own terms. Read them before turning this on.

## Where it goes

The page calls the service directly with `fetch`. There is no OpenTunes server in between, and nothing is logged anywhere by the app.

- **Anthropic:** `POST https://api.anthropic.com/v1/messages`, with the key in the `x-api-key` header and `anthropic-dangerous-direct-browser-access: true`, which Anthropic requires for calls from a web page. Default model `claude-sonnet-5-5`. `claude-haiku-5-5` is cheaper and fine for simple tidy-ups. The model name is a text box, so any model the key may use can be typed.
- **Any OpenAI-style endpoint:** `POST {base address}/chat/completions` with the key as `Authorization: Bearer`. The default base address is `https://api.openai.com/v1`. Local models work too (an `http://localhost` address is allowed). The address may not hold a user name, password, `?` or `#` part, so a key cannot end up in a URL.

Some endpoints do not allow calls from a web page (a browser CORS block). This app has no server to relay them, so those cannot be used. The tab says so when the connection fails.

Both providers are asked to answer by calling a tool (forced tool use). If an endpoint says it does not take tools, the app asks once more for the same answer as JSON text. A Stop button cancels a request that is waiting.

## What is stored

- **The key:** in this page's memory only, and gone when the tab closes. The key box is never filled back in, and the page never shows the key again. If you tick "Remember the key in this browser", it is also saved in this browser's local storage (`opentunes.ai.key.anthropic` and `opentunes.ai.key.openai`), and anyone who can use this browser profile can read it. "Forget the key" removes it from memory and storage.
- **Settings:** the service, model names, base address and the Remember tick are saved in local storage (`opentunes.ai.settings`). None of these is secret.
- **The opt-in box:** never saved. It starts off every time the page loads.
- **The conversation and proposals:** in memory for as long as the page is open, so switching tabs and back keeps them. A reload clears them.

If local storage is blocked, the settings simply are not saved.

## How to turn it off

Do nothing: it starts off. If you ticked the box, untick it, or reload the page. To remove a saved key press "Forget the key", or clear this site's data in Chrome. Nothing is sent unless the box is ticked and you press Ask. Closing the tab, or leaving the Assistant tab while a request waits, cancels the request.

## What it can and cannot change

The model can ask for three things:

| Tool | What it does |
| --- | --- |
| `propose_edits` | Change title, artist, album, album artist, genre, year or track number of existing tracks, and switch an audio track between music, audiobook and podcast. |
| `propose_playlists` | Make new playlists from existing tracks. |
| `answer` | Answer a question in text. Changes nothing. |

Every answer goes through a hand-written check (`validateProposals` in `app/src/ai/schema.ts`) before you see it. It drops, and lists under "N things ... were left out":

- ids that were not in the list sent, and ids that are not whole numbers;
- fields the engine cannot edit or that describe the file (size, path, length, play counts, ratings ...);
- kinds other than music, audiobook and podcast, and any kind change on a video;
- values of the wrong type or range (year 1000 to 2100, track 1 to 999, text up to 200 characters, a title may not be empty);
- a second change to the same track, edits beyond 500 and playlists beyond 10 in one answer, playlists over 1,000 tracks;
- a playlist whose name is already taken. Existing playlists cannot be renamed, changed or deleted by the assistant. Deleting tracks is not possible at all.

Changes that do nothing (a value the track already has) are dropped too.

## How a change is applied

1. The preview lists each change on its own row, ticked, with before and after and the model's reason. You untick what you do not want.
2. "Apply selected" is disabled until a complete backup exists (the same backup gate as the Library tab).
3. The click first asks Chrome for permission to change the iPod, then builds `TrackEdit[]` and `PlaylistChange[]` from the ticked rows (`app/src/ai/apply.ts`). A last check refuses any playlist action but "create" and any field outside the allowed list.
4. The engine plans the change in memory (`planPlaylistChanges`, `planEdits`) and the tab shows the plan. Then `changePlaylists` and `editTracks` write it, one run per kind of change, playlists first. Each run reads the iPod back, verifies it, and puts the files back if anything is off.
5. The library is read again. A proposal made before a change cannot be applied afterwards: ask again.

## Reviewing duplicates

Library, Find duplicates finds songs that are on the iPod more than once with plain code (no AI): same normalised artist and title, a length within 4 seconds or 3 percent, versions such as live and remix kept apart. Titles and artists that are spelled slightly differently (a typo, "feat." without brackets, bracket text) are only held back as candidates. The AI is optional and only looks at these groups.

It uses the Assistant tab's provider, model, key and opt-in tick box. There is no second key box. If no key is set the tab says so and points to the Assistant tab. The opt-in box in this tab is the same switch: ticking it here ticks it there, it is never saved and it starts off every time the page loads.

What is sent when you press "Ask AI to review": the duplicate prompt (`DUPLICATES_PROMPT` in `app/src/ai/prompt.ts`), the one tool definition (`review_duplicates` in `app/src/ai/schema.ts`), and for each candidate group a line `group <id> (how it was found)`, then one line per track: `id|kind|title|artist|album|year|seconds|kbps` with an id made up for the request. Fuzzy candidates add a line naming which pairs looked alike (for example `similar pairs: 3~4`). Fields are cut at 60 characters, and `|`, `<` and `>` are taken out.

Never sent: audio, artwork, file paths, file sizes, play counts, ratings, the names of your playlists, the iPod's name, serial number or FireWire ID, and any track that is not in a candidate group. The tab shows "This request would send N groups (M tracks, about T tokens of text) to `<host>`" before you press the button. At most 150 groups go in one request, least certain first, and the tab says how many wait. A test (`app/test/ai/review.test.ts`) checks the text holds no path, size or name from outside a group.

The model answers with `review_duplicates`: for each group id one verdict, `duplicate`, `different-versions` or `unsure`, an optional `keep` (a track id from that group, only with `duplicate`) and a short reason. `validateReview` drops, and lists under "N things the AI said were left out": group ids that were not sent, a second verdict on one group, any other verdict word, a `keep` that is not in the group or that comes with another verdict, fields that are not part of a verdict, other tools, and a plain-text answer. A group with no verdict stays as it was.

The verdict and reason show on each group. "Apply the AI's verdicts" changes tick boxes and nothing else: `duplicate` ticks the other copies (and moves the keep choice if the AI named one in the group), `different-versions` and `unsure` untick the group. The fuzzy candidates appear only after the AI has given a verdict on them, and are never ticked on their own. Nothing is removed until you press "Remove ticked duplicates", which plans the removal, shows it, and writes behind the backup gate like the Library tab.

## Prompt injection

Titles, artists and albums are text from files and tags, and can contain words that look like instructions. The system prompt tells the model the list is data, not instructions. The list also has angle brackets and `|` taken out of every field, so a title cannot close the `<library>` block. This lowers the risk but is not proof against a determined model. The real protection is that the model cannot do anything itself: whatever it says goes through the checks above and your tick boxes, and an edit can only touch the fields listed.

## Tested, and not tested

Tested (see the changelog for how): the duplicate finder, its keep score and playlist steps, the duplicate digest, the `review_duplicates` validator and its request (Anthropic and OpenAI-style, JSON fallback, with a fake `fetch`), the digest, the checks, request shapes, headers and tool definitions for both providers, error messages (wrong key, rate limit, bad request, network failure, abort), that the key never appears in a thrown message even when the service echoes it, the JSON fallback, saving and forgetting settings, and the whole tab in headless Chrome on a practice iPod with `fetch` replaced by a fake model.

Not tested: a real call to any service (the build had no key and made none), how well any real model follows the instructions or how good its proposals are, an endpoint that really blocks browser calls, or apply on the owner's real iPod. The practice iPod is held in memory. Field changes and new playlists are the same engine code as the Library tab, which has not yet been run on the owner's iPod either.

## Choosing a service

The Service box lists ready-made choices. The assistant starts on a free one, **Groq (free tier)**, with its address and a model already filled in. You still paste your own key (each free service gives one with no card): the app cannot ship a shared key, because anyone could take it from the page and use it up.

| Choice | Cost | Notes |
| --- | --- | --- |
| Groq | free tier | About 8,000 tokens a minute on the free plan, so the assistant sends about 100 tracks at a time. |
| OpenRouter | free models | Models whose names end in `:free`. About 20 requests a minute, 50 a day. The free list changes often: load it and pick one. |
| Google Gemini | free tier | Key from AI Studio. On the free tier Google may use what you send to improve its products. |
| Ollama | free, on your computer | Nothing leaves your computer. Start Ollama with `OLLAMA_ORIGINS` set to the page's address, and use a model that supports tools. |
| Anthropic (Claude), OpenAI | paid | Best at the structured steps. |
| Any other OpenAI-style address | depends | Type the address and the model name. |

Limits and prices of free tiers change, and they are from public comparisons read on 2026-11-07, not tested with this app. Free models follow the structured steps less reliably, so expect more proposals to be dropped. Whatever you choose, nothing is sent until you tick the opt-in box, and it shows which host will receive the titles, artists, albums and genres.

Not tested: a real call to any service (the build had no key and made none), how well any real model follows the instructions, how good its proposals are or how well it judges duplicate groups (the verdicts in the headless Chrome run came from a fake model), an endpoint that really blocks browser calls, or apply on the owner's real iPod. The practice iPod is held in memory. Field changes and new playlists are the same engine code as the Library tab, which has not yet been run on the owner's iPod either.
