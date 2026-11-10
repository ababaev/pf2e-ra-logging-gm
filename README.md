# pf2e-ra-logging-gm

A small program for the server that runs Foundry VTT. It does two things:

1. **It keeps a GM online all the time.** A hidden browser on the server logs into the world as a user called **Server GM**. Things that only work when a GM is connected, like PF2e item transfers between characters or Item Piles, keep working while you're away.
2. **It writes an inventory log.** Every time an item appears, disappears or its quantity changes (money included), it writes down who did it, when, and the old → new amount.

You don't install anything into Foundry or into your worlds. Everything runs on the server next to Foundry.

---

## Before you start

You need:

- SSH access to the server, and permission to use `sudo`.
- Foundry already running under **pm2** as the Linux user **`foundry`**, with the pm2 app named **`foundry`**. Your current daily world-switch script already works this way.
- `node` version 18 or newer, plus `jq` and `curl`. Check by running these on the server:

  ```bash
  sudo -iu foundry node -v     # must print v18 or higher
  jq --version                 # if "command not found": sudo apt install jq
  curl --version               # if "command not found": sudo apt install curl
  ```

Everywhere below, the program lives in **`/home/foundry/pf2e-ra-logging-gm`**. Lines starting with `#` inside the code blocks are comments; you don't type them.

---

## Step 1. Create the "Server GM" user in every world (in the browser)

Do this **in each of these worlds**: abomination-vault, secrets-of-grayce, rusthenge, seven-dooms-of-sandpoint.

1. Open the world in Foundry as yourself (the Gamemaster).
2. Go to **Game Settings → User Management → Create User**.
3. Fill in:
   - **Name:** `Server GM` (exactly like this, with the space)
   - **Role:** **Assistant GameMaster**
   - **Password:** make up a long random password. **Use the same password in every world.** Save it somewhere; you'll need it in step 4.
   - **Character:** leave empty.
4. Save.

> Why Assistant GameMaster and not Gamemaster: when you're online yourself, Foundry picks you (the full GM) to do GM work, so prompts still appear on your screen. When you leave, the bot takes over.

---

## Step 2. Copy the files to the server

Pick **one** of these.

**A. With git**, if the server can access the GitHub repo:

```bash
sudo -iu foundry
cd ~
git clone git@github.com:ababaev/pf2e-ra-logging-gm.git     # creates ~/pf2e-ra-logging-gm
exit
```

**B. From your own computer**, by copying the folder:

```bash
# run this on YOUR computer, in the folder that contains this README
scp action-logger.js ecosystem.config.cjs foundry-daily-world.sh gm-bot.mjs package.json report.sh  you@your-server:/tmp/
```

Then on the server:

```bash
sudo mkdir -p /home/foundry/pf2e-ra-logging-gm
sudo mv /tmp/{action-logger.js,ecosystem.config.cjs,foundry-daily-world.sh,gm-bot.mjs,package.json,report.sh} /home/foundry/pf2e-ra-logging-gm/
sudo chown -R foundry:foundry /home/foundry/pf2e-ra-logging-gm
sudo chmod +x /home/foundry/pf2e-ra-logging-gm/report.sh /home/foundry/pf2e-ra-logging-gm/foundry-daily-world.sh
```

Check: `ls /home/foundry/pf2e-ra-logging-gm` should list `gm-bot.mjs`, `action-logger.js`, `report.sh` and the rest.

---

## Step 3. Install it

```bash
sudo -iu foundry                                   # become the foundry user
cd ~/pf2e-ra-logging-gm
npm install                                        # downloads Playwright (the browser driver)
npx playwright install chromium --only-shell       # downloads the hidden browser (~100 MB)
exit                                               # back to your own user
```

Then, once, install the system libraries the browser needs:

```bash
sudo bash -c 'cd /home/foundry/pf2e-ra-logging-gm && npx playwright install-deps chromium'
```

---

## Step 4. Save the Server GM password

```bash
sudo -iu foundry
mkdir -p ~/.config/foundry-gm && chmod 700 ~/.config/foundry-gm
read -rsp 'Server GM password: ' P && printf '%s' "$P" > ~/.config/foundry-gm/password && unset P && echo
chmod 600 ~/.config/foundry-gm/password
exit
```

When it asks `Server GM password:`, paste the password from step 1 and press Enter. **You won't see anything while typing.** That's normal.

The password ends up in `/home/foundry/.config/foundry-gm/password`, readable only by the `foundry` user.

---

## Step 5. Check the settings

Open `/home/foundry/pf2e-ra-logging-gm/ecosystem.config.cjs` and check these lines:

| Setting | Default | Change it if... |
|---|---|---|
| `FOUNDRY_URL` | `http://127.0.0.1:30000` | Foundry uses a different port (see `port` in `/home/foundry/foundrydata/Config/options.json`), a `routePrefix` (e.g. `http://127.0.0.1:30000/foundry`), or its own HTTPS certificate (`sslCert` set in options.json; then use `https://`). |
| `GM_USER` | `Server GM` | You named the user differently in step 1. |
| `TZ` | `Europe/Berlin` | You want log timestamps in another time zone. |
| `LOG_RETENTION_DAYS` | `90` | You want to keep logs for a longer or shorter time. |

Use the local address (`127.0.0.1`), not your public website address.

---

## Step 6. Start it

Foundry must be running with a world loaded. Then:

```bash
sudo -iu foundry
cd ~/pf2e-ra-logging-gm
pm2 start ecosystem.config.cjs     # starts the bot
pm2 save                           # makes pm2 start it again after a server reboot
pm2 logs foundry-gm --lines 30     # watch what it does; press Ctrl+C to stop watching
```

**It worked** if you see lines like:

```
Joined "secrets-of-grayce" as "Server GM" (...)
Action log → /home/foundry/pf2e-ra-logging-gm/logs: logger started in "secrets-of-grayce" — ...; tracking 412 items
```

In Foundry you'll now see **Server GM** in the player list. That's expected.

If you see something else, check [Troubleshooting](#troubleshooting).

---

## Step 7. Replace your daily world-switch script

`foundry-daily-world.sh` is your existing daily script with two additions:

- After starting Foundry, it waits until the new world has actually loaded, and fails with an error if that takes longer than 3 minutes.
- Then it restarts the bot, so the bot joins the new world.

Everything else is the same. To use it:

1. Find where your current daily script lives. It's the file your cron job runs; `sudo -iu foundry crontab -l` shows it.
2. Make a backup of the old one, e.g. `cp your-script.sh your-script.sh.bak`.
3. Copy `/home/foundry/pf2e-ra-logging-gm/foundry-daily-world.sh` over it, **keeping the same file name and path**, so cron doesn't need changes.
4. Make sure it's executable: `chmod +x your-script.sh`.
5. If you ever change which world runs on which weekday, edit `WORLD_BY_DAY` at the top of that file, as before.

---

## Step 8. Test it

1. Log into Foundry as a player (or ask a player to).
2. On their character, change the number of gold pieces, or add any item.
3. On the server:

   ```bash
   sudo -iu foundry
   cd ~/pf2e-ra-logging-gm
   ./report.sh
   ```

   You should see something like:

   ```
   2026-09-28 21:14:10  [quantity,coins] Vasya changed Item "Gold Pieces" on Valeros: quantity 10 → 110 (+100)
   ```

Done. From now on it runs by itself.

---

## Reading the log

Always run the report from the bot's folder as the `foundry` user:

```bash
sudo -iu foundry
cd ~/pf2e-ra-logging-gm
```

Then:

| Command | Shows |
|---|---|
| `./report.sh` | Today, players only |
| `./report.sh -d yesterday` | Yesterday |
| `./report.sh -d 2026-09-28` | A specific day |
| `./report.sh -d all` | Everything ever logged |
| `./report.sh -u Vasya` | Only one player (not case-sensitive) |
| `./report.sh -t coins` | Only money |
| `./report.sh -w` | Only item lines, without the "→ system.pf2e" request lines |
| `./report.sh -a` | Also what GMs did (you and Server GM) |
| `./report.sh -j \| jq .` | Raw JSON with every detail |

You can combine options: `./report.sh -d all -u Vasya -t coins` shows every money change Vasya ever made.

Long output? Add `| less` at the end and scroll with the arrow keys; press `q` to quit.

Sample output:

```
2026-09-28 21:14:10  [quantity,coins] Vasya changed Item "Gold Pieces" on Valeros: quantity 10 → 110 (+100)
2026-09-28 21:14:30  [item-create] Vasya created Item "Healing Potion (Minor)" on Valeros ×3
2026-09-28 21:15:02  [quantity] Vasya changed Item "Arrows" on Valeros: quantity 40 → 35 (-5)
2026-09-28 21:17:30  Vasya → system.pf2e itemTransfer
2026-09-28 21:17:30  [item-delete] Server GM deleted Item "Longsword" on Valeros ×1
2026-09-28 21:17:30  [item-create] Server GM created Item "Longsword" on Merisiel ×1
```

How to read the last three lines: Vasya gave a longsword from Valeros to Merisiel. In Foundry, a player can't move items between characters directly, so Vasya's client asks a GM to do it (`→ system.pf2e itemTransfer`). The GM (here the bot) then deletes and creates the item. Those two GM lines appear only with `-a`.

The tags in square brackets:

| Tag | Meaning |
|---|---|
| `item-create` | An item appeared: on any character, NPC or loot pile, in the Items sidebar, or together with a newly created actor (an imported NPC, an Item Piles loot pile). |
| `item-delete` | An item was deleted. |
| `quantity` | An item's amount changed. Shows old → new and the difference. |
| `coins` | Added when the item is money. |

The log files are in `/home/foundry/pf2e-ra-logging-gm/logs/`, one file per day (`actions-2026-09-28.jsonl`). Older days are compressed (`.gz`) automatically and deleted after 90 days. `report.sh` reads both kinds, so you never need to open them by hand.

---

## Everyday commands

All as the `foundry` user (`sudo -iu foundry`):

| What | Command |
|---|---|
| Is it running? | `pm2 status` (look for `foundry-gm` → `online`) |
| What is it doing? | `pm2 logs foundry-gm --lines 50` |
| Restart it | `pm2 restart foundry-gm` |
| Stop it | `pm2 stop foundry-gm` |
| Start it again | `pm2 start foundry-gm` |
| After editing `ecosystem.config.cjs` | `cd ~/pf2e-ra-logging-gm && pm2 restart ecosystem.config.cjs --update-env` |
| Update to a new version (git install) | `cd ~/pf2e-ra-logging-gm && git pull && npm install && pm2 restart foundry-gm` |
| Remove it completely | `pm2 delete foundry-gm && pm2 save`, then delete `~/pf2e-ra-logging-gm` and the Server GM user in each world |

You don't need to do anything daily. It recovers by itself after Foundry restarts, world switches, server reboots and browser crashes.

---

## Troubleshooting

Look at `pm2 logs foundry-gm --lines 50` first. Then:

| You see | Fix |
|---|---|
| `No password for "Server GM"` | The password file is missing or empty. Redo step 4. |
| `Join as "Server GM" was rejected ... (wrong password?)` | The password in the file doesn't match the world. Or, in today's world, the user is missing or has a different password. Check step 1 for that world. The bot retries every 5 minutes. |
| `User "Server GM" does not exist in world ...` | `Server GM` doesn't exist in the world that's loaded today. Create it (step 1). On Foundry 14.366+ this shows up as "rejected (wrong password?)" instead. |
| `"Server GM" is not a GM in ...` | In that world, change the user's role to **Assistant GameMaster** (step 1). |
| `/join redirected to ... — is the world running?` | Foundry is up but no world is loaded, or `FOUNDRY_URL` is wrong (step 5). |
| `Check failed: ... ERR_CONNECTION_REFUSED` or a timeout | Foundry isn't running (`pm2 status`), or the port in `FOUNDRY_URL` is wrong. |
| Errors about missing libraries (`libnss3`, `libatk`...) when the browser starts | Run the `sudo ... install-deps` command from step 3. |
| `Executable doesn't exist` | Run `npx playwright install chromium --only-shell` as the `foundry` user, in `~/pf2e-ra-logging-gm`. |
| `./report.sh`: `No action log for ...` | Nothing has been logged that day yet, or the bot isn't running. |
| `./report.sh`: `jq: command not found` | `sudo apt install jq` |
| `./report.sh`: `Permission denied` | `chmod +x ~/pf2e-ra-logging-gm/report.sh` |
| A module's GM automation (e.g. creating loot piles or tokens on the map) doesn't work while only the bot is online | Set `NO_CANVAS: "false"` in `ecosystem.config.cjs` and restart it with `--update-env` (see Everyday commands). |

---

## What it logs, and what it doesn't

- **Logs:**
  - Every time a physical item (weapons, armor, consumables, treasure, coins, containers...) is created or deleted, and every time its quantity changes. This applies to player characters, NPCs, loot actors, tokens on the map and the Items sidebar. Compendiums are ignored. Each line says who did it.
  - Requests players send to the GM (`→ system.pf2e ...`, `→ module.socketlib ...`). These show who asked for an item transfer.
- **Doesn't log** HP, XP, stats, rule elements, other item fields (price, uses, equipped), chat or rolls.
- **Can't prevent anything.** It only records.
- **Gaps:** nothing is logged while the bot is offline, e.g. during the ~1-minute daily restart. Old → new values stay correct afterwards, because each time it starts, the bot re-reads the current amount of every item.

## Technical notes

- **Canvas (`NO_CANVAS`):** by default the bot doesn't draw the map, so it uses little CPU. That's enough for inventory, sheets, item transfers and most module GM requests. With `NO_CANVAS=false`, it draws the map in software at 10 fps, which costs CPU. Foundry 14.365 has a known bug: map-less clients print a console error when a token or wall is deleted, but the deletion works. It's harmless here.
- **Memory:** one browser tab with your world loaded. A big PF2e world takes several hundred MB of RAM. The daily restart keeps it from growing.
- **Security:** the Server GM password is effectively a GM key. Keep it only in the password file. The bot refuses to run without a password, because a passwordless GM account would let any player log in as GM whenever the bot is offline.
- **Foundry versions:** works with the login page of Foundry 14.366+, where the user dropdown became a text field, and with older versions.
