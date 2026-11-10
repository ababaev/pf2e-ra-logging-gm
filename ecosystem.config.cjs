// pm2 config for the headless GM.  Start with:  pm2 start ecosystem.config.cjs && pm2 save
// Register it under the same Linux user (same pm2 daemon) that runs the "foundry" pm2 app.
module.exports = {
  apps: [
    {
      name: "foundry-gm",
      script: "gm-bot.mjs",
      cwd: __dirname,
      interpreter: "node",
      autorestart: true,
      exp_backoff_restart_delay: 5000,
      kill_timeout: 10000,
      env: {
        // Talk to Foundry directly on the server, not through nginx/the public URL.
        // Add the routePrefix if you use one, e.g. "http://127.0.0.1:30000/foundry".
        // If Foundry itself serves HTTPS (sslCert in options.json), use https://.
        FOUNDRY_URL: "http://127.0.0.1:30000",

        // Must exist in EVERY world the daily script can load, same name + password.
        GM_USER: "Server GM",
        GM_PASSWORD_FILE: "/home/foundry/.config/foundry-gm/password",

        // true  = no canvas: low CPU; fine for inventory/sheets/chat/item transfers.
        // false = render the scene with software WebGL at 10 fps (costs CPU); only if
        //         some GM-side automation you rely on needs the canvas.
        NO_CANVAS: "true",

        LOG_ACTIONS: "true",
        LOG_DIR: "logs",
        LOG_RETENTION_DAYS: "90",

        // Timestamps in the action log use this zone.
        TZ: "Europe/Berlin",

        // Extra socket channels to record besides "system.<system id>", comma-separated.
        SOCKET_CHANNELS: "module.socketlib",

        // Print Foundry browser console errors into `pm2 logs foundry-gm` (debugging).
        LOG_BROWSER_ERRORS: "false",
      },
    },
  ],
};
