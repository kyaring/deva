# Deva Headless

**An AI agent service without a GUI.** It runs as a resident service on a server, chats through Telegram or Feishu, and is managed entirely from the command line.

- Single-file deployment: compiled to a native binary with the runtime embedded. The target machine needs no Node.js, Electron or virtual display.
- About 70 MB resident memory (bun 1.4.4, measured).
- Data, keys and configuration all live in one data directory. Backup and migration only require that directory plus the master key.

[简体中文](README.md)

---

## Features

**Chat and tools**
- Conversations can be continued (`ask --session`) and run as background jobs (`ask --background`) with progress checks and cancellation.
- The agent reads and writes files and runs commands inside a mounted workspace. Cancelling aborts the model turn and ends the commands it started.
- MCP servers over HTTP, SSE or stdio. Sensitive header values are stored as encrypted references.
- Model providers: Anthropic, OpenAI, the OpenAI Responses protocol, and any service compatible with the OpenAI API.

**Remote channels**
- Telegram: the owner claims the bot by scanning a QR code; others are invited with `/pair` and can be removed at any time. Verified end to end on a server.
- Feishu: integrated, not yet fully verified in a headless environment.

**Operations**
- `doctor` checks that keys decrypt, MCP servers connect, bot tokens are valid, the model is reachable and the workspace exists.
- Admin commands take effect immediately while the service runs (through a local control socket); when it is stopped they write files directly.
- HTTP, HTTPS and SOCKS5 proxies are supported. `NO_PROXY` excludes local and internal addresses.

**Security**
- API keys, bot tokens and MCP tokens are encrypted with AES-256-GCM. The master key lives only in an environment file.
- Keys are read from standard input only and never appear in command-line arguments or logs.
- Sensitive headers (names containing auth, token, key, secret, etc.) cannot be stored in plaintext and must reference the encrypted store.

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm --filter @deva/desktop build:headless:bun                 # builds apps/desktop/out/headless/deva-headless
sudo install -m 0755 apps/desktop/out/headless/deva-headless /usr/local/bin/deva-headless

sudo deva-headless setup        # choose a provider → enter the API key (not echoed) → choose a model
sudo deva-headless doctor       # verify the setup end to end
sudo deva-headless ask "Introduce yourself in one sentence"
```

For production (dedicated user, systemd autostart, master key handling) see [deploy/README.md](deploy/README.md).

## Models

A provider (for example the upstream `gitllc`) can offer several models. There is one default model, and each conversation can pin its own.

```bash
# List the models the upstream offers (the API key must be set)
sudo deva-headless provider models gitllc

# Add models one at a time, or add all upstream models at once
sudo deva-headless provider model add gitllc glm-5.3
sudo deva-headless provider model add gitllc --all

# Switch the default model (used by new conversations and Telegram chats)
sudo deva-headless provider use gitllc:glm-5.3

# Pin one conversation to a model (continuing it with --session keeps that model)
sudo deva-headless ask --session <conversation-id> --model gitllc:gemini-4-argon "<text>"

sudo deva-headless provider list           # all providers and models; * marks the default's provider
```

Rules:
- New conversations do not pin a model; they follow the default. A conversation pinned with `--model` keeps its model.
- Every `ask` prints `[模型] provider:model` to stderr, so you can see which model was used.
- `provider` commands edit the config file directly, so **restart the service afterwards**: `sudo systemctl restart deva-headless`.

## Telegram commands

In a private chat with the bot:

| Command | Description |
| --- | --- |
| `/new [persona]` `/list` `/use <n>` | Create, list and switch conversations |
| `/models` | List all providers and models (★ default, ▶ this conversation) |
| `/model <provider:model>` | Switch the model for this conversation |
| `/model default <provider:model>` | Set the default model (new conversations use it immediately) |
| `/model reset` | Make this conversation follow the default model again |
| `/model add <provider> <model-id>` | Add a model (`--all` adds every model the provider offers) |
| `/model remove <provider> <model-id>` | Remove a model (replace the default model first) |
| `/stop` `/status` `/help` | Stop a reply, show the current conversation, help |

Only paired users can use these commands.

## Commands

| Command | Description |
| --- | --- |
| `setup` | Interactive wizard: provider, API key, model |
| `provider list \| add \| remove \| models \| model add \| model remove \| use` | Manage providers and models |
| `set-key <provider-id>` | Save a provider's API key (read from stdin) |
| `secret list \| set <name> \| delete <name>` | Manage encrypted secrets |
| `mcp list \| add \| enable \| disable \| test \| remove` | Manage MCP servers; `--header Name=@secret` references an encrypted secret |
| `telegram-add` | Add a Telegram bot and claim the owner |
| `remote bots \| users \| pair-code \| pair-cancel \| remove-user` | Manage bots and paired users |
| `ask [--session <ID>] [--background] [--timeout <sec>] <text>` | Chat; `--session` continues, `--background` runs as a job |
| `job list \| status \| log \| cancel` | Manage background jobs |
| `workspace show \| set <path> \| unset` | Default workspace for new conversations |
| `serve` | Run the service (usually under systemd; one instance per data directory) |
| `status` | Show the data directory, secret backend, providers and bots |
| `doctor` | Verify the whole setup |

## Data directory

Defaults to `~/.deva`, set with the `DEVA_HOME` environment variable (`/var/lib/deva` in production).

```
config.json          providers, models, default workspace, bots (non-sensitive)
mcp.json             MCP server definitions (sensitive values are references)
secrets.json         encrypted secrets
data/                conversations, personas, skills
jobs/                background job records and output
workspace/projects/  development projects
workspace/scratch/   temporary files and test artifacts
control.sock         local control socket of the service (mode 0600)
```

The master key comes from `DEVA_MASTER_KEY` (32 bytes, base64) or from a `master.key` file in the data directory with mode 0600. If the master key is lost, the stored secrets cannot be decrypted. Back it up.

## Security notes

- `run_command` and the file tools have no command allowlist. They run with the privileges of the service user, so use a dedicated low-privilege user, not root.
- The Telegram bot accepts only its claimed owner and people the owner invites. Set bot tokens and model keys in a terminal, never in a chat.
- If a key or token has ever appeared in a chat transcript or a log, rotate it on the provider's side immediately.

## Known limitations

- Images are not resized; images above the size limit are rejected.
- The compiled single binary is about 123 MB because it embeds the bun runtime.
- Scheduled tasks and remote channels run only while `serve` is running.
- No GUI, so desktop-only features such as the terminal panel are not available.

## Development

- The service layer and headless entry point live in `apps/desktop/src/main/headless/` (startup in `boot.ts`, commands in `*-cli.ts`, Electron replacement in `electron-shim.ts`).
- Build scripts: `pnpm --filter @deva/desktop build:headless` (a bundle that runs on Node) and `build:headless:bun` (the single binary).
- Type check: `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.node.json`.

## License

[MIT](LICENSE)
