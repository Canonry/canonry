# canonry-setup skill

An [OpenClaw](https://openclaw.ai) agent skill that walks a non-technical user through installing, configuring, and running their first AEO visibility sweep with canonry — entirely through chat, with no web UI required.

## What it does

When triggered, the agent will:

1. Check for Node.js and install canonry via npm if needed
2. Run `canonry init` to set up the local config and database
3. Ask for one AI provider key (Gemini, OpenAI, or Claude) and configure it
4. Ask for a domain and create a project
5. Auto-generate key phrases using AI, or accept a manual list
6. Optionally add competitor domains to track
7. Trigger the first visibility sweep and stream results back in chat
8. Offer to set up a daily schedule and webhook alerts

The user never needs to open a terminal or a browser.

## Install

### Via OpenClaw CLI

```bash
openclaw skill install https://github.com/AINYC/canonry/tree/main/skills/canonry-setup
```

### Manual

Copy `SKILL.md` into your OpenClaw skills directory:

```bash
cp SKILL.md ~/.openclaw/skills/canonry-setup/SKILL.md
```

## Usage

Once installed, trigger it in any OpenClaw session:

> "Set up canonry for me"
> "Help me install canonry and run a visibility check on my site"
> "I want to monitor my AEO citations — can you set that up?"

The agent reads `SKILL.md` and runs the full setup flow conversationally.

## Requirements

- [OpenClaw](https://openclaw.ai) with `exec` tool access enabled
- Node.js ≥ 18 on the target machine (the agent will guide installation if missing)
- At least one API key: [Gemini](https://aistudio.google.com/app/apikey), [OpenAI](https://platform.openai.com/api-keys), or [Claude](https://console.anthropic.com/settings/keys)
