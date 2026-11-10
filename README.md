# foundry-gm-bot

A headless Chromium on the server stays logged into the running world as a GM user ("Server GM"). With it, anything that needs "a GM online" still works when you're away: PF2e item transfers between characters, socketlib/Item Piles GM requests, and so on. The same session writes everything players do to daily JSON-lines files.

- Recovers on its own from server restarts, daily world switches, dropped sockets and crashed tabs.
- Needs no Foundry module. The logger is injected into the bot's own page, so nothing changes in your worlds.
- Uses the Foundry join form, including 14.366+, where the user dropdown became a username field.

## 1. Create the user in every world

Do this in every world the daily script can load (abomination-vault, secrets-of-grayce, rusthenge, seven-dooms-of-sandpoint):

- Go to **Game Settings → User Management → Create User**.
- Name it **`Server GM`** and give it the role **Assistant GameMaster**.
- Give it a long unique password. Use the same name and password in every world.
- Don't assign it a character.

Why Assistant GM: Foundry sends GM-only work to one "active GM" (`game.users.activeGM`) and prefers a full Gamemaster when one is connected. While you're online, your client does the work and any prompts appear on your screen. When you leave, the bot takes over.

## 2. Install (as the `foundry` user, same pm2 as the Foundry app)

```bash
sudo -iu foundry
mkdir -p ~/foundry-gm-bot
tar -xzf foundry-gm-bot.tar.gz -C ~/foundry-gm-bot --strip-components=1
cd ~/foundry-gm-bot
npm install
npx playwright install chromium --only-shell      # headless Chromium → ~/.cache/ms-playwright
exit

# system libraries for Chromium, once, as root:
sudo bash -c 'cd /home/foundry/foundry-gm-bot && npx playwright install-deps chromium'
```

## 3. Password file

```bash
sudo -iu foundry
mkdir -p ~/.config/foundry-gm && chmod 700 ~/.config/foundry-gm
read -rsp 'Server GM password: ' P && printf '%s' "$P" > ~/.config/foundry-gm/password && unset P && echo
chmod 600 ~/.config/foundry-gm/password
```

## 4. Check the config and start

Open `ecosystem.config.cjs` and check `FOUNDRY_URL` (port, routePrefix, https) and `GM_USER`. Then:

```bash
cd ~/foundry-gm-bot
pm2 start ecosystem.config.cjs && pm2 save
pm2 logs foundry-gm --lines 30
```

If it worked, the log shows: `Online as "Server GM" in world "secrets-of-grayce"`.
If the user is missing in the world or the password is wrong, the log says so and the bot retries every 5 minutes.

After you change the config later, apply it with: `pm2 restart ecosystem.config.cjs --update-env`

## 5. Daily world switch

`foundry-daily-world.sh` is your script with two additions. After starting Foundry, it polls `/api/status` until the selected world is actually active, and exits with an error if that doesn't happen within 180 s. Then it restarts `foundry-gm`, so each day starts with a fresh browser in the new world. Everything else is unchanged.

## Reading the log

The logs live at `logs/actions-YYYY-MM-DD.jsonl`. Past days are gzipped, and logs are deleted after `LOG_RETENTION_DAYS` (default 90).

```bash
./report.sh                    # today, players only
./report.sh -w                 # only tagged (suspicious-looking) entries
./report.sh -d yesterday -u Vasya
./report.sh -d all -t coins    # every coin change ever
./report.sh -a                 # include GM + Server GM actions
./report.sh -j | jq .          # raw JSON
```

Sample output:

```
2026-09-28 21:14:03  [hp,hero-points] Vasya updated Actor "Valeros": attributes.hp.value 20 → 35; resources.heroPoints.value 1 → 3
2026-09-28 21:14:10  [quantity,coins] Vasya updated Item "Gold Pieces" on Valeros: quantity 10 → 110
2026-09-28 21:15:42  [rules] Vasya updated Item "Longsword" on Valeros: rules [{"key":"FlatModifier","value":5}] → [...value":50}]
2026-09-28 21:16:01  Vasya chat: [Athletics Check] 1d20+7 = 24 [d20:17] → success (DC 20)
2026-09-28 21:16:05  [chat-delete] Vasya DELETED chat message: [Athletics Check] 1d20+7 = 24 [d20:17] → success (DC 20)
2026-09-28 21:17:30  Vasya → system.pf2e itemTransfer
```

Tags:

| Tag | What it means |
|---|---|
| `hp`, `xp`, `level`, `hero-points`, `focus`, `resources` | That value changed on a character. |
| `build`, `stats` | Ability boosts, skills, saves or proficiencies changed. |
| `quantity`, `coins`, `uses`, `spell-slots`, `price` | Inventory numbers changed. |
| `item-create`, `item-delete` | A physical item appeared on or left a player-owned actor. |
| `rules` | Rule elements were edited. This is the classic PF2e cheat, e.g. a +5 FlatModifier added to a sword. |
| `macro` | A script macro was created or its code changed. |
| `ownership`, `user-role` | Permissions changed. |
| `chat-delete`, `chat-edit` | A chat message was deleted, or its content or roll was rewritten. |
| `roll-html-no-roll` | The message looks like a roll but has no real roll attached. This is a heuristic. |

## What it sees, and what it can't

- **Sees:**
  - Every create, update and delete of any document: sheets, items, coins, HP, tokens, macros, journals, combat. Each entry records who did it. For player-owned characters it also records old → new values.
  - Every chat message and roll: formula, dice, total, and PF2e outcome/DC. Also edits and deletions of messages.
  - Connects and disconnects.
  - Requests players send to the GM over `system.pf2e` and `module.socketlib`.
- **GM-relayed actions:** when a player gives an item to another PC, the GM client executes the transfer. The resulting delete/create is attributed to whichever GM ran it (Server GM or you). The `→ system.pf2e itemTransfer` line just before it shows who asked.
- **Can't prevent anything.** It only records.
- **Can't prove a roll is honest.** Dice are rolled in the player's browser, and someone with console skills can fake one. The log does catch deleted or rewritten roll messages and roll-looking HTML without a real roll. A PF2e reroll (hero point, fortune effects) can legitimately replace or rewrite a roll message; check for a `hero-points` change right before it.
- **Gaps:** nothing is logged while the bot is offline, e.g. during the ~1-minute daily restart. Private whispers between players are logged only if Foundry delivers them to GM clients.

## Canvas (`NO_CANVAS`)

Default `true`: the map isn't rendered and CPU use is low. This is enough for inventory, sheets, chat, item transfers and most module GM requests.

If some GM-side automation that needs the map breaks while only the bot is online, set `NO_CANVAS=false` and restart. An example is a module creating tokens or loot piles on the scene. With the canvas on, the bot renders with software WebGL, capped at 10 fps, which costs CPU.

Foundry 14.365 has a known bug: canvas-less clients throw a console error when a token or wall is deleted, even though the deletion succeeds. It's harmless here.

## Resources and security

- One Chromium tab with your world loaded. A large PF2e world takes several hundred MB of RAM. The daily restart keeps it from growing.
- The Server GM password is effectively a GM key. Keep it only in the password file (chmod 600). The bot refuses to run without a password: a passwordless GM account would let any player log in as GM whenever the bot is offline.
- Players will see "Server GM" in the player list. That's expected.
