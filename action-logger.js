/*
 * Browser-side inventory logger for the headless Foundry GM.
 *
 * gm-bot.mjs injects this function into the GM's Foundry page once the game is
 * ready. It only OBSERVES: it registers hooks and socket listeners and never
 * modifies any document. Every observation is passed to window.__gmLog(entry),
 * a Playwright binding that appends one JSON line to logs/actions-YYYY-MM-DD.jsonl.
 *
 * What it records: physical items (including coins) being created, deleted, or
 * having their quantity changed, anywhere in the world; plus requests players
 * send to the GM over sockets, which explain GM-relayed item transfers.
 *
 * Keep this file a single function declaration: gm-bot.mjs evaluates it as
 * `(<this file>)(config)`.
 */
function installActionLogger(cfg) {
  if (globalThis.__gmActionLogger) return "already installed";
  const sink = globalThis.__gmLog;
  if (typeof sink !== "function") return "not installed: __gmLog binding missing";

  const HooksApi = globalThis.foundry?.helpers?.Hooks ?? globalThis.Hooks;
  const MAX_STR = Number(cfg.maxString) || 300;
  const MAX_ITEMS_LISTED = 20;
  const selfId = game.user.id;
  const world = game.world.id;

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
    item?.documentName === "Item" &&
    (typeof item.isOfType === "function" ? item.isOfType("physical") : PHYSICAL.has(item.type));
  const isCoin = (item) =>
    item?.documentName === "Item" &&
    (item.isCoinage ??
      (item.type === "treasure" && (item.system?.category === "coin" || item.system?.stackGroup === "coins")));

  const itemTags = (item, tag) => (isCoin(item) ? [tag, "coins"] : [tag]);

  // Players and the GM both use items: tag what happened on player-owned actors.
  const ownerActor = (doc) => {
    for (let d = doc; d; d = d.parent) if (d.documentName === "Actor") return d;
    return null;
  };
  const onPlayerActor = (item) => ownerActor(item)?.hasPlayerOwner === true;

  // ------------------------------------------------- quantity snapshots
  // Remote updates arrive already applied, so the old quantity comes from our own copy.

  const qty = new Map();

  const remember = (item) => {
    if (isPhysical(item) && !item.pack) qty.set(item.uuid, item.system?.quantity ?? null);
  };

  const forget = (doc) => {
    qty.delete(doc.uuid);
    const prefix = `${doc.uuid}.`;
    for (const k of qty.keys()) if (k.startsWith(prefix)) qty.delete(k);
  };

  const rememberActor = (actor) => {
    for (const item of actor?.items ?? []) remember(item);
  };

  for (const item of game.items ?? []) remember(item);
  for (const actor of game.actors ?? []) rememberActor(actor);
  // Unlinked tokens (loot piles, NPCs) carry their own copies of items.
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token.actorLink) continue;
      try {
        rememberActor(token.actor);
      } catch {
        /* token without a valid base actor */
      }
    }
  }

  // --------------------------------------------------------- handlers

  const onCreateItem = (item, _options, userId) => {
    if (!isPhysical(item) || item.pack) return;
    remember(item);
    const w = who(userId);
    const d = docInfo(item);
    const quantity = item.system?.quantity ?? null;
    emit({
      kind: "create",
      ...w,
      doc: d,
      quantity,
      playerOwned: onPlayerActor(item),
      tags: itemTags(item, "item-create"),
      summary: `${w.user} created ${label(d)} ×${quantity}`,
    });
  };

  const onUpdateItem = (item, changed, _options, userId) => {
    if (!isPhysical(item) || item.pack) return;
    const had = qty.has(item.uuid);
    const from = qty.get(item.uuid);
    remember(item);
    if (foundry.utils.getProperty(changed ?? {}, "system.quantity") === undefined) return;
    const to = item.system?.quantity ?? null;
    if (had && from === to) return;

    const w = who(userId);
    const d = docInfo(item);
    const entry = { kind: "update", ...w, doc: d, quantity: { to }, playerOwned: onPlayerActor(item) };
    let change = `= ${to}`;
    if (had) {
      entry.quantity.from = from;
      change = `${from} → ${to}`;
      if (typeof from === "number" && typeof to === "number") {
        entry.quantity.delta = to - from;
        change += ` (${to >= from ? "+" : ""}${to - from})`;
      }
    }
    emit({ ...entry, tags: itemTags(item, "quantity"), summary: `${w.user} changed ${label(d)}: quantity ${change}` });
  };

  const onDeleteItem = (item, _options, userId) => {
    if (!isPhysical(item) || item.pack) return;
    forget(item);
    const w = who(userId);
    const d = docInfo(item);
    const quantity = item.system?.quantity ?? null;
    emit({
      kind: "delete",
      ...w,
      doc: d,
      quantity,
      playerOwned: onPlayerActor(item),
      tags: itemTags(item, "item-delete"),
      summary: `${w.user} deleted ${label(d)} ×${quantity}`,
    });
  };

  // Items that come with a new actor (imported NPC, Item Piles loot pile) fire no createItem hook.
  const onCreateActor = (actor, _options, userId) => {
    if (actor.pack) return;
    rememberActor(actor);
    const items = [...(actor.items ?? [])].filter(isPhysical);
    if (!items.length) return;
    const w = who(userId);
    const d = docInfo(actor);
    const list = items.map((i) => ({ name: i.name, uuid: i.uuid, quantity: i.system?.quantity ?? null, coin: !!isCoin(i) }));
    const shown = list.slice(0, MAX_ITEMS_LISTED).map((i) => `${i.name} ×${i.quantity}`);
    if (list.length > MAX_ITEMS_LISTED) shown.push(`+${list.length - MAX_ITEMS_LISTED} more`);
    emit({
      kind: "create",
      ...w,
      doc: d,
      items: list,
      playerOwned: actor.hasPlayerOwner === true,
      tags: items.some(isCoin) ? ["item-create", "coins"] : ["item-create"],
      summary: `${w.user} created ${label(d)} with items: ${shown.join(", ")}`,
    });
  };

  // ----------------------------------------------------- registration

  HooksApi.on("createItem", guard(onCreateItem));
  HooksApi.on("updateItem", guard(onUpdateItem));
  HooksApi.on("deleteItem", guard(onDeleteItem));
  HooksApi.on("createActor", guard(onCreateActor));
  HooksApi.on("deleteActor", guard((actor) => forget(actor)));
  HooksApi.on(
    "createToken",
    guard((token) => {
      if (!token.actorLink) rememberActor(token.actor);
    }),
  );
  HooksApi.on("deleteToken", guard((token) => forget(token)));

  // Requests players send to "the GM" (PF2e item transfers, socketlib executeAsGM, ...).
  // A GM client carries the transfer out, so this line is what shows who asked for it.
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

  globalThis.__gmActionLogger = { version: 2, qty, channels };

  const online = game.users.filter((u) => u.active).map((u) => u.name);
  emit({
    kind: "logger-start",
    ...who(selfId),
    foundry: game.version ?? null,
    system: `${game.system.id} ${game.system.version}`,
    online,
    trackedItems: qty.size,
    summary: `logger started in "${world}" — online: ${online.join(", ") || "nobody"}; tracking ${qty.size} items`,
  });

  return `installed (${qty.size} items tracked, sockets: ${channels.join(", ")})`;
}
