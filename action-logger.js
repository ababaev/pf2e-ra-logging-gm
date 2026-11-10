/*
 * Browser-side action logger for the headless Foundry GM.
 *
 * gm-bot.mjs injects this function into the GM's Foundry page once the game is
 * ready. It only OBSERVES: it registers hooks and socket listeners and never
 * modifies any document. Every observation is passed to window.__gmLog(entry),
 * a Playwright binding that appends one JSON line to logs/actions-YYYY-MM-DD.jsonl.
 *
 * Keep this file a single function declaration: gm-bot.mjs evaluates it as
 * `(<this file>)(config)`.
 */
function installActionLogger(cfg) {
  if (globalThis.__gmActionLogger) return "already installed";
  const sink = globalThis.__gmLog;
  if (typeof sink !== "function") return "not installed: __gmLog binding missing";

  const U = foundry.utils;
  const HooksApi = globalThis.foundry?.helpers?.Hooks ?? globalThis.Hooks;
  const MAX_STR = Number(cfg.maxString) || 300;
  const MAX_CHANGES = 40;
  const SUMMARY_CHANGES = 6;
  const ignoreTypes = new Set(cfg.ignoreTypes ?? []);
  const ignorePaths = cfg.ignorePaths ?? [];
  const selfId = game.user.id;
  const world = game.world.id;
  const parser = new DOMParser();

  // ---------------------------------------------------------------- helpers

  const emit = (entry) => {
    try {
      const p = sink({ world, tags: [], ...entry });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (err) {
      console.warn("gm-action-logger: emit failed", err);
    }
  };

  const guard = (fn) => (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.warn("gm-action-logger:", err);
    }
  };

  const who = (userId) => {
    const u = userId ? game.users.get(userId) : null;
    return {
      user: u?.name ?? userId ?? "unknown",
      userId: userId ?? null,
      isGM: u?.isGM === true,
      bot: userId === selfId,
    };
  };

  // Plain text from HTML without loading images or running anything (DOMParser docs are inert).
  const plain = (html, max = MAX_STR) => {
    if (!html) return "";
    let t;
    try {
      t = parser.parseFromString(String(html), "text/html").body.textContent ?? "";
    } catch {
      t = String(html);
    }
    t = t.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };

  // The first heading of a chat flavor, e.g. "Athletics Check" from a PF2e check card.
  const heading = (html) => {
    if (!html) return "";
    try {
      const body = parser.parseFromString(String(html), "text/html").body;
      const h = body.querySelector("h1, h2, h3, h4, strong, b");
      const text = (h ?? body).textContent.replace(/\s+/g, " ").trim();
      return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    } catch {
      return "";
    }
  };

  // JSON-safe, size-limited copy of any value.
  const safe = (v, depth = 0) => {
    if (v === undefined || v === null) return null;
    const t = typeof v;
    if (t === "string") return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}… (${v.length} chars)` : v;
    if (t === "number" || t === "boolean") return v;
    if (t === "bigint") return String(v);
    if (t === "function" || t === "symbol") return `[${t}]`;
    if (depth > 4) return "[…]";
    if (Array.isArray(v)) {
      const out = v.slice(0, 20).map((x) => safe(x, depth + 1));
      if (v.length > 20) out.push(`… +${v.length - 20} more`);
      return out;
    }
    if (v instanceof Set) return safe([...v], depth);
    if (v instanceof Map) return safe(Object.fromEntries(v), depth);
    const proto = Object.getPrototypeOf(v);
    if (proto && proto !== Object.prototype) {
      const name = v.constructor?.name ?? "Object";
      if (/Deletion/i.test(name)) return "<deleted>";
      if (typeof v.toJSON === "function") {
        try {
          return safe(v.toJSON(), depth + 1);
        } catch {
          /* fall through */
        }
      }
      if (typeof v.toObject === "function") {
        try {
          return safe(v.toObject(), depth + 1);
        } catch {
          /* fall through */
        }
      }
      return `[${name}]`;
    }
    const out = {};
    const entries = Object.entries(v);
    for (const [k, x] of entries.slice(0, 30)) out[k] = safe(x, depth + 1);
    if (entries.length > 30) out["…"] = `+${entries.length - 30} more keys`;
    return out;
  };

  const short = (v) => {
    let s;
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
    if (s === undefined) s = "∅";
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  };

  const shortPath = (p) => p.replace(/^system\./, "");

  const docInfo = (doc) => {
    const parent = doc.parent ?? null;
    return {
      type: doc.documentName,
      subtype: doc.type ?? null,
      uuid: doc.uuid ?? null,
      name: doc.name ?? null,
      parent: parent ? parent.name ?? parent.documentName : null,
      parentUuid: parent?.uuid ?? null,
    };
  };

  const label = (d) => `${d.type}${d.name ? ` "${d.name}"` : ""}${d.parent ? ` on ${d.parent}` : ""}`;

  // ------------------------------------------------ PF2e-aware classifiers

  const PHYSICAL = new Set(["weapon", "armor", "shield", "equipment", "consumable", "treasure", "backpack", "book", "ammo"]);
  const isPhysical = (item) =>
    typeof item?.isOfType === "function" ? item.isOfType("physical") : PHYSICAL.has(item?.type);
  const isCoin = (item) =>
    item?.documentName === "Item" &&
    (item.isCoinage ??
      (item.type === "treasure" && (item.system?.category === "coin" || item.system?.stackGroup === "coins")));

  // Changed fields worth a second look. Tags are descriptive; filtering by user happens in report.sh.
  const PATH_TAGS = [
    [/^system\.attributes\.hp\.(value|temp|max)$/, "hp"],
    [/^system\.details\.xp\.value$/, "xp"],
    [/^system\.details\.level\.value$/, "level"],
    [/^system\.resources\.heroPoints\.value$/, "hero-points"],
    [/^system\.resources\.focus\.value$/, "focus"],
    [/^system\.resources\.(?!heroPoints|focus)/, "resources"],
    [/^system\.build\./, "build"],
    [/^system\.(abilities|skills|saves|proficiencies|martial)\./, "stats"],
    [/^system\.quantity$/, "quantity"],
    [/^system\.(uses|charges)\.value$/, "uses"],
    [/^system\.slots\./, "spell-slots"],
    [/^system\.rules/, "rules"],
    [/^system\.price\./, "price"],
    [/^ownership\b/, "ownership"],
    [/^role$/, "user-role"],
  ];

  const tagsForPaths = (doc, paths) => {
    const tags = new Set();
    for (const p of paths) {
      for (const [re, tag] of PATH_TAGS) if (re.test(p)) tags.add(tag);
      if (p === "system.quantity" && isCoin(doc)) tags.add("coins");
    }
    return [...tags];
  };

  // ------------------------------------- snapshots of player-owned actors
  // Remote updates arrive already applied, so "old" values come from our own copy.

  const snaps = new Map();

  const ownerActor = (doc) => {
    for (let d = doc; d; d = d.parent) if (d.documentName === "Actor") return d;
    return null;
  };
  const isTracked = (actor) =>
    !!actor && actor.documentName === "Actor" && !actor.isToken && !actor.pack && actor.hasPlayerOwner === true;

  const embeddedFields = (doc) => Object.values(doc.constructor?.metadata?.embedded ?? {});
  const embeddedDocs = (actor) => [...(actor.items ?? []), ...(actor.effects ?? [])];

  const remember = (doc) => {
    const src = { ...doc._source };
    for (const k of embeddedFields(doc)) delete src[k];
    snaps.set(doc.uuid, U.deepClone(src));
  };

  const forget = (doc) => {
    snaps.delete(doc.uuid);
    const prefix = `${doc.uuid}.`;
    for (const k of snaps.keys()) if (k.startsWith(prefix)) snaps.delete(k);
  };

  const refresh = (doc) => {
    if (!isTracked(ownerActor(doc))) return forget(doc);
    const known = snaps.has(doc.uuid);
    remember(doc);
    if (doc.documentName === "Actor" && !known) for (const e of embeddedDocs(doc)) remember(e);
  };

  let tracked = 0;
  for (const actor of game.actors ?? []) {
    if (!isTracked(actor)) continue;
    tracked++;
    remember(actor);
    for (const e of embeddedDocs(actor)) remember(e);
  }

  // ------------------------------------------------------------- chat

  const rollInfo = (roll) => {
    try {
      return {
        formula: roll.formula ?? null,
        total: roll.total ?? null,
        dice: (roll.dice ?? []).map(
          (d) => `d${d.faces}:${(d.results ?? []).map((r) => (r.active === false ? `(${r.result})` : r.result)).join(",")}`,
        ),
      };
    } catch {
      return { formula: "?", total: null, dice: [] };
    }
  };

  const chatInfo = (msg) => {
    const authorId = msg.author?.id ?? msg._source?.author ?? msg._source?.user ?? null;
    const ctx = msg.flags?.pf2e?.context ?? null;
    const info = {
      messageId: msg.id ?? null,
      author: game.users.get(authorId)?.name ?? authorId,
      authorId,
      speaker: msg.speaker?.alias ?? null,
      whisper: (msg.whisper ?? []).map((id) => game.users.get(id)?.name ?? id),
      blind: msg.blind === true,
      title: heading(msg.flavor),
      content: plain(msg.content),
      rolls: (msg.rolls ?? []).map(rollInfo),
    };
    if (ctx) info.pf2e = { type: ctx.type ?? null, outcome: ctx.outcome ?? null, dc: ctx.dc?.value ?? null };
    return info;
  };

  const chatText = (c) => {
    const rolls = c.rolls
      .map((r) => `${r.formula} = ${r.total}${r.dice.length ? ` [${r.dice.join(" ")}]` : ""}`)
      .join("; ");
    let s = c.title ? `[${c.title}] ` : "";
    s += rolls || `"${c.content.length > 120 ? `${c.content.slice(0, 120)}…` : c.content}"`;
    if (c.pf2e?.outcome) s += ` → ${c.pf2e.outcome}`;
    if (c.pf2e?.dc != null) s += ` (DC ${c.pf2e.dc})`;
    if (c.whisper.length) s += ` (whisper → ${c.whisper.join(", ")})`;
    if (c.blind) s += " (blind)";
    return s;
  };

  const looksLikeFakeRoll = (msg) =>
    !(msg.rolls?.length > 0) && /class="[^"]*\bdice-(total|roll|formula)\b/.test(String(msg.content ?? ""));

  // --------------------------------------------------------- handlers

  const onCreate = (doc, _options, userId) => {
    const w = who(userId);
    if (doc.documentName === "ChatMessage") {
      const chat = chatInfo(doc);
      const tags = looksLikeFakeRoll(doc) ? ["roll-html-no-roll"] : [];
      emit({ kind: "chat", ...w, chat, tags, summary: `${w.user} chat: ${chatText(chat)}` });
      return;
    }
    const d = docInfo(doc);
    const tags = [];
    const extra = {};
    const onPlayerActor = isTracked(ownerActor(doc)) && doc.documentName !== "Actor";
    if (doc.documentName === "Item") {
      if (doc.system?.quantity !== undefined) extra.quantity = doc.system.quantity;
      if (onPlayerActor && isPhysical(doc)) tags.push("item-create");
      if (onPlayerActor && isCoin(doc)) tags.push("coins");
      const rules = doc.system?.rules;
      if (Array.isArray(rules) && rules.length) extra.ruleElements = rules.length;
    }
    if (doc.documentName === "Macro" && doc.type === "script") {
      tags.push("macro");
      extra.command = safe(doc.command);
    }
    if (doc.documentName === "Actor") tags.push("actor-create");
    const qty = extra.quantity !== undefined ? ` ×${extra.quantity}` : "";
    emit({ kind: "create", ...w, doc: d, ...extra, tags, summary: `${w.user} created ${label(d)}${qty}` });
    refresh(doc);
  };

  const onUpdate = (doc, changed, _options, userId) => {
    const w = who(userId);
    const d = docInfo(doc);
    const before = snaps.get(doc.uuid);
    const flat = U.flattenObject(changed ?? {});
    const all = [];
    for (const [path, to] of Object.entries(flat)) {
      if (ignorePaths.some((p) => path === p || path.startsWith(`${p}.`))) continue;
      const c = { path, to: safe(to) };
      if (before) c.from = safe(U.getProperty(before, path));
      all.push(c);
    }
    refresh(doc);
    if (!all.length) return;

    const tags = tagsForPaths(doc, all.map((c) => c.path));
    const entry = { kind: "update", ...w, doc: d, changes: all.slice(0, MAX_CHANGES), tags };
    if (all.length > MAX_CHANGES) entry.moreChanges = all.length - MAX_CHANGES;

    if (doc.documentName === "ChatMessage") {
      const touched = all.some((c) => /^(content|rolls|flavor)\b/.test(c.path));
      if (touched) {
        entry.chat = chatInfo(doc);
        tags.push("chat-edit");
        entry.summary = `${w.user} EDITED chat message by ${entry.chat.author}: ${chatText(entry.chat)}`;
        emit(entry);
        return;
      }
    }
    if (doc.documentName === "Macro" && doc.type === "script" && all.some((c) => c.path === "command")) tags.push("macro");

    const parts = all
      .slice(0, SUMMARY_CHANGES)
      .map((c) => `${shortPath(c.path)} ${"from" in c ? `${short(c.from)} → ` : "= "}${short(c.to)}`);
    if (all.length > SUMMARY_CHANGES) parts.push(`+${all.length - SUMMARY_CHANGES} more`);
    entry.summary = `${w.user} updated ${label(d)}: ${parts.join("; ")}`;
    emit(entry);
  };

  const onDelete = (doc, _options, userId) => {
    const w = who(userId);
    if (doc.documentName === "ChatMessage") {
      const chat = chatInfo(doc);
      const by = chat.authorId && chat.authorId !== userId ? ` (written by ${chat.author})` : "";
      emit({
        kind: "chat-delete",
        ...w,
        chat,
        tags: ["chat-delete"],
        summary: `${w.user} DELETED chat message${by}: ${chatText(chat)}`,
      });
      return;
    }
    const d = docInfo(doc);
    const tags = [];
    const extra = {};
    const onPlayerActor = isTracked(ownerActor(doc)) && doc.documentName !== "Actor";
    if (doc.documentName === "Item") {
      if (doc.system?.quantity !== undefined) extra.quantity = doc.system.quantity;
      if (onPlayerActor && isPhysical(doc)) tags.push("item-delete");
      if (onPlayerActor && isCoin(doc)) tags.push("coins");
    }
    if (doc.documentName === "Actor") tags.push("actor-delete");
    const qty = extra.quantity !== undefined ? ` ×${extra.quantity}` : "";
    emit({ kind: "delete", ...w, doc: d, ...extra, tags, summary: `${w.user} deleted ${label(d)}${qty}` });
    forget(doc);
  };

  // ----------------------------------------------------- registration

  let types = Array.isArray(CONST.ALL_DOCUMENT_TYPES) ? [...CONST.ALL_DOCUMENT_TYPES] : [];
  if (!types.length) types = Object.keys(CONFIG).filter((k) => CONFIG[k]?.documentClass);
  types = types.filter((t) => !ignoreTypes.has(t));

  for (const name of types) {
    HooksApi.on(`create${name}`, guard(onCreate));
    HooksApi.on(`update${name}`, guard(onUpdate));
    HooksApi.on(`delete${name}`, guard(onDelete));
  }

  HooksApi.on(
    "userConnected",
    guard((user, connected) => {
      emit({
        kind: connected ? "connect" : "disconnect",
        ...who(user.id),
        summary: `${user.name} ${connected ? "connected" : "disconnected"}`,
      });
    }),
  );

  // Requests players send to "the GM" (PF2e item transfers, socketlib executeAsGM, ...).
  const channels = [...new Set([`system.${game.system.id}`, ...(cfg.socketChannels ?? [])])];
  for (const channel of channels) {
    game.socket.on(
      channel,
      guard((...args) => {
        const payload = args[0];
        let senderId = null;
        const last = args.at(-1);
        if (args.length > 1 && typeof last === "string" && game.users.has(last)) senderId = last;
        if (!senderId && payload && typeof payload === "object") {
          for (const k of ["userId", "senderId", "user", "sender"]) {
            const v = payload[k];
            if (typeof v === "string" && game.users.has(v)) {
              senderId = v;
              break;
            }
          }
        }
        const w = who(senderId);
        const request =
          (payload && typeof payload === "object" && (payload.request ?? payload.handlerName ?? payload.action ?? payload.type)) ||
          null;
        emit({
          kind: "socket",
          ...w,
          channel,
          request: safe(request),
          payload: safe(payload),
          summary: `${w.user} → ${channel}${request ? ` ${request}` : ""}`,
        });
      }),
    );
  }

  globalThis.__gmActionLogger = { version: 1, snaps, types, channels };

  const online = game.users.filter((u) => u.active).map((u) => u.name);
  emit({
    kind: "logger-start",
    ...who(selfId),
    foundry: game.version ?? null,
    system: `${game.system.id} ${game.system.version}`,
    online,
    trackedActors: tracked,
    summary: `logger started in "${world}" — online: ${online.join(", ") || "nobody"}; tracking ${tracked} player-owned actors`,
  });

  return `installed (${types.length} document types, ${tracked} player-owned actors tracked, sockets: ${channels.join(", ")})`;
}
