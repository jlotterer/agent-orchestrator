# Secure remote access

By default, orch listens only on `127.0.0.1`, so only the server itself can reach the dashboard. To use orch from your laptop or phone, make it listen on a network address and protect it with an access token.

> [!WARNING]
> Anyone who can reach orch's port can start agents that run commands on your server. Always set an access token before you open orch to a network. orch has no HTTPS of its own, so the token crosses the network in plain text. Reach orch over SSH, Tailscale, a private network, or an HTTPS reverse proxy, and never expose port 4800 to the internet.

## Set an access token

1. Generate a random token:

   ```bash
   openssl rand -hex 32
   ```

2. Make the token available to orch in one of these ways:
   - Set the `ORCH_TOKEN` environment variable for the orch process, for example in the systemd unit or the Docker `.env` file. This is the safer option, because the token stays out of files in the data directory.
   - Or set `auth.token` in `~/.orch/server.json`:

     ```json
     "auth": { "token": "<token>" }
     ```

   If both are set, `ORCH_TOKEN` wins.

3. Restart orch.

With a token set:

- Every API call and the live update stream need the token. Requests without it get `401 {"error":"unauthorized"}`, with no detail about why.
- The dashboard asks for the token once per browser and remembers it in a cookie.
- The `orch` command sends the token from `ORCH_TOKEN`, or from `~/.orch/server.json` when it can read that file.
- Agents get the token automatically, so `orch decide` and `orch ask` keep working inside tasks.

orch never writes the token to its database, its logs or agent prompts.

## Listen on a network address

1. In `~/.orch/server.json`, set `host` to `0.0.0.0` for every network interface, or to one interface's address:

   ```json
   "host": "0.0.0.0",
   "port": 4800
   ```

2. Set `publicUrl` to the address you use to reach orch. Notifications link to it:

   ```json
   "publicUrl": "http://my-server:4800"
   ```

3. Make sure an access token is set, and then restart orch.

If `host` isn't `127.0.0.1`, `::1` or `localhost` and no token is set, orch refuses to start:

```text
error: refusing to listen on 0.0.0.0 without an access token: anyone who can reach this port could control agents.
Set auth.token (or the ORCH_TOKEN environment variable), or set auth.allowInsecure: true to accept the risk, or bind to 127.0.0.1.
```

To turn this check off, set `"auth": { "allowInsecure": true }`. Do that only when another layer, such as a reverse proxy with its own sign-in, protects orch.

## Sign in to the dashboard

1. In a browser, go to orch's address, for example `http://my-server:4800`.
2. In the **Sign in to orch** dialog, enter the access token.
3. Select **Sign in**.

The browser remembers the token for a year. If the token changes, the dialog appears again.

## Use the command line from another terminal

On the server, `orch` reads the token from `~/.orch/server.json` if it's there. If you keep the token in `ORCH_TOKEN` instead, set it in your terminal too:

```bash
export ORCH_TOKEN=<token>
orch status
```

To reach an orch server at another address, also set `ORCH_URL`, for example `export ORCH_URL=http://my-server:4800`.

## Monitor orch with the health check

The health check stays open without a token, so monitoring tools and the Docker health check can use it:

```bash
curl http://my-server:4800/api/health
```

It answers `{"ok":true,"version":"<version>","uptimeSec":<seconds>}`.

## Limit what agents can do

The token keeps strangers out, but agents still run with your user's permissions inside their working copy. To reduce the risk:

- Run orch as a non-root user with access only to what it needs. The Docker image runs as user ID 1000.
- Keep secrets out of `git.copyFiles` unless the tests need them.
- Restrict Claude Code's tools with `--allowedTools`. See [Choose agents and models](configure-agents.md#change-the-program-path-arguments-or-time-limit).
- Use the `manual` merge policy for risky tasks. See [Choose how tasks merge](choose-merge-mode.md#set-the-merge-policy).
